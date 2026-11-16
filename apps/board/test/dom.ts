import { JSDOM } from 'jsdom';

/**
 * A jsdom window set as the global `window`, so DOMPurify binds to it when it is first imported.
 * Import what uses DOMPurify only after calling this.
 */
export const installWindow = () => {
  const { window } = new JSDOM('');
  Object.assign(globalThis, { window });
  return window;
};
