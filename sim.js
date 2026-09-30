/* Epidemic Breakers — pure simulation/optimization core (no DOM).
 * Faithful JS port of src/simulator.py, src/fitness.py, src/ga.py.
 * Works in browsers and in node (module.exports guard at the bottom). */
"use strict";

/* ---------------- seeded RNG ---------------- */

function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0) * 4294967296 + (h1 >>> 0);
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class RNG {
  constructor(seed) { this.f = mulberry32(seed >>> 0); this.spare = null; }
  next() { return this.f(); }
  int(n) { return (this.next() * n) | 0; }
  range(lo, hi) { return lo + this.next() * (hi - lo); }
  normal(sigma = 1) {
    if (this.spare !== null) { const v = this.spare * sigma; this.spare = null; return v; }
    let u = 0, v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    const mag = Math.sqrt(-2 * Math.log(u));
    this.spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v) * sigma;
  }
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}

function makeSeeds(n, base) {
  const rng = new RNG(cyrb53("seeds:" + base));
  const out = [];
  for (let i = 0; i < n; i++) out.push((rng.next() * 2147483647) | 0);
  return out;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------------- graph ---------------- */

/** Build the service graph object from exported data: {n, edges:[[u,v],...]} */
function loadGraph(data) {
  return { n: data.n, edges: data.edges.map(e => [e[0], e[1]]) };
}

/** Deterministic per-edge noise/spread params (for non-default environments). */
function perEdgeParams(edges, noiseAmp, spreadP) {
  const key = JSON.stringify(edges.map(e => e.slice()).sort((a, b) => a[0] - b[0] || a[1] - b[1]));
  const rng = new RNG(cyrb53(key));
  const m = edges.length;
  const noise = new Float64Array(m), p = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    noise[i] = noiseAmp * (0.2 + 0.8 * rng.next());
    p[i] = clamp(spreadP * (0.3 + 1.4 * rng.next()), 0.01, 0.95);
  }
  return { noise, p };
}

/* ---------------- cascade simulator (port of _run) ---------------- */

function simulate(graph, params, theta, seed, o = {}) {
  const { cooldown = 5, nSteps = 40, emaAlpha = 0.3, recordHistory = false, recordDetail = false } = o;
  const n = graph.n, edges = graph.edges, m = edges.length;
  const rng = new RNG(seed >>> 0);

  const eu = new Int32Array(m), ev = new Int32Array(m);
  for (let i = 0; i < m; i++) { eu[i] = edges[i][0]; ev[i] = edges[i][1]; }
  const th = Float64Array.from(theta);
  const noise = params.noise, pr = params.p;

  const slow = new Uint8Array(n);
  slow[(rng.next() * n) | 0] = 1;               // inject the initial failure
  const ema = new Float64Array(m);
  const timer = new Int32Array(m);
  let falseTrips = 0, openEdgeSteps = 0;
  const hist = [];
  const nodeHist = [], openHist = [];           // per-step snapshots (no RNG use)

  for (let step = 0; step < nSteps; step++) {
    // 1. spread along closed edges: callers of slow callees (snapshot semantics)
    const was = slow.slice();
    for (let i = 0; i < m; i++) {
      if (timer[i] === 0 && was[ev[i]] === 1 && slow[eu[i]] === 0 && rng.next() < pr[i]) {
        slow[eu[i]] = 1;
      }
    }
    // 2-3. stress EMA -> noisy observation -> trips
    for (let i = 0; i < m; i++) {
      const stress = slow[ev[i]] ? 1 : 0;
      ema[i] = (1 - emaAlpha) * ema[i] + emaAlpha * stress;
      if (timer[i] === 0) {
        const observed = ema[i] + (rng.next() * 2 - 1) * noise[i];
        if (observed > th[i]) {
          if (slow[ev[i]] === 0) falseTrips++;  // breaker fired on a healthy callee
          timer[i] = cooldown;
        }
      }
    }
    // 4. account open time, tick timers down
    for (let i = 0; i < m; i++) if (timer[i] > 0) { openEdgeSteps++; timer[i]--; }
    if (recordHistory) { let s = 0; for (let i = 0; i < n; i++) s += slow[i]; hist.push(s); }
    if (recordDetail) {
      // snapshot end-of-step state; reads existing arrays only, no RNG draws
      nodeHist.push(Array.from(slow));
      const oh = new Array(m);
      for (let i = 0; i < m; i++) oh[i] = timer[i] > 0 ? 1 : 0;
      openHist.push(oh);
    }
  }

  let cascadeSize = 0; for (let i = 0; i < n; i++) cascadeSize += slow[i];
  const out = {
    cascadeSize,
    falseTrips,
    latencyPenalty: 100 * openEdgeSteps / Math.max(1, m * nSteps),
    nSteps, nEdges: m,
  };
  if (recordHistory) out.slowHistory = hist;
  if (recordDetail) { out.nodeHistory = nodeHist; out.openHistory = openHist; }
  return out;
}

/* ---------------- fitness ---------------- */

function scenarioCost(m) {
  return m.cascadeSize + 2 * m.falseTrips + 0.1 * m.latencyPenalty;
}

function evaluate(graph, params, theta, seeds, simOpts = {}) {
  let F = 0, casc = 0, ft = 0, lat = 0;
  for (const s of seeds) {
    const m = simulate(graph, params, theta, s, simOpts);
    F += scenarioCost(m); casc += m.cascadeSize; ft += m.falseTrips; lat += m.latencyPenalty;
  }
  const k = seeds.length;
  return { F: F / k, cascadeSize: casc / k, falseTrips: ft / k, latencyPenalty: lat / k };
}

/* ---------------- edge betweenness (Brandes, directed, unweighted) ---------------- */

