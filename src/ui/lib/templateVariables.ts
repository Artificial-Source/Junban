/**
 * Extract unique `{{name}}` placeholders from template title/description text.
 * Order follows first appearance across the provided strings. Repeated names
 * collapse to one entry so the apply UI shows a single labeled input.
 */
const TEMPLATE_VARIABLE_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function extractTemplateVariables(...texts: Array<string | null | undefined>): string[] {
  const names: string[] = [];
  const seen = new Set<string>();

  for (const text of texts) {
    if (!text) continue;
    TEMPLATE_VARIABLE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TEMPLATE_VARIABLE_RE.exec(text)) !== null) {
      const name = match[1]?.trim() ?? "";
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }

  return names;
}
