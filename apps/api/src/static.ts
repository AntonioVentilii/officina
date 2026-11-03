import { resolve, sep } from 'node:path';

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-cache',
  // The page's own CSP arrives as a meta tag, which cannot forbid framing; these headers can.
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff'
};

/**
 * Serves the board's static build. Paths that are not files get the app shell, so client routes
 * such as `/tasks/12` load directly; API paths never do, they get a JSON 404.
 */
export const createBoardServer = (dir: string) => {
  const root = resolve(dir);
  const shell = Bun.file(resolve(root, 'index.html'));

  return async (pathname: string): Promise<Response> => {
    if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) {
      return Response.json({ error: 'not found' }, { status: 404 });
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const target = resolve(root, `.${decoded}`);
    if (target.startsWith(root + sep) && !target.endsWith(sep)) {
      const file = Bun.file(target);
      if (target !== resolve(root, 'index.html') && (await file.exists())) {
        return new Response(file, {
          headers: {
            'cache-control': pathname.startsWith('/_app/immutable/')
              ? 'public, max-age=31536000, immutable'
              : 'public, max-age=300',
            'x-content-type-options': 'nosniff'
          }
        });
      }
    }
    if (!(await shell.exists())) return new Response('The board is not built.', { status: 503 });
    return new Response(shell, { headers: HTML_HEADERS });
  };
};
