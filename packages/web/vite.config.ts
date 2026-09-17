// WP-01 scaffold — CLIENT.md §1 L40, ARCHITECTURE §12.
//
// The dev server is the only origin the browser ever talks to: `/api` and `/ws` are proxied to the
// Fastify plant on :8080, so `RestClient({ baseUrl: window.location.origin })` and the WebSocket
// client work unchanged in dev, in preview and behind a reverse proxy in production (API-05).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

/** Overridable so e2e/CI can point the dev server at a plant on another port. */
const API_TARGET = process.env.TERMINAL_API_TARGET ?? 'http://localhost:8080';
const WS_TARGET = process.env.TERMINAL_WS_TARGET ?? 'ws://localhost:8080';
const WEB_PORT = Number(process.env.TERMINAL_WEB_PORT ?? '5173');

/** `/api/v1/*` (REST, API.md §0) and `/ws/v1` (live plant, API.md §11). */
const proxy: Record<string, ProxyOptions> = {
  '/api': { target: API_TARGET, changeOrigin: true },
  // `/metrics` and `/health` sit at the root, outside `/api/v1` (API.md §5.15).
  '/health': { target: API_TARGET, changeOrigin: true },
  '/metrics': { target: API_TARGET, changeOrigin: true },
  '/ws': { target: WS_TARGET, ws: true, changeOrigin: true },
};

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  define: {
    // CLIENT.md §2 L184 — `clientVersion: web/<version>` on every request and on `hello.client`.
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  resolve: {
    // The workspace symlink can otherwise give the SDK its own copy of React.
    dedupe: ['react', 'react-dom'],
  },
  server: { port: WEB_PORT, strictPort: true, proxy },
  preview: { port: WEB_PORT, strictPort: true, proxy },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // CLIENT.md §1 L40: `sdk`, `chart` and `grid` are separate chunks. The `sdk` chunk is also
        // what `test/no-direct-io.test.ts` asserts against — `fetch(`/`new WebSocket(` may appear
        // in no other chunk (ARCHITECTURE §1.1).
        manualChunks(id: string): string | undefined {
          const path = id.split('?')[0] ?? id;
          if (path.includes('/packages/sdk/') || path.includes('@terminal/sdk')) return 'sdk';
          if (path.includes('/src/chart/')) return 'chart';
          if (path.includes('/src/grid/')) return 'grid';
          return undefined;
        },
      },
    },
  },
});
