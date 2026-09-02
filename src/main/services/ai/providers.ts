/** Remove an optional Markdown fence from a Pi one-shot completion. */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```\w*\s*[\r\n]+([\s\S]*?)[\r\n]+\s*```\s*$/);
  if (fenced) return fenced[1].trim();
  return trimmed
    .replace(/^```\w*\s*[\r\n]*/, '')
    .replace(/[\r\n]*\s*```\s*$/, '')
    .trim();
}
