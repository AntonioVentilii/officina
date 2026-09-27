import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
export default {
  kit: {
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
  }
};
