import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies the API and the socket so the dashboard runs on
// :5173 without CORS or a second origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:4000', ws: true },
    },
  },
});
