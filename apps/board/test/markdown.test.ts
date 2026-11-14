/// <reference types="bun" />
import { afterAll, describe, expect, test } from 'bun:test';
import { installWindow } from './dom';

const window = installWindow();
const { renderMarkdown } = await import('../src/lib/markdown');

afterAll(async () => {
  await window.happyDOM.close();
});

const rendered = (source: string) => {
  const holder = window.document.createElement('div');
  holder.innerHTML = renderMarkdown(source);
  return holder;
};

const attributesOf = (holder: ReturnType<typeof rendered>) =>
  [...holder.querySelectorAll('*')].flatMap((element) => element.getAttributeNames());

describe('renderMarkdown', () => {
  test('ordinary Markdown keeps its headings, lists, https links and code', () => {
    const holder = rendered(
      [
        '# Plan',
        '',
        '## Steps',
        '',
        '- read the spec',
        '- open the pull request',
        '',
        '1. first',
        '2. second',
        '',
        'See [the docs](https://example.com/docs) and `bun test`.',
        '',
        '```ts',
        'const answer = 42;',
        '```'
      ].join('\n')
    );

    expect(holder.querySelector('h1')?.textContent).toBe('Plan');
    expect(holder.querySelector('h2')?.textContent).toBe('Steps');
    expect(holder.querySelectorAll('ul li')).toHaveLength(2);
    expect(holder.querySelectorAll('ol li')).toHaveLength(2);
    expect(holder.querySelector('a')?.getAttribute('href')).toBe('https://example.com/docs');
    expect(holder.querySelector('p code')?.textContent).toBe('bun test');
    expect(holder.querySelector('pre code')?.textContent).toBe('const answer = 42;\n');
  });

  test('an image keeps its source and loses its event handlers', () => {
    const holder = rendered(
      '<img src=x onerror=alert(1)> and <a href="https://example.com" onclick="alert(1)">a link</a>'
    );

    expect(holder.querySelector('img')?.getAttribute('src')).toBe('x');
    expect(attributesOf(holder).filter((name) => name.startsWith('on'))).toEqual([]);
  });

  test('a javascript: link keeps its text and loses its address', () => {
    for (const source of [
      '[click](javascript:alert(1))',
      '<a href="javascript:alert(1)">click</a>'
    ]) {
      const holder = rendered(source);
      expect(holder.textContent).toContain('click');
      expect(holder.innerHTML).not.toContain('javascript:');
    }
  });

  test('scripts, frames, forms and their fields are dropped', () => {
    const holder = rendered(
      [
        '<script>alert(1)</script>',
        '<iframe src="https://example.com"></iframe>',
        '<form action="https://example.com"><input name="token"><button>Send</button></form>',
        '<style>body { display: none }</style>'
      ].join('\n')
    );

    expect(holder.querySelectorAll('script, iframe, form, input, button, style')).toHaveLength(0);
    expect(holder.innerHTML).not.toContain('alert(1)');
  });

  test('inline styles are dropped and the element stays', () => {
    const holder = rendered('<p style="position:fixed;inset:0">covered</p>');

    expect(holder.querySelector('p')?.textContent).toBe('covered');
    expect(attributesOf(holder)).not.toContain('style');
  });
});
