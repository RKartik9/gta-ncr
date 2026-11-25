# Delhi Drive: notes for agents

TypeScript + Vite + three.js (WebGPU, `three/webgpu`) + Rapier. No UI framework, no test runner.

## Verify

```bash
npm run typecheck                 # tsc --noEmit
npm run build                     # typecheck + vite build
node tools/dev/vehicle-check.ts   # headless: car handling
node tools/dev/rollover-check.ts  # headless: rollovers
node tools/dev/fight-check.ts     # headless: on-foot capsule, blows, ragdoll (exits 1 on failure)
```

In a browser (needs a Chromium-family browser installed; set `BROWSER_BIN` if it is not found):

```bash
npm run dev                       # http://localhost:5180
QUICK=name EVAL='<js expression, may be async>' node tools/dev/shots.mjs /tmp/shots 'http://localhost:5180/?fresh&q=low'
```

`QUICK` runs `EVAL` in the page, saves one screenshot as `<name>.jpg` and prints `game.state()` and any console
errors (it ends by throwing "quick run": that is expected). `window.game` exposes `combat`, `pedestrians`,
`traffic`, `vehicle` and `debug.director` for driving scenarios from `EVAL`. The warning
`Vertex attribute "uv1" not found on geometry` is long-standing and comes from a car model.

## Conventions

- Comments explain why, in plain prose; keep that style, and do not add or strip comments needlessly.
- Rapier bodies are never removed while the game runs (it costs seconds in a loaded city): pool them and use `setEnabled`.
- `stepWorld()` (src/world/physics.ts) replaces `world.step()`.
- A rigid body's `userData` belongs to street furniture (`syncProps`): do not set it on other bodies.
- Figures (`public/models/people`, `rider`) have Mixamo bone names and no animation clips; poses are written by hand in `src/character/poses.ts`.
