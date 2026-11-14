/**
 * The Markdown table check of `scripts/check-repo.ts`, apart from the script so a test can run
 * it: every row of a table has as many cells as its header, with rows read the way GFM reads them.
 */

interface Fence {
  marker: string;
  length: number;
}

const FENCE = /^\s*(`{3,}|~{3,})(.*)$/;
const CLOSING_FENCE = /^\s*(`{3,}|~{3,})\s*$/;
const DELIMITER_CELL = /^\s*:?-+:?\s*$/;

/**
 * A row split on its separators. A pipe is escaped by an odd run of backslashes before it, so
 * `\|` stays inside its cell and `\\|` separates two, as in GFM.
 */
const split = (row: string): string[] => {
  const parts: string[] = [];
  let part = '';
  let backslashes = 0;
  for (const char of row.trim()) {
    if (char === '|' && backslashes % 2 === 0) {
      parts.push(part);
      part = '';
    } else part += char;
    backslashes = char === '\\' ? backslashes + 1 : 0;
  }
  return [...parts, part];
};

/** The cells of a row; the leading and trailing pipes are optional and hold no cell. */
const cells = (row: string): string[] => {
  const parts = split(row);
  if (parts[0] === '') parts.shift();
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
};

/** The row under a table's header: only dashes and alignment colons, between pipes. */
const isDelimiter = (row: string): boolean => {
  const parts = cells(row);
  return (
    split(row).length > 1 && parts.length > 0 && parts.every((cell) => DELIMITER_CELL.test(cell))
  );
};

/** The fence a line opens, if any; a backtick fence's info string holds no backtick. */
const opens = (line: string): Fence | null => {
  const [, run = '', info = ''] = FENCE.exec(line) ?? [];
  const marker = run.charAt(0);
  if (!run || (marker === '`' && info.includes('`'))) return null;
  return { marker, length: run.length };
};

/** Whether a line closes a fence: the same marker, at least as long, and nothing after it. */
const closes = (line: string, fence: Fence): boolean => {
  const [, run = ''] = CLOSING_FENCE.exec(line) ?? [];
  return run.charAt(0) === fence.marker && run.length >= fence.length;
};

/**
 * Each table row, outside fenced code, whose cell count differs from its table's header. A table
 * starts at a line followed by a delimiter row and ends at the first line with no separator.
 */
export const tableProblems = (path: string, lines: readonly string[]): string[] => {
  const problems: string[] = [];
  let fence: Fence | null = null;
  let header: number | null = null;
  lines.forEach((line, index) => {
    if (fence) {
      if (closes(line, fence)) fence = null;
      return;
    }
    fence = opens(line);
    if (fence || split(line).length < 2) header = null;
    else if (header === null)
      header = isDelimiter(lines[index + 1] ?? '') ? cells(line).length : null;
    else if (cells(line).length !== header)
      problems.push(
        `${path}:${index + 1}: table row has ${cells(line).length} cells, header ${header}`
      );
  });
  return problems;
};
