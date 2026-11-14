/** GitHub's compare endpoint lists at most this many files; a full page means the list may be cut. */
export const COMPARE_FILE_LIMIT = 300;

/** A file of a compare between a base and a head, as GitHub lists it. */
export interface ComparedFile {
  readonly filename: string;
  readonly previous_filename?: string;
  readonly status: string;
  /** The file's content at the head (its blob), absent for a removed file. */
  readonly sha?: string | null;
}

/**
 * What a head changes against the base, file by file with the content each file has at the head,
 * as one string: two heads with the same fingerprint carry the same change, whatever else came in
 * from the base. `null` when GitHub may have cut the list, since then nothing can be said.
 */
export const changeFingerprint = (files: readonly ComparedFile[] | undefined): string | null => {
  if (!files || files.length >= COMPARE_FILE_LIMIT) return null;
  return files
    .map((file) =>
      [file.status, file.previous_filename ?? '', file.filename, file.sha ?? ''].join(' ')
    )
    .sort()
    .join('\n');
};
