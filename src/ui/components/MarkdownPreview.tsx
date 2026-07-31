/**
 * Safe Markdown preview using react-markdown + remark-gfm.
 * Skips raw HTML (skipHtml), no rehype-raw, uses the library's safe default URL transform,
 * plus one strict transform for valid internal Junban task UUID links.
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownPreviewProps {
  content: string;
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

export function MarkdownPreview({ content }: MarkdownPreviewProps) {
  return (
    <div className="prose prose-sm max-w-none text-on-surface [&_a]:text-accent-foreground [&_a]:underline [&_code]:rounded [&_code]:bg-surface-tertiary [&_code]:px-1 [&_h2:first-child]:mt-0 [&>*:last-child]:mb-0 [&_ol]:list-decimal [&_pre]:rounded-lg [&_pre]:bg-surface-tertiary [&_pre]:p-2 [&_ul]:list-disc">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
