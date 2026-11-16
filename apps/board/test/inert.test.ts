/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { installWindow } from './dom';
import { inertAround } from '../src/lib/inert';

const page = () => {
  const { document } = installWindow();
  document.body.innerHTML = `
    <div id="root">
      <div id="shell">
        <nav id="sidebar"><a href="/inbox">Inbox</a></nav>
        <main id="main">
          <div id="board"><a href="/tasks/1">Task 1</a></div>
          <div id="drawer"><button>Close</button></div>
        </main>
      </div>
      <div id="toasts" aria-live="polite"></div>
      <dialog id="guide" open></dialog>
      <div id="held" inert></div>
    </div>`;
  const inert = () => [...document.querySelectorAll('[inert]')].map((element) => element.id).sort();
  return { drawer: document.getElementById('drawer')!, inert };
};

describe('inertAround', () => {
  test('everything around the dialog is inert, except live regions and an open dialog, until it closes', () => {
    const { drawer, inert } = page();
    const release = inertAround(drawer);
    expect(inert()).toEqual(['board', 'held', 'sidebar']);
    release();
    // What was inert before the dialog opened stays so.
    expect(inert()).toEqual(['held']);
  });
});
