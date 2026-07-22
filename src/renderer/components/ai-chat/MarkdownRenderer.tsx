/**
 * Markdown renderer for assistant messages in the Cursor-style chat UI.
 * Wraps react-markdown with shiki syntax highlighting for code blocks.
 */

import { memo, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { codeToHtml } from 'shiki';
import { cn } from '@/lib/utils';

/** Cache shiki highlighting promises to avoid re-highlighting identical code blocks. */
const highlightCache = new Map<string, Promise<string>>();

async function highlightCode(code: string, lang: string): Promise<string> {
  const key = `${lang}:${code}`;
  let promise = highlightCache.get(key);
  if (!promise) {
    promise = codeToHtml(code, {
      lang: lang || 'text',
      theme: 'vitesse-dark',
    });
    highlightCache.set(key, promise);
  }
  return promise;
}

interface CodeBlockProps {
  language: string;
  code: string;
  className?: string;
}

function CodeBlock({ language, code, className }: CodeBlockProps) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    highlightCode(code, language).then((result) => {
      if (!cancelled) setHtml(result);
    });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  if (!html) {
    return (
      <pre
        className={cn(
          'my-3 overflow-x-auto rounded-md border border-border bg-card p-3 text-sm',
          className
        )}
      >
        <code className="font-mono text-foreground">{code}</code>
      </pre>
    );
  }

  return (
    <div
      className={cn('my-3 overflow-x-auto rounded-md border border-border text-sm', className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is trusted
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  className,
}: MarkdownRendererProps) {
  return (
    <div className={cn('prose prose-invert max-w-none text-sm', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          code({ className: codeClassName, children, ...props }) {
            const match = /language-(\w+)/.exec(codeClassName ?? '');
            const language = match?.[1] ?? '';
            const code = String(children).replace(/\n$/, '');
            // Inline code (no language, short) renders as inline span
            if (!language && !code.includes('\n')) {
              return (
                <code
                  className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground"
                  {...props}
                >
                  {code}
                </code>
              );
            }
            return <CodeBlock language={language} code={code} />;
          },
          pre({ children }) {
            // Let the code component handle rendering; skip default pre wrapper
            return <>{children}</>;
          },
          a({ href, children }) {
            return (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-2 hover:text-primary/80"
              >
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
