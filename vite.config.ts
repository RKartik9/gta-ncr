import { defineConfig } from 'vite';
import { existsSync, readFileSync } from 'node:fs';

// `npm run dev:https` serves over https with a local self-signed certificate. Browsers only let a page use
// game controllers (and WebGPU) on https or localhost, so this is how another computer on the network plays with one.
const https = process.env.HTTPS === '1' && existsSync('.cert/key.pem') ? { key: readFileSync('.cert/key.pem'), cert: readFileSync('.cert/cert.pem') } : undefined;

export default defineConfig({
  server: { host: true, port: 5180, strictPort: true, allowedHosts: true, https },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  // shown in the pause menu, so it is plain which version a browser is actually running
  define: { __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC') },
});
