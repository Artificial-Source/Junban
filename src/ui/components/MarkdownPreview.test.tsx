import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownPreview } from "../components/MarkdownPreview";

describe("MarkdownPreview XSS policy", () => {
  it("renders safe markdown", () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content="# Hello\n\n**bold** text" />);
    expect(markup).toContain("Hello");
    expect(markup).toContain("bold");
  });

  it("skips raw HTML (skipHtml)", () => {
    const markup = renderToStaticMarkup(
      <MarkdownPreview content="<script>alert('xss')</script>\n\ntext" />,
    );
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("alert");
  });

  it("does not render iframe tags", () => {
    const markup = renderToStaticMarkup(
      <MarkdownPreview content='<iframe src="evil.com"></iframe>\n\ntext' />,
    );
    expect(markup).not.toContain("<iframe");
  });

  it("blocks javascript: URLs", () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content="[click](javascript:alert(1))" />);
    expect(markup).not.toContain("javascript:alert");
  });

  it("allows http and https links", () => {
    const markup = renderToStaticMarkup(<MarkdownPreview content="[link](https://example.com)" />);
    expect(markup).toContain("https://example.com");
  });
});
