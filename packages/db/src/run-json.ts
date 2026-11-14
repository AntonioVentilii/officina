/** Postgres refuses the NUL character in `jsonb`, and agent output can hold it; it is dropped. */
const withoutNul = (value: unknown): unknown => {
  if (typeof value === 'string') return value.replaceAll('\u0000', '');
  if (Array.isArray(value)) return value.map(withoutNul);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key.replaceAll('\u0000', ''), withoutNul(inner)])
    );
  return value;
};

/** A run's own value as `jsonb` text, whatever the agent put in it. */
export const runJson = (value: unknown): string => JSON.stringify(withoutNul(value));
