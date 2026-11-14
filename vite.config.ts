import { type Plugin, defineConfig } from 'vite';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
// @ts-expect-error the copy of fflate that ships inside three has no types
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';

// `npm run dev:https` serves over https with a local self-signed certificate. Browsers only let a page use
// game controllers (and WebGPU) on https or localhost, so this is how another computer on the network plays with one.
const https = process.env.HTTPS === '1' && existsSync('.cert/key.pem') ? { key: readFileSync('.cert/key.pem'), cert: readFileSync('.cert/cert.pem') } : undefined;

const MODEL_FILES = /\.(glb|gltf|bin|png|jpe?g|webp|txt)$/i;
const MANIFEST = 'public/models/garage.json';

/**
 * The garage importer's other half (src/vehicle/garage.ts): takes a zip of model files from the game's
 * "Import vehicle" dialog and writes it into public/models/<id>/, then lists it in garage.json.
 * It exists only in `vite dev`, answers only this machine, and only a page served from here: the built game has
 * no such door, so nobody playing it can add anything.
 */
function garage(): Plugin {
  return {
    name: 'garage',
    apply: 'serve',
    configureServer(server) {
      // Vite lists the public folder once, at start: a model imported since would not be served until a restart.
      server.middlewares.use('/models', (req, res, next) => {
        const file = resolve('public/models', '.' + decodeURIComponent((req.url ?? '').split('?')[0]));
        if (!file.startsWith(resolve('public/models') + sep) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      });
      server.middlewares.use('/__garage', (req, res) => {
        const say = (status: number, body: object) => {
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(body));
        };
        const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '');
        // the header cannot be sent by another site's page without a preflight, which this never answers
        if (!local || req.headers['x-garage'] !== '1' || (req.method !== 'PUT' && req.method !== 'DELETE')) return say(403, { error: 'The garage only opens for the game running on this machine.' });
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          try {
            const entry = JSON.parse(new URL(req.url ?? '', 'http://x').searchParams.get('entry') ?? '{}');
            if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(entry.id)) throw new Error('That name will not make a folder name: use letters and digits.');
            if (['sian', 'g63', 'rider'].includes(entry.id)) throw new Error('That one is built in.');
            const dir = join('public/models', entry.id);
            const list: { id: string }[] = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : [];
            const rest = list.filter((e) => e.id !== entry.id);
            if (req.method === 'DELETE') {
              rmSync(dir, { recursive: true, force: true });
              writeFileSync(MANIFEST, JSON.stringify(rest, null, 2) + '\n');
              return say(200, { removed: entry.id });
            }
            const body = Buffer.concat(chunks);
            if (body.length) {
              // new files; with no body the entry alone is updated (turned round, renamed)
              const files = Object.entries(unzipSync(new Uint8Array(body)) as Record<string, Uint8Array>)
                .map(([path, data]) => ({ parts: path.split('/').filter(Boolean), data }))
                .filter((f) => f.data.length && MODEL_FILES.test(f.parts[f.parts.length - 1] ?? '') && f.parts.every((p) => /^[\w][\w .()+-]*$/.test(p)));
              // a zip of one folder: drop the folder
              while (files.length && files.every((f) => f.parts.length > 1 && f.parts[0] === files[0].parts[0])) for (const f of files) f.parts.shift();
              const models = files.filter((f) => /\.(glb|gltf)$/i.test(f.parts[f.parts.length - 1])).sort((a, b) => a.parts.length - b.parts.length);
              if (!models.length) throw new Error('No .glb or .gltf in there. A GTA V mod (.yft / .ytd) has to be converted first: open it in Blender with the Sollumz add-on and export glTF.');
              rmSync(dir, { recursive: true, force: true });
              for (const f of files) {
                const to = join(dir, ...f.parts);
                mkdirSync(dirname(to), { recursive: true });
                writeFileSync(to, f.data);
              }
              entry.file = models[0].parts.join('/');
            } else if (!existsSync(join(dir, String(entry.file)))) throw new Error('No model has been imported under that name yet.');
            writeFileSync(MANIFEST, JSON.stringify([...rest, entry], null, 2) + '\n');
            say(200, entry);
          } catch (err) {
            say(400, { error: err instanceof Error ? err.message : String(err) });
          }
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [garage()],
  // imported models land in public/models while the game is open: that must not reload the page mid-import
  server: { host: true, port: 5180, strictPort: true, allowedHosts: true, https, watch: { ignored: ['**/public/models/**'] } },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  // shown in the pause menu, so it is plain which version a browser is actually running
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC') },
});
