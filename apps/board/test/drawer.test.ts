/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { installWindow } from './dom';
import { BOARD_HEADING_ID, closesDrawer, focusAfterDrawer } from '../src/lib/drawer';

const page = (cards: string) => {
  const { document } = installWindow();
  document.body.innerHTML = `
    <h1 id="${BOARD_HEADING_ID}" tabindex="-1">Board</h1>
    <div id="columns">${cards}</div>
    <div id="drawer"><button id="close">Close</button><textarea id="comment"></textarea></div>
    <dialog id="guide" open><button id="next">Next</button></dialog>`;
  return document;
};

describe('focusAfterDrawer', () => {
  test('focus goes back to the card that opened the drawer', () => {
    const document = page('<a id="card" href="/tasks/7">Task 7</a>');
    expect(focusAfterDrawer(document, 7)?.id).toBe('card');
  });

  test("a card the board does not show gives focus to the board's heading", () => {
    const document = page('<a id="card" href="/tasks/8">Task 8</a>');
    expect(focusAfterDrawer(document, 7)?.id).toBe(BOARD_HEADING_ID);
  });
});

describe('closesDrawer', () => {
  test('Escape closes the drawer, except in a comment or in a native dialog open above it', () => {
    const document = page('');
    const at = (id: string) => document.getElementById(id);
    expect(closesDrawer('Escape', at('close'))).toBe(true);
    expect(closesDrawer('Escape', document.body)).toBe(true);
    expect(closesDrawer('Escape', null)).toBe(true);
    expect(closesDrawer('Escape', at('comment'))).toBe(false);
    expect(closesDrawer('Escape', at('next'))).toBe(false);
    expect(closesDrawer('Escape', at('guide'))).toBe(false);
    expect(closesDrawer('Enter', at('close'))).toBe(false);
  });
});
