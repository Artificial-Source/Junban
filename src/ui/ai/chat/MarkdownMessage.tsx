/**
 * Safe assistant Markdown — react-markdown + remark-gfm, skipHtml, no raw HTML.
 */
import { memo, useCallback, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react";

const TASK_LINK_RE =
  /^#([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const JUNBAN_TASK_RE =
  /^junban:\/\/task\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function safeUrlTransform(url: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (/^mailto:/i.test(url)) return url;
  if (TASK_LINK_RE.test(url)) return url;
  if (JUNBAN_TASK_RE.test(url)) return url;
  // Block javascript:, data:, and other schemes.
  return "";
}

function extractTextFromChildren(children: ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (!children) return "";
  if (Array.isArray(children)) return children.map(extractTextFromChildren).join("");
  if (typeof children === "object" && children !== null && "props" in children) {
    return extractTextFromChildren(
      (children as { props?: { children?: ReactNode } }).props?.children,
    );
  }
  return "";
}

function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="absolute top-2 right-2 p-1 rounded-md bg-surface-secondary/80 text-on-surface-muted hover:text-on-surface hover:bg-surface-secondary opacity-0 group-hover/code:opacity-100 transition-colors"
      title="Copy code"
      aria-label="Copy code"
    >
      {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
    </button>
  );
}

function CollapsibleDetails({ children, summary }: { children: ReactNode; summary: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-2 border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-3 py-2 text-sm font-medium text-on-surface-secondary bg-surface-secondary/50 hover:bg-surface-secondary transition-colors text-left"
      >
        {open ? (
          <ChevronDown size={14} aria-hidden="true" />
        ) : (
          <ChevronRight size={14} aria-hidden="true" />
        )}
        {summary}
      </button>
      {open && <div className="px-3 py-2 text-sm">{children}</div>}
    </div>
  );
}

function createMarkdownComponents(onSelectTask?: (taskId: string) => void): Components {
  return {
    p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
    ol: ({ children }) => (
      <ol className="mb-3 ml-5 list-decimal space-y-1 last:mb-0">{children}</ol>
    ),
    ul: ({ children }) => <ul className="mb-3 ml-5 list-disc space-y-1 last:mb-0">{children}</ul>,
    li: ({ children }) => <li className="pl-1">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    h1: ({ children }) => <h1 className="text-lg font-bold mb-2 mt-3 first:mt-0">{children}</h1>,
    h2: ({ children }) => <h2 className="text-base font-bold mb-2 mt-3 first:mt-0">{children}</h2>,
    h3: ({ children }) => <h3 className="text-sm font-bold mb-1.5 mt-2 first:mt-0">{children}</h3>,
    hr: () => <hr className="my-3 border-border" />,
    blockquote: ({ children }) => (
      <blockquote className="border-l-3 border-accent-action/40 pl-3 my-2 text-on-surface-secondary italic">
        {children}
      </blockquote>
    ),
    pre: ({ children }) => {
      const codeText = extractTextFromChildren(children);
      return (
        <div className="relative group/code my-2">
          <pre className="rounded-lg bg-surface/70 px-3 py-2 font-mono text-xs overflow-x-auto">
            {children}
          </pre>
          {codeText ? <CopyCodeButton code={codeText} /> : null}
        </div>
      );
    },
    code: ({ children, className, ...props }) => {
      if (className) {
        return (
          <code {...props} className={`${className} font-mono text-xs`}>
            {children}
          </code>
        );
      }
      return (
        <code {...props} className="rounded bg-surface/70 px-1 py-0.5 font-mono text-xs">
          {children}
        </code>
      );
    },
    table: ({ children }) => (
      <div className="overflow-x-auto my-2 rounded-lg border border-border">
        <table className="w-full text-xs">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-surface-secondary">{children}</thead>,
    th: ({ children }) => (
      <th className="px-3 py-2 text-left font-semibold border-b border-border text-on-surface">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="px-3 py-1.5 border-b border-border/50 text-on-surface-secondary">
        {children}
      </td>
    ),
    details: ({ children }) => {
      const childArray = Array.isArray(children) ? children : [children];
      const summaryChild = childArray.find(
        (c) => typeof c === "object" && c !== null && "type" in c && c.type === "summary",
      );
      const rest = childArray.filter((c) => c !== summaryChild);
      return <CollapsibleDetails summary={summaryChild || "Details"}>{rest}</CollapsibleDetails>;
    },
    a: ({ href, children, ...props }) => {
      const junban = href ? JUNBAN_TASK_RE.exec(href) : null;
      const hashTask = href ? TASK_LINK_RE.exec(href) : null;
      const taskId = junban?.[1] ?? hashTask?.[1];
      if (taskId && onSelectTask) {
        return (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              onSelectTask(taskId);
            }}
            className="text-accent-foreground underline underline-offset-2 cursor-pointer"
          >
            {children}
          </button>
        );
      }
      if (!href) {
        return <span className="text-accent-foreground">{children}</span>;
      }
      return (
        <a
          {...props}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-foreground underline underline-offset-2"
        >
          {children}
        </a>
      );
    },
  };
}

export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  onSelectTask,
}: {
  content: string;
  onSelectTask?: (taskId: string) => void;
}) {
  const components = createMarkdownComponents(onSelectTask);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={components}
      skipHtml
      urlTransform={safeUrlTransform}
      disallowedElements={["script", "iframe", "object", "embed", "form"]}
      unwrapDisallowed
    >
      {content}
    </ReactMarkdown>
  );
});
