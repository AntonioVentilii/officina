export type LiveEvent =
  | { readonly kind: 'task'; readonly projectId: string; readonly number: number }
  | {
      readonly kind: 'run';
      readonly projectId: string;
      readonly number: number;
      readonly runId: string;
    };

type Listener = (event: LiveEvent) => void;

/** How long to wait before opening the stream again after the server closed it. */
const RECONNECT_MS = 5000;

/** The server's change stream. Events only say what changed; each view refetches what it shows. */
class Live {
  status = $state<'connecting' | 'live' | 'offline'>('connecting');
  #source: EventSource | null = null;
  #listeners = new Set<Listener>();
  #retry: ReturnType<typeof setTimeout> | null = null;

  connect() {
    if (this.#source) return;
    const source = new EventSource('/api/stream');
    this.#source = source;
    source.onopen = () => {
      // After a reconnect anything may have changed, so every view refreshes once.
      if (this.status !== 'connecting') this.#emitAll();
      this.status = 'live';
    };
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED) {
        this.status = 'connecting';
        return;
      }
      // The browser retries on its own only while the stream is open; an HTTP error (a deploy
      // restart, say) closes it for good, so it is opened again here.
      this.status = 'offline';
      source.close();
      this.#source = null;
      this.#retry ??= setTimeout(() => {
        this.#retry = null;
        this.connect();
      }, RECONNECT_MS);
    };
    for (const kind of ['task', 'run'] as const) {
      source.addEventListener(kind, (message) => {
        const event = JSON.parse((message as MessageEvent<string>).data) as LiveEvent;
        for (const listener of this.#listeners) listener(event);
      });
    }
  }

  #emitAll() {
    for (const listener of this.#listeners) listener({ kind: 'task', projectId: '*', number: 0 });
  }

  disconnect() {
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    this.#source?.close();
    this.#source = null;
    this.status = 'connecting';
  }

  subscribe(listener: Listener) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

export const live = new Live();

/** Runs `fn` at most once per `ms`, trailing, so bursts of events cost one request. */
export const coalesce = (fn: () => void, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };
};
