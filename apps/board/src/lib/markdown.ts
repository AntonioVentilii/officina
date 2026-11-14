import DOMPurify from 'dompurify';
import { marked } from 'marked';

/** Agent-written text is data: rendered as Markdown, then sanitized before the board draws it. */
export const renderMarkdown = (source: string): string =>
  DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true, breaks: false }), {
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'],
    FORBID_ATTR: ['style']
  });
