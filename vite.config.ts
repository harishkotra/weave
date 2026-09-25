import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The browser never talks to a model provider directly. Every model call goes
// through the backend on 3001, which is what makes local providers (Ollama,
// LM Studio) work without CORS configuration and keeps API keys off the client.
export default defineConfig({
  plugins: [react()],
  server: {
    // Defaults are the documented ones (5173 front end, 3001 back end). Both are
    // overridable so this can run next to another project on the same machine.
    port: Number(process.env.WEAVE_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.WEAVE_API_TARGET ?? 'http://127.0.0.1:3001',
        changeOrigin: true,
        // Server-Sent Events progress stream must not be buffered.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (String(proxyRes.headers['content-type'] ?? '').includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});