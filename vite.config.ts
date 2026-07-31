import path from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Set HTTPS=true to serve the dev server over a self-signed TLS cert — needed
// to exercise the PWA / service worker / push on a real device, since those
// only activate in a "secure context" (HTTPS or localhost). See the run guide
// in 04-DriverOS/DriverOS_Overview.md. Combine with `--host` (npm run dev:lan)
// to make it reachable from a tablet/phone on the same WiFi.
const useHttps = process.env.HTTPS === 'true';

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(useHttps ? [basicSsl()] : [])],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: Number(process.env.PORT) || 5174,
    proxy: {
      // Same-origin in the browser during dev, same reasoning as apps/fleethq's
      // proxy config — the API is the same one both clients talk to.
      '/v1': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
});
