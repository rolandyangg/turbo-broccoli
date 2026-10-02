import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownPreview } from '../src/components/MarkdownPreview.tsx';

const render = (text: string) => renderToStaticMarkup(createElement(MarkdownPreview, { text }));

describe('saved PR Markdown preview', () => {
  it('renders headings, lists, code, and links', () => {
    const html = render('## Summary\n\n**Fixed** navigation.\n\n- Updated `nav.css`\n\n[PR](https://github.com/example/app/pull/1)');
    expect(html).toContain('<h2>Summary</h2>');
    expect(html).toContain('<strong>Fixed</strong>');
    expect(html).toContain('<li>Updated <code>nav.css</code></li>');
    expect(html).toContain('target="_blank"');
  });

  it('renders generated evidence tables and expandable reproduction steps', () => {
    const html = render('| Before | After |\n|---|---|\n| <img src="https://github.com/user-attachments/assets/before" width="420" alt="Before"> | — |\n\n<details><summary>Reproduction steps</summary>\n\n1. Open navigation\n\n</details>');
    expect(html).toContain('<table>');
    expect(html).toContain('alt="Before"');
    expect(html).toContain('<details><summary>Reproduction steps</summary>');
    expect(html).toContain('<li>Open navigation</li>');
  });

  it('removes executable HTML and unsafe links', () => {
    const html = render('<script>alert(1)</script>\n\n<img src="https://example.com/a.png" onerror="alert(1)">\n\n[unsafe](javascript:alert)');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
  });
});
