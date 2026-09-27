export interface Toast {
  readonly id: number;
  readonly kind: 'ok' | 'error';
  readonly text: string;
}

class Toasts {
  items = $state<Toast[]>([]);
  #next = 1;

  show(kind: Toast['kind'], text: string) {
    const id = this.#next++;
    this.items = [...this.items, { id, kind, text }];
    setTimeout(() => this.dismiss(id), kind === 'error' ? 7000 : 3500);
  }

  dismiss(id: number) {
    this.items = this.items.filter((item) => item.id !== id);
  }
}

export const toasts = new Toasts();
