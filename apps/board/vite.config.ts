import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

const api = process.env.OFFICINA_API_URL ?? 'http://localhost:8080';

export default defineConfig({
  plugins: [
    sveltekit({
      // A single-page app served by the API: every path that is not a file falls back to index.html.
      adapter: adapter({ pages: 'build', assets: 'build', fallback: 'index.html', strict: true }),
      csp: {
        mode: 'hash',
        directives: {
          'default-src': ['self'],
          'script-src': ['self'],
          'style-src': ['self', 'unsafe-inline'],
          'img-src': ['self', 'data:'],
          'font-src': ['self'],
          'connect-src': ['self'],
          'frame-ancestors': ['none'],
          'base-uri': ['self'],
          'form-action': ['self'],
          'object-src': ['none']
        }
      }
    })
  ],
  server: {
    port: 5173,
    // Logo.svelte reads the anvil from static/favicon.svg, which has to stay a plain public file.
    fs: { allow: ['static'] },
    proxy: {
      '/api': { target: api, changeOrigin: true },
      '/auth': { target: api, changeOrigin: true }
    }
  }
});