function edgeBetweenness(n, edges) {
  const adj = Array.from({ length: n }, () => []);
  edges.forEach(([u, v], i) => adj[u].push([v, i]));
  const bet = new Float64Array(edges.length);
  for (let s = 0; s < n; s++) {
    const stack = [];
    const pred = Array.from({ length: n }, () => []);
    const predE = Array.from({ length: n }, () => []);
    const sigma = new Float64Array(n); sigma[s] = 1;
    const dist = new Int32Array(n).fill(-1); dist[s] = 0;
    const q = [s];
    while (q.length) {
      const v = q.shift(); stack.push(v);
      for (const [w, ei] of adj[v]) {
        if (dist[w] < 0) { q.push(w); dist[w] = dist[v] + 1; }
        if (dist[w] === dist[v] + 1) { sigma[w] += sigma[v]; pred[w].push(v); predE[w].push(ei); }
      }
    }
    const delta = new Float64Array(n);
    while (stack.length) {
      const w = stack.pop();
      for (let k = 0; k < pred[w].length; k++) {
        const v = pred[w][k], ei = predE[w][k];
        const c = (sigma[v] / sigma[w]) * (1 + delta[w]);
        bet[ei] += c; delta[v] += c;
      }
    }
  }
  return bet;
}

/** 50/50 blend of normalized betweenness and uniform (port of edge_weights). */
function guidedWeights(graph) {
  const m = graph.edges.length;
  const bet = edgeBetweenness(graph.n, graph.edges);
  const sum = bet.reduce((a, b) => a + b, 0);
  const w = new Float64Array(m), u = 1 / m;
  for (let i = 0; i < m; i++) w[i] = 0.5 * (sum > 0 ? bet[i] / sum : u) + 0.5 * u;
  return w;
}

/* ---------------- mini GA (port of run_ga, small budgets for the browser) ---------------- */

function sampleWeighted(rng, weights, k, forbid) {
  // k distinct indices, probability proportional to weights, skipping `forbid`
  const idx = [];
  const avail = [];
  for (let i = 0; i < weights.length; i++) if (!forbid.has(i)) avail.push(i);
  for (let t = 0; t < k && avail.length; t++) {
    let total = 0; for (const i of avail) total += weights[i];
    let r = rng.next() * total, pick = avail[avail.length - 1];
    for (let j = 0; j < avail.length; j++) { r -= weights[avail[j]]; if (r <= 0) { pick = avail[j]; break; } }
    idx.push(pick); avail.splice(avail.indexOf(pick), 1);
  }
  return idx;
}

function binomial(rng, n, p) {
  let k = 0; for (let i = 0; i < n; i++) if (rng.next() < p) k++;
  return k;
}

/**
 * Genetic algorithm over threshold vectors. Async (yields between generations
 * so the UI stays alive). Returns {best, bestF, history}.
 */
async function runGA(graph, params, trainSeeds, o = {}, onGen = null) {
  const { popSize = 12, generations = 12, seed = 42, guided = true,
          mutRate = 0.05, mutSigma = 0.08, initLo = 0.2, initHi = 0.7,
          simOpts = {} } = o;
  const m = graph.edges.length;
  const rng = new RNG(seed >>> 0);
  const weights = guided ? guidedWeights(graph) : null;

  const fit = (th) => evaluate(graph, params, th, trainSeeds, simOpts).F;
  let pop = [];
  for (let i = 0; i < popSize; i++) {
    const ind = new Float64Array(m);
    for (let j = 0; j < m; j++) ind[j] = rng.range(initLo, initHi);
    pop.push(ind);
  }
  const mutate = (ind) => {
    const child = Float64Array.from(ind);
    let idx;
    if (guided) {
      const k = binomial(rng, m, mutRate);
      idx = sampleWeighted(rng, weights, Math.min(Math.max(k, 1), m), new Set());
    } else {
      idx = []; for (let j = 0; j < m; j++) if (rng.next() < mutRate) idx.push(j);
    }
    for (const j of idx) child[j] = clamp(child[j] + rng.normal(mutSigma), 0, 1);
    return child;
  };
  const crossover = (a, b) => {
    const c = new Float64Array(m);
    for (let j = 0; j < m; j++) c[j] = rng.next() < 0.5 ? a[j] : b[j];
    return c;
  };
  const tournament = (fits) => {
    let bi = rng.int(popSize);
    for (let k = 1; k < 3; k++) { const i = rng.int(popSize); if (fits[i] < fits[bi]) bi = i; }
    return bi;
  };

  let fits = pop.map(fit);
  let bi = fits.indexOf(Math.min(...fits));
  let best = pop[bi], bestF = fits[bi];
  const history = [bestF];

  for (let g = 0; g < generations; g++) {
    const order = fits.map((f, i) => i).sort((a, b) => fits[a] - fits[b]);
    const next = [pop[order[0]], pop[order[1]]];           // elitism = 2
    while (next.length < popSize) {
      const p1 = pop[tournament(fits)], p2 = pop[tournament(fits)];
      next.push(mutate(rng.next() < 0.9 ? crossover(p1, p2) : Float64Array.from(p1)));
    }
    pop = next; fits = pop.map(fit);
    bi = fits.indexOf(Math.min(...fits));
    if (fits[bi] < bestF) { bestF = fits[bi]; best = pop[bi]; }
    history.push(bestF);
    if (onGen) onGen(g + 1, generations, bestF);
    await new Promise(r => setTimeout(r, 0));               // let the UI breathe
  }
  return { best: Array.from(best), bestF, history };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    RNG, cyrb53, makeSeeds, clamp, loadGraph, perEdgeParams,
    simulate, scenarioCost, evaluate, edgeBetweenness, guidedWeights, runGA,
  };
}
