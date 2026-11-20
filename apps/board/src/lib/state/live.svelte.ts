import { EVERY_PROJECT, type LiveEvent } from '#lib/live-events.ts';

type Listener = (event: LiveEvent) => void;

/** How long to wait before opening the stream again after the server closed it. */
const RECONNECT_MS = 5000;

/** The server's change stream. Events only say what changed; each view refetches what it shows. */
class Live {
  status = $state<'connecting' | 'live' | 'offline'>('connecting');
  #source: EventSource | null = null;
  #listeners = new Set<Listener>();
  #retry: ReturnType<typeof setTimeout> | null = null;
  /** Whether the stream opened since the board connected it, so any later open is a reconnect. */
  #opened = false;

  connect() {
    if (this.#source) return;
    const source = new EventSource('/api/stream');
    this.#source = source;
    source.onopen = () => {
      // After any reconnect, including one the browser makes on its own, anything may have
      // changed, so every view refreshes once.
      if (this.#opened) this.#emitAll();
      this.#opened = true;
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
    for (const kind of ['task', 'run', 'members'] as const) {
      source.addEventListener(kind, (message) => {
        const event = JSON.parse((message as MessageEvent<string>).data) as LiveEvent;
        for (const listener of this.#listeners) listener(event);
      });
    }
  }

  #emitAll() {
    const event: LiveEvent = { kind: 'task', projectId: EVERY_PROJECT, number: 0 };
    for (const listener of this.#listeners) listener(event);
  }

  disconnect() {
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = null;
    this.#source?.close();
    this.#source = null;
    this.#opened = false;
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
