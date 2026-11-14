import { Window, type Node } from 'happy-dom';

/**
 * A happy-dom window set as the global `window`, so DOMPurify binds to it when it is first
 * imported. Import what uses DOMPurify only after calling this. Two places where happy-dom is not
 * a browser and DOMPurify relies on the browser are put right first, or the sanitizer would let
 * through what a browser's would remove.
 */
export const installWindow = (): Window => {
  const window = new Window();
  readNodeNameFromNode(window);
  keepIteratorPlaceOnRemoval(window);
  Object.assign(globalThis, { window });
  return window;
};

/**
 * Browsers define `nodeName` only on Node.prototype, and DOMPurify reads it from there. happy-dom
 * defines it again on each node class and leaves Node's own empty, so every element would look
 * unknown. Node's answers with the one the node's own class defines.
 */
const readNodeNameFromNode = (window: Window) => {
  const { prototype } = window.Node;
  Object.defineProperty(prototype, 'nodeName', {
    configurable: true,
    get(this: object): unknown {
      for (
        let at = Object.getPrototypeOf(this);
        at && at !== prototype;
        at = Object.getPrototypeOf(at)
      ) {
        const own = Object.getOwnPropertyDescriptor(at, 'nodeName')?.get;
        if (own) return own.call(this);
      }
      return '';
    }
  });
};

const following = (from: Node, root: Node): Node | null => {
  if (from.firstChild) return from.firstChild;
  for (let at: Node | null = from; at && at !== root; at = at.parentNode) {
    if (at.nextSibling) return at.nextSibling;
  }
  return null;
};

const preceding = (node: Node): Node | null => {
  let at = node.previousSibling;
  if (!at) return node.parentNode;
  while (at.lastChild) at = at.lastChild;
  return at;
};

/**
 * A browser's node iterator keeps its place when the node it stands on is removed, stepping back to
 * the node before it. happy-dom's stops there, so DOMPurify would stop at the first element it
 * removes and leave everything after it, the content it moved out of that element included.
 */
const keepIteratorPlaceOnRemoval = (window: Window) => {
  const createNodeIterator = (root: Node, whatToShow: number) => {
    let current: Node | null = null;
    let before: Node | null = null;
    const shown = (node: Node) => (whatToShow & (1 << (node.nodeType - 1))) !== 0;
    return {
      nextNode(): Node | null {
        let next =
          current === null
            ? root
            : following(root.contains(current) ? current : (before ?? root), root);
        while (next && !shown(next)) next = following(next, root);
        if (next) {
          before = next === root ? null : preceding(next);
          current = next;
        }
        return next;
      }
    };
  };
  Object.defineProperty(window.document, 'createNodeIterator', {
    configurable: true,
    value: createNodeIterator
  });
};
