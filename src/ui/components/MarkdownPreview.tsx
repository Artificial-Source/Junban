/**
 * Safe Markdown preview using react-markdown + remark-gfm.
 * Skips raw HTML (skipHtml), no rehype-raw, uses the library's safe default URL transform,
 * plus one strict transform for valid internal Junban task UUID links.
 */
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownPreviewProps {
  content: string;
  legacyTaskDetailSpacing?: boolean;
}

const TASK_LINK_RE =
  /^#([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function safeUrlTransform(url: string): string | null {
  // Allow only http, https, mailto, and internal task links.
  if (/^https?:\/\//i.test(url)) return url;
  if (/^mailto:/i.test(url)) return url;
  if (TASK_LINK_RE.test(url)) return `/tasks/${TASK_LINK_RE.exec(url)?.[1]}`;
  // Block javascript:, data:, and all other schemes.
  return null;
}

const LEGACY_TASK_DETAIL_COMPONENTS: Components = {
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  ol: ({ children }) => <ol className="mb-3 ml-5 list-decimal space-y-1 last:mb-0">{children}</ol>,
  ul: ({ children }) => <ul className="mb-3 ml-5 list-disc space-y-1 last:mb-0">{children}</ul>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  h1: ({ children }) => <h1 className="mt-3 mb-2 text-lg font-bold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-2 text-base font-bold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2 mb-1.5 text-sm font-bold first:mt-0">{children}</h3>,
  hr: () => <hr className="my-3 border-border" />,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-3 border-accent-action/40 pl-3 text-on-surface-secondary italic">
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg bg-surface/70 px-3 py-2 font-mono text-xs">
      {children}
    </pre>
  ),
  code: ({ children, className, ...props }) => (
    <code
      {...props}
      className={
        className
          ? `${className} font-mono text-xs`
          : "rounded bg-surface/70 px-1 py-0.5 font-mono text-xs"
      }
    >
      {children}
    </code>
  ),
  a: ({ children, ...props }) => (
    <a
      {...props}
      className="text-accent-foreground underline underline-offset-2"
      target="_blank"
      rel="noreferrer noopener"
    >
      {children}
    </a>
  ),
};

export function MarkdownPreview({
  content,
  legacyTaskDetailSpacing = false,
}: MarkdownPreviewProps) {
  return (
    <div
      className={
        legacyTaskDetailSpacing
          ? "max-w-none text-on-surface"
          : "prose prose-sm max-w-none text-on-surface [&_a]:text-accent-foreground [&_a]:underline [&_code]:rounded [&_code]:bg-surface-tertiary [&_code]:px-1 [&_h2:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ol]:list-decimal [&_pre]:rounded-lg [&_pre]:bg-surface-tertiary [&_pre]:p-2 [&_ul]:list-disc"
      }
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={legacyTaskDetailSpacing ? LEGACY_TASK_DETAIL_COMPONENTS : undefined}
        skipHtml
        urlTransform={safeUrlTransform}
        disallowedElements={["script", "iframe", "object", "embed", "form"]}
        unwrapDisallowed
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
