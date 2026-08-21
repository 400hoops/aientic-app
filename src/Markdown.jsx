import { memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { IconCheck, IconCopy } from "./Icons.jsx";

/**
 * Assistant output: GitHub-flavoured markdown plus LaTeX.
 *
 * Streaming means this re-renders on every token, so the component is
 * memoised on the text and the heavy bits stay out of the render path.
 */

function CodeBlock({ language, code }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {}
  };

  return (
    <div className="my-4 overflow-hidden rounded-xl border border-[var(--border)]">
      <div className="flex items-center justify-between border-b border-[var(--border)]
                      bg-[var(--panel)] px-3 py-1.5">
        <span className="ui-tight text-[11px] uppercase tracking-wide text-[var(--faint)]">
          {language || "code"}
        </span>
        <button
          onClick={copy}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[11.5px] text-[var(--faint)]
                     hover:bg-[var(--hover)] hover:text-[var(--text)]"
        >
          {copied ? (
            <IconCheck className="h-3.5 w-3.5" />
          ) : (
            <IconCopy className="h-3.5 w-3.5" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto bg-[var(--panel-2)] px-3.5 py-3">
        <code className="font-mono text-[12.5px] leading-[1.7] text-[var(--text)]">
          {code}
        </code>
      </pre>
    </div>
  );
}

const components = {
  code({ inline, className, children }) {
    const text = String(children).replace(/\n$/, "");
    const language = /language-(\w+)/.exec(className || "")?.[1];

    // Fenced blocks arrive with a language class or a newline; everything
    // else is inline and stays in the flow of the sentence.
    if (inline || (!language && !text.includes("\n"))) {
      return (
        <code className="rounded bg-[var(--panel-2)] px-1.5 py-0.5 font-mono text-[0.88em]">
          {text}
        </code>
      );
    }
    return <CodeBlock language={language} code={text} />;
  },
  pre: ({ children }) => <>{children}</>,
  p: ({ children }) => <p className="my-3.5 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="mb-3 mt-6 text-[19px] font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-3 mt-6 text-[17px] font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-5 text-[15.5px] font-semibold first:mt-0">{children}</h3>,
  ul: ({ children }) => <ul className="my-3.5 list-disc space-y-1.5 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-3.5 list-decimal space-y-1.5 pl-5">{children}</ol>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-[var(--text)] underline underline-offset-2 decoration-[var(--border-strong)]"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-4 border-l-2 border-[var(--border-strong)] pl-4 text-[var(--muted)]">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-6 border-[var(--border)]" />,
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-xl border border-[var(--border)]">
      <table className="w-full border-collapse text-[14px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-[var(--panel)]">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-[var(--border)] px-3.5 py-2.5 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-[var(--border)] px-3.5 py-2.5 align-top">
      {children}
    </td>
  ),
};

function Markdown({ children }) {
  return (
    <div className="text-[length:var(--fs-body)] leading-[1.72] text-[var(--text)]">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);
