# Epidemic Breakers — Interactive Web Demo

Live simulation website for the **Epidemic Breakers** OptiForge 2026 project
(Track 05: Intelligent Systems & Autonomous Computing).

Zero-dependency static site (HTML + CSS + vanilla JS). The cascade simulator,
fitness function, edge-betweenness computation, and a small in-browser genetic
algorithm are all ported to JavaScript in `sim.js`; the UI lives in `app.js`.
The exact 40-node / 111-edge study graph, its per-edge noise/spread parameters,
and the GA-optimized threshold vector are baked in under `data/` (exported from
the main repo).

Hosted with GitHub Pages.
