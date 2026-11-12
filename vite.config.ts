import { defineConfig } from 'vite';

export default defineConfig({
  server: { host: true, port: 5180, strictPort: true, allowedHosts: true },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
