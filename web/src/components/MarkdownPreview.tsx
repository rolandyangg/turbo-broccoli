import { useState } from 'react';
import { CopyButton, Tabs } from './ui.tsx';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize from 'rehype-sanitize';

/** GitHub-style Markdown, including the generated evidence tables and disclosure sections. */
export function MarkdownPreview({ text }: { text: string }) {
  return (
    <div className="markdown-preview">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeRaw, rehypeSanitize]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          img: ({ node: _node, ...props }) => <img {...props} loading="lazy" />,
          table: ({ node: _node, ...props }) => <div className="markdown-table"><table {...props} /></div>,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

/** Switch between a readable preview and the exact saved Markdown source. */
export function MarkdownDescription({ text }: { text: string }) {
  const [view, setView] = useState<'preview' | 'raw'>('raw');
  return (
    <div style={{ marginTop: 14 }}>
      <div className="spread" style={{ gap: 8, flexWrap: 'wrap' }}>
        <Tabs tabs={[{ id: 'raw', label: 'Raw' }, { id: 'preview', label: 'Preview' }]} value={view} onChange={setView} />
        <CopyButton text={text} label="Copy Markdown" />
      </div>
      {view === 'preview' ? <MarkdownPreview text={text} /> : (
        <pre className="code" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginBottom: 0 }}>{text}</pre>
      )}
    </div>
  );
}
