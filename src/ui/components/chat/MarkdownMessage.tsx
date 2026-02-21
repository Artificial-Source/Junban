import { useState, useCallback, memo } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, ChevronDown, ChevronRight } from "lucide-react";

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
      urlTransform={(url) => (url.startsWith("saydo://") ? url : defaultUrlTransform(url))}
    >
      {content}
    </ReactMarkdown>
  );
});

function CopyCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [code]);

  return (
    <button
      onClick={handleCopy}
      className="absolute top-2 right-2 p-1 rounded-md bg-surface-secondary/80 text-on-surface-muted hover:text-on-surface hover:bg-surface-secondary opacity-0 group-hover/code:opacity-100 transition-opacity"
      title="Copy code"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function CollapsibleDetails({
  children,
  summary,
}: {
  children: React.ReactNode;
  summary: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="my-2 border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 w-full px-3 py-2 text-sm font-medium text-on-surface-secondary bg-surface-secondary/50 hover:bg-surface-secondary transition-colors text-left"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
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
    h3: ({ children }) => (
      <h3 className="text-sm font-bold mb-1.5 mt-2 first:mt-0">{children}</h3>
    ),
    hr: () => <hr className="my-3 border-border" />,
    blockquote: ({ children }) => (
      <blockquote className="border-l-3 border-accent/40 pl-3 my-2 text-on-surface-secondary italic">
        {children}
      </blockquote>
    ),
    pre: ({ children }) => {
      // Extract text content from the code element inside pre
      const codeText = extractTextFromChildren(children);
      return (
        <div className="relative group/code my-2">
          <pre className="rounded-lg bg-surface/70 px-3 py-2 font-mono text-xs overflow-x-auto">
            {children}
          </pre>
          {codeText && <CopyCodeButton code={codeText} />}
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
      // Split children into summary and the rest
      const childArray = Array.isArray(children) ? children : [children];
      const summaryChild = childArray.find(
        (c) => typeof c === "object" && c !== null && "type" in c && c.type === "summary",
      );
      const rest = childArray.filter((c) => c !== summaryChild);
      return (
        <CollapsibleDetails summary={summaryChild || "Details"}>{rest}</CollapsibleDetails>
      );
    },
    a: ({ href, children, ...props }) => {
      if (href && href.startsWith("saydo://task/") && onSelectTask) {
        const taskId = href.replace("saydo://task/", "");
        return (
          <button
            {...(props as React.ButtonHTMLAttributes<HTMLButtonElement>)}
            onClick={(e) => {
              e.preventDefault();
              onSelectTask(taskId);
            }}
            className="text-accent underline underline-offset-2 cursor-pointer"
          >
            {children}
          </button>
        );
      }
      return (
        <a
          {...props}
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent underline underline-offset-2"
        >
          {children}
        </a>
      );
    },
  };
}

/** Recursively extract text content from React children (for copy button). */
function extractTextFromChildren(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (!children) return "";
  if (Array.isArray(children)) return children.map(extractTextFromChildren).join("");
  if (typeof children === "object" && "props" in children) {
    return extractTextFromChildren((children as React.ReactElement).props.children);
  }
  return "";
}
