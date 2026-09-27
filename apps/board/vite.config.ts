import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const api = process.env.OFFICINA_API_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: api, changeOrigin: true },
      '/auth': { target: api, changeOrigin: true }
    }
  }
});
