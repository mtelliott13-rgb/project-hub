import fs from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { UI_TOKEN_FILE } from './src/server/config.ts';
import { injectToken } from './src/server/app.ts';

// In dev, Vite serves index.html, so it adds the launch token the way the hub does.
const hubToken = (): Plugin => ({
  name: 'hub-token',
  apply: 'serve',
  transformIndexHtml: (html) =>
    fs.existsSync(UI_TOKEN_FILE) ? injectToken(html, fs.readFileSync(UI_TOKEN_FILE, 'utf8').trim()) : html,
});

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss(), hubToken()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  // `pnpm dev` runs the API on 4747 and this dev server on 5173. The server
  // accepts this origin only when started with PROJECT_HUB_DEV_ORIGIN (see package.json).
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4747', changeOrigin: true } },
  },
});
