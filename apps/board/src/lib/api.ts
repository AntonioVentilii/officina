export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(response.status, body.error ?? response.statusText);
  return body as T;
};

export const get = <T>(path: string) => request<T>(path);

/** The header proves the request came from this page; the API refuses changes without it. */
export const post = <T>(path: string, body: unknown = {}) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-officina-request': '1' },
    body: JSON.stringify(body)
  });
