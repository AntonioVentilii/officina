/** The board's heading, which takes focus back from a drawer whose card the board does not show. */
export const BOARD_HEADING_ID = 'board-heading';

/**
 * Where focus goes once a task's drawer has closed and the board is drawn again: the task's card,
 * which opened it, or the board's heading when the card is not shown (a closed stage or a filter
 * hides it), so focus never falls to the page body.
 */
export const focusAfterDrawer = (document: Document, number: number): HTMLElement | null =>
  document.querySelector<HTMLElement>(`a[href="/tasks/${number}"]`) ??
  document.getElementById(BOARD_HEADING_ID);

/**
 * Whether a key pressed while the drawer is open closes it. Escape in a comment being typed is left
 * to the comment, and Escape in a native dialog open above the drawer (the welcome guide) belongs
 * to that dialog, which closes on its own.
 */
export const closesDrawer = (key: string, target: Element | null): boolean =>
  key === 'Escape' && !target?.closest('textarea, dialog[open]');
