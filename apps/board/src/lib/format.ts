const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000]
];

/** Compact elapsed time: `now`, `4m`, `3h`, `2d`. */
export const since = (iso: string | null | undefined, now = Date.now()): string => {
  if (!iso) return '';
  const ms = Math.max(0, now - new Date(iso).getTime());
  for (const [unit, size] of UNITS) {
    if (ms >= size) return `${Math.floor(ms / size)}${unit[0]}`;
  }
  return 'now';
};

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * How long ago, in words: `just now`, `5 minutes ago`, `yesterday`. Every time it is given has
 * passed, so a browser clock behind the server's reads `just now`, never a time to come.
 */
export const ago = (iso: string | null | undefined, now = Date.now()): string => {
  if (!iso) return '';
  const ms = Math.min(0, new Date(iso).getTime() - now);
  for (const [unit, size] of UNITS) {
    if (Math.abs(ms) >= size) return relative.format(Math.round(ms / size), unit);
  }
  return 'just now';
};

export const duration = (from: string | null, to: string | null, now = Date.now()): string => {
  if (!from) return '';
  const ms = Math.max(0, (to ? new Date(to).getTime() : now) - new Date(from).getTime());
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

export const money = (cents: number | null | undefined): string =>
  cents === null || cents === undefined ? '' : `$${(cents / 100).toFixed(2)}`;

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');

/**
 * The fixed words for a code that came from the address or the API; any other value gets the
 * fallback, so text from a link is never shown as it is.
 */
export const wordsFor = <Code extends string>(
  table: Readonly<Record<Code, string>>,
  code: string,
  fallback: string
): string => (Object.hasOwn(table, code) ? table[code as Code] : fallback);
