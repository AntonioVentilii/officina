import type { RunTokens } from './types';

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

const TOKEN_COUNT = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });

/** Each kind of token with the word the board gives it, in the order the API reports them. */
const TOKEN_KINDS = [
  ['input', 'in'],
  ['output', 'out'],
  ['cacheRead', 'cache read'],
  ['cacheWrite', 'cache write']
] as const satisfies readonly (readonly [keyof RunTokens, string])[];

/** A run's tokens kind by kind, as people read them ("13.7M cache read"); none for no tokens. */
export const tokenParts = (tokens: RunTokens | null): string[] =>
  tokens ? TOKEN_KINDS.map(([kind, word]) => `${TOKEN_COUNT.format(tokens[kind])} ${word}`) : [];

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });

/**
 * A person's initials: the first letter of the first word and of the last word of their name, so
 * the second letter is the surname's initial even after several given names ("Maria Grazia Rossi"
 * is MR). A name is one string, so for a double surname it is the initial of its last part
 * ("Gabriel García Márquez" is GM), and a one-word name gives a single letter ("Antonio" is A).
 */
export const initials = (name: string) => {
  const words = name.split(/\s+/).filter(Boolean);
  return [words[0], words.length > 1 ? words.at(-1) : undefined]
    .filter((word) => word !== undefined)
    .map((word) => word[0]!.toUpperCase())
    .join('');
};

/**
 * The fixed words for a code that came from the address or the API; any other value gets the
 * fallback, so text from a link is never shown as it is.
 */
export const wordsFor = <Code extends string>(
  table: Readonly<Record<Code, string>>,
  code: string,
  fallback: string
): string => (Object.hasOwn(table, code) ? table[code as Code] : fallback);
