export interface EditLine {
  readonly kind: 'context' | 'removed' | 'added';
  readonly text: string;
}

const split = (text: string) => {
  const parts = text.split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts;
};

/**
 * The lines of an edit that replaces `find` with `text` (or appends `text` when `find` is null):
 * the lines both share at the start and the end show as context, the rest as removed and added.
 */
export const editLines = (find: string | null, text: string): EditLine[] => {
  const removed = find === null ? [] : split(find);
  const added = split(text);
  let head = 0;
  while (head < removed.length && head < added.length && removed[head] === added[head]) head++;
  let tail = 0;
  while (
    tail < removed.length - head &&
    tail < added.length - head &&
    removed[removed.length - 1 - tail] === added[added.length - 1 - tail]
  )
    tail++;
  const context = (line: string): EditLine => ({ kind: 'context', text: line });
  return [
    ...removed.slice(0, head).map(context),
    ...removed
      .slice(head, removed.length - tail)
      .map((line): EditLine => ({ kind: 'removed', text: line })),
    ...added
      .slice(head, added.length - tail)
      .map((line): EditLine => ({ kind: 'added', text: line })),
    ...removed.slice(removed.length - tail).map(context)
  ];
};
