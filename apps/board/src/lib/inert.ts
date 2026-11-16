/**
 * What stays usable while a dialog is open: a live region keeps announcing and its toasts stay
 * clickable, and a modal dialog already open (the welcome guide) sits on top of it.
 */
const staysLive = (element: Element) =>
  element.hasAttribute('aria-live') || element.matches('dialog[open]');

/**
 * Makes everything on the page around `node` inert, as a modal dialog does: the siblings of `node`
 * and of each of its ancestors up to the body, except what stays live and what is inert already.
 * Returns the cleanup that gives back exactly what it took.
 */
export const inertAround = (node: Element): (() => void) => {
  const taken: Element[] = [];
  for (let at: Element | null = node; at?.parentElement; at = at.parentElement) {
    if (at === at.ownerDocument.body) break;
    for (const sibling of at.parentElement.children) {
      if (sibling === at || sibling.hasAttribute('inert') || staysLive(sibling)) continue;
      sibling.setAttribute('inert', '');
      taken.push(sibling);
    }
  }
  return () => {
    for (const element of taken) element.removeAttribute('inert');
  };
};
