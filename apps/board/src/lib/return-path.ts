/**
 * Where to go after signing in: only a path on this site, never an address elsewhere. The value is
 * resolved the way the browser would (tabs and newlines dropped, `\` read as `/`, dot segments
 * removed) and refused when it lands on another origin, or when what it resolves to starts with two
 * slashes, which the browser would read as an address on another host. Anything refused is `/`.
 */
export const returnPath = (raw: string, origin: string): string => {
  const resolved = raw.startsWith('/') ? URL.parse(raw, origin) : null;
  if (resolved?.origin !== origin) return '/';
  const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
  return /^\/[/\\]/.test(path) ? '/' : path;
};
