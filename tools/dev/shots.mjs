// Drives the running game in a headless Chromium-family browser over the DevTools protocol:
// takes a screenshot of every camera for each car, does a short WASD drive, and prints frame rates.
// Usage: npm run dev (in another terminal), then: node tools/dev/shots.mjs [outDir] [url]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = process.argv[2] ?? 'shots';
// ?fresh: a plain address stops at the title screen and waits for a button
const url = process.argv[3] ?? 'http://localhost:5180/?fresh';
const port = 9333;
const browser = [
  process.env.BROWSER_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p) => p && existsSync(p));
if (!browser) throw new Error('No Chromium-family browser found; set BROWSER_BIN');

mkdirSync(out, { recursive: true });
const profile = join(tmpdir(), 'delhi-drive-shots-profile');
rmSync(profile, { recursive: true, force: true });
const child = spawn(browser, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1600,900',
  '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio',
  ...(process.env.BROWSER_ARGS?.split(' ') ?? []),
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 60 && !target; i++) {
  await sleep(250);
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
  } catch {}
}
if (!target) throw new Error('browser did not start');

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const problems = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === 'Runtime.exceptionThrown') {
    problems.push(`exception: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
  } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
    problems.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 1800)}`);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 88 });
  writeFileSync(join(out, `${name}.jpg`), Buffer.from(data, 'base64'));
};
const KEYS = { ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32, KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68 };
const key = (type, code) => send('Input.dispatchKeyEvent', { type, code, key: code === 'Space' ? ' ' : code.startsWith('Key') ? code.slice(3).toLowerCase() : code, windowsVirtualKeyCode: KEYS[code] });

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  let ready = false;
  for (let i = 0; i < 240 && !ready; i++) {
    await sleep(500);
    ready = await evaluate('!!(window.game && window.game.perf.fps > 0)').catch(() => false);
    const failed = await evaluate(`document.querySelector('#loading-text.error')?.textContent ?? ''`).catch(() => '');
    if (failed) throw new Error(failed);
  }
  if (!ready) throw new Error(`the game did not start: ${await evaluate(`document.getElementById('loading-text').textContent`)}`);
  console.log('gpu:', await evaluate(`(() => { const c = document.createElement('canvas').getContext('webgl2'); const e = c && c.getExtension('WEBGL_debug_renderer_info'); return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()`));

  if (process.env.QUICK) {
    // one frame and the console: enough to compare render settings via the URL
    if (process.env.EVAL) console.log('eval:', JSON.stringify(await evaluate(process.env.EVAL)));
    await sleep(1500);
    await shot(process.env.QUICK);
    console.log(JSON.stringify(await evaluate('game.state()')));
    throw new Error('quick run: stopping after one shot');
  }

  const cars = [];
  const first = await evaluate('game.car');
  do {
    const car = await evaluate('game.car');
    cars.push(car);
    for (const cam of ['chase', 'top', 'hood', 'cockpit', 'cinematic', 'drone']) {
      await evaluate(`game.setCamera('${cam}')`);
      await sleep(cam === 'cinematic' ? 1600 : 1200);
      await shot(`${car}-${cam}`);
      console.log(`${car} ${cam}:`, JSON.stringify(await evaluate('game.state()')));
    }
    await evaluate('game.switchCar()');
    await sleep(600);
  } while ((await evaluate('game.car')) !== first);

  // A short drive on WASD: straight, then a left turn, then stop.
  await evaluate(`game.setCamera('chase')`);
  const before = await evaluate('game.state()');
  await key('keyDown', 'KeyW');
  await sleep(3000);
  await shot('drive-1-accelerating');
  const fast = await evaluate('game.state()');
  await key('keyDown', 'KeyA');
  await sleep(1500);
  await shot('drive-2-turning');
  const turned = await evaluate('game.state()');
  await key('keyUp', 'KeyA');
  await key('keyUp', 'KeyW');
  await key('keyDown', 'KeyS');
  await sleep(2500);
  await key('keyUp', 'KeyS');
  const after = await evaluate('game.state()');
  console.log('drive:', JSON.stringify({ before, fast, turned, after }));
  console.log('cars:', cars.join(', '));
} finally {
  console.log(problems.length ? `console problems (${problems.length}):\n  ${[...new Set(problems)].slice(0, 25).join('\n  ')}` : 'no console errors or warnings');
  ws.close();
  child.kill();
}
