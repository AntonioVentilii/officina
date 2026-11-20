import type { TaskEvent } from './types';

/** The payload field each event's text below its sentence comes from. */
const DETAIL_FIELDS: Readonly<Record<string, string>> = {
  changes_requested: 'note',
  review_recorded: 'notes',
  build_unchanged: 'note',
  ci_failed: 'details'
};

/** The text a timeline entry shows below its sentence, if any: a question, notes, check output. */
export const eventDetail = (event: TaskEvent): string | null => {
  const p = event.payload;
  if (event.type === 'blocked') return String((p.blocked as { question?: string })?.question ?? '');
  const field = DETAIL_FIELDS[event.type];
  const value = field ? p[field] : undefined;
  return value ? String(value) : null;
};
