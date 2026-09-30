/* Epidemic Breakers website UI. Depends on sim.js (loaded first). */
"use strict";

const $ = (id) => document.getElementById(id);
const state = { graph: null, baseParams: null, bestTheta: null, liveTheta: null, ready: false };

/* ---------- canvas helpers (HiDPI aware) ---------- */
function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = parseInt(cv.getAttribute("height"), 10);
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [ctx, w, h];
}

function drawLineChart(cv, series, colors) {
  const [ctx, W, H] = fitCanvas(cv);
  const padL = 44, padR = 12, padT = 12, padB = 30;
  const iw = W - padL - padR, ih = H - padT - padB;
  ctx.clearRect(0, 0, W, H);
  let ymin = Infinity, ymax = -Infinity, xmax = 1;
  for (const s of series) for (let i = 0; i < s.data.length; i++) {
    ymin = Math.min(ymin, s.data[i]); ymax = Math.max(ymax, s.data[i]); xmax = Math.max(xmax, i);
  }
  if (ymax - ymin < 1e-9) { ymax = ymin + 1; }
  const pad = (ymax - ymin) * 0.08; ymin -= pad; ymax += pad;
  const X = (i) => padL + (i / xmax) * iw;
  const Y = (v) => padT + ih - ((v - ymin) / (ymax - ymin)) * ih;
  ctx.strokeStyle = "#e2e8f0"; ctx.fillStyle = "#64748b";
  ctx.font = "11px sans-serif"; ctx.textAlign = "right";
  for (let g = 0; g <= 4; g++) {
    const v = ymin + ((ymax - ymin) * g) / 4, y = Y(v);
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + iw, y); ctx.stroke();
    ctx.fillText(v.toFixed(1), padL - 6, y + 4);
  }
  series.forEach((s, si) => {
    ctx.strokeStyle = colors[si % colors.length]; ctx.lineWidth = 2;
    ctx.beginPath();
    s.data.forEach((v, i) => { const x = X(i), y = Y(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
    // legend
    const lx = padL + 10 + si * 170;
    ctx.fillStyle = colors[si % colors.length]; ctx.fillRect(lx, 14, 12, 12);
    ctx.fillStyle = "#1a2332"; ctx.textAlign = "left"; ctx.fillText(s.label, lx + 18, 24);
  });
  ctx.fillStyle = "#64748b"; ctx.textAlign = "center";
  ctx.fillText("simulation step →", padL + iw / 2, H - 8);
  ctx.save(); ctx.translate(12, padT + ih / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText("slow services", 0, 0); ctx.restore();
}

function drawBarChart(cv, items) {
  const [ctx, W, H] = fitCanvas(cv);
  const padL = 44, padR = 12, padT = 12, padB = 44;
  const iw = W - padL - padR, ih = H - padT - padB;
  ctx.clearRect(0, 0, W, H);
  const maxV = Math.max(...items.map(d => d.value)) * 1.15 || 1;
  const bw = Math.min(120, (iw / items.length) * 0.55);
  const colors = ["#2563eb", "#16a34a", "#9333ea", "#ea580c"];
  ctx.font = "11px sans-serif";
  items.forEach((d, i) => {
    const cx = padL + (iw * (i + 0.5)) / items.length;
    const bh = (d.value / maxV) * ih;
    ctx.fillStyle = colors[i % colors.length];
    ctx.fillRect(cx - bw / 2, padT + ih - bh, bw, bh);
    ctx.fillStyle = "#1a2332"; ctx.textAlign = "center";
    ctx.fillText(d.value.toFixed(2), cx, padT + ih - bh - 6);
    ctx.fillStyle = "#475569";
    const words = d.label.split(" ");
    words.forEach((w, k) => ctx.fillText(w, cx, padT + ih + 16 + k * 13));
  });
  ctx.strokeStyle = "#94a3b8";
  ctx.beginPath(); ctx.moveTo(padL, padT + ih); ctx.lineTo(padL + iw, padT + ih); ctx.stroke();
  ctx.fillStyle = "#64748b"; ctx.textAlign = "right";
  ctx.fillText(maxV.toFixed(1), padL - 6, padT + 10);
}

/* ---------- environment / strategies ---------- */
function readControls() {
  return {
    seed: parseInt($("seed").value, 10) || 0,
    spreadP: parseFloat($("spreadP").value),
    cooldown: parseInt($("cooldown").value, 10),
    noiseAmp: parseFloat($("noise").value),
    nSteps: parseInt($("steps").value, 10),
    fixedTheta: parseFloat($("theta").value),
    strategy: document.querySelector('input[name="strategy"]:checked').value,
  };
}

function currentParams(ctrl) {
  const { spreadP, noiseAmp } = ctrl;
  const base = state.baseParams;
  if (Math.abs(spreadP - base.spreadP) < 1e-9 && Math.abs(noiseAmp - base.noiseAmp) < 1e-9) {
    return base.params;                       // exact study environment
  }
  return perEdgeParams(state.graph.edges, noiseAmp, spreadP);  // regenerated, deterministic
}

function thetaFor(strategy, ctrl, n) {
  if (strategy === "ga") return state.bestTheta;
  if (strategy === "live") return state.liveTheta;
  if (strategy === "oracle") {
    const p = currentParams(ctrl);
    return Array.from(p.noise, a => Math.min(1, a + 0.10));
  }
  return new Array(n).fill(ctrl.fixedTheta);
}

const STRATEGY_NAMES = { fixed: "fixed-θ", ga: "guided GA", oracle: "oracle", live: "live GA" };

function renderMetrics(m, label) {
  $("mF").textContent = scenarioCost(m).toFixed(2);
  $("mCasc").textContent = `${m.cascadeSize} / ${state.graph.n}`;
  $("mFt").textContent = m.falseTrips;
  $("mLat").textContent = m.latencyPenalty.toFixed(1) + "%";
  $("curveTitle").textContent = `Epidemic curve — ${label}`;
}

/* ---------- actions ---------- */
function runScenario() {
  const ctrl = readControls();
  const params = currentParams(ctrl);
  const theta = thetaFor(ctrl.strategy, ctrl, state.graph.edges.length);
  const m = simulate(state.graph, params, theta, ctrl.seed,
    { cooldown: ctrl.cooldown, nSteps: ctrl.nSteps, recordHistory: true });
  renderMetrics(m, `${STRATEGY_NAMES[ctrl.strategy]}, seed ${ctrl.seed}`);
  drawLineChart($("curve"),
    [{ label: `${STRATEGY_NAMES[ctrl.strategy]} (seed ${ctrl.seed})`, data: m.slowHistory }],
    ["#2563eb"]);
}

async function optimizeLive() {
  const ctrl = readControls();
  const params = currentParams(ctrl);
  $("gaBtn").disabled = true; $("runBtn").disabled = true; $("cmpBtn").disabled = true;
  $("gaProgress").hidden = false;
  const trainSeeds = makeSeeds(4, 1000);
  $("gaStatus").textContent = "Evolving thresholds… (12 generations × 12 individuals)";
  try {
    const res = await runGA(state.graph, params, trainSeeds,
      { popSize: 12, generations: 12, seed: ctrl.seed, guided: true,
        simOpts: { cooldown: ctrl.cooldown, nSteps: ctrl.nSteps, spreadP: ctrl.spreadP } },
      (g, total, bestF) => {
        $("gaBar").style.width = `${(100 * g / total).toFixed(0)}%`;
        $("gaStatus").textContent = `Generation ${g}/${total} — best train F ${bestF.toFixed(2)}`;
      });
    state.liveTheta = res.best;
    $("liveOptLabel").hidden = false;
    document.querySelector('input[name="strategy"][value="live"]').checked = true;
    $("gaStatus").textContent = `Done — best train F ${res.bestF.toFixed(2)}. Showing its epidemic curve.`;
    const m = simulate(state.graph, params, res.best, ctrl.seed,
      { cooldown: ctrl.cooldown, nSteps: ctrl.nSteps, recordHistory: true });
    renderMetrics(m, `live GA, seed ${ctrl.seed}`);
    drawLineChart($("curve"),
      [{ label: `live GA (seed ${ctrl.seed})`, data: m.slowHistory }], ["#16a34a"]);
  } finally {
    $("gaProgress").hidden = true;
    $("gaBtn").disabled = false; $("runBtn").disabled = false; $("cmpBtn").disabled = false;
  }
}

function compareStrategies() {
  const ctrl = readControls();
  const params = currentParams(ctrl);
  const n = state.graph.edges.length;
  const strategies = [
    ["fixed", new Array(n).fill(0.5)],
    ["ga", state.bestTheta],
    ["oracle", thetaFor("oracle", ctrl, n)],
  ];
  if (state.liveTheta) strategies.push(["live", state.liveTheta]);
  const seeds = makeSeeds(8, 9000);
  const simOpts = { cooldown: ctrl.cooldown, nSteps: ctrl.nSteps, spreadP: ctrl.spreadP };
  const rows = strategies.map(([key, theta]) => {
    const e = evaluate(state.graph, params, theta, seeds, simOpts);
    return { key, name: STRATEGY_NAMES[key], ...e };
  });
  drawBarChart($("cmpChart"), rows.map(r => ({ label: r.name, value: r.F })));
  const tb = $("cmpTable"); tb.hidden = false;
  tb.querySelector("tbody").innerHTML = rows.map(r =>
    `<tr><td>${r.name}</td><td>${r.F.toFixed(2)}</td><td>${r.cascadeSize.toFixed(1)}</td><td>${r.falseTrips.toFixed(1)}</td></tr>`
  ).join("");
  // also refresh the single-scenario view for context
  runScenario();
}

/* ---------- init ---------- */
function bindSlider(id, valId, fmt) {
  const el = $(id);
  const show = () => { $(valId).textContent = fmt(parseFloat(el.value)); };
  el.addEventListener("input", show); show();
}

async function init() {
  bindSlider("spreadP", "spreadPVal", v => v.toFixed(2));
  bindSlider("cooldown", "cooldownVal", v => v.toFixed(0));
  bindSlider("noise", "noiseVal", v => v.toFixed(2));
  bindSlider("steps", "stepsVal", v => v.toFixed(0));
  bindSlider("theta", "thetaVal", v => v.toFixed(2));
  try {
    const [g, ep, bt] = await Promise.all([
      fetch("data/graph.json").then(r => r.json()),
      fetch("data/edge_params.json").then(r => r.json()),
      fetch("data/best_theta.json").then(r => r.json()),
    ]);
    state.graph = loadGraph(g);
    state.baseParams = {
      spreadP: ep.spreadP, noiseAmp: ep.noiseAmp,
      params: { noise: Float64Array.from(ep.params.map(p => p[2])), p: Float64Array.from(ep.params.map(p => p[3])) },
    };
    state.bestTheta = bt;
    state.ready = true;
    $("runBtn").disabled = false; $("gaBtn").disabled = false; $("cmpBtn").disabled = false;
    runScenario();
  } catch (e) {
    $("gaStatus").textContent = "Failed to load simulation data: " + e.message;
  }
  $("runBtn").addEventListener("click", runScenario);
  $("gaBtn").addEventListener("click", optimizeLive);
  $("cmpBtn").addEventListener("click", compareStrategies);
  window.addEventListener("resize", () => { if (state.ready) runScenario(); });
}

document.addEventListener("DOMContentLoaded", init);
