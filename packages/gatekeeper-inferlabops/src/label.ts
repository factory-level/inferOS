/**
 * The text a name shows once control characters become spaces, format characters (zero-width,
 * bidi and other `\p{Cf}`) are removed and whitespace is collapsed; "" when nothing is left.
 * MIRRORS the host's `cleanAttentionLabel` (workshop-backend `src/attention.ts`, before its length
 * cap): both are held to the same case table (`__tests__/attention-label-cases.ts`).
 */
export function visibleName(name: string): string {
  // Char codes rather than a regex: a control character in a regex literal is a lint error.
  return Array.from(name, ch => {
    const code = ch.charCodeAt(0);
    return code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0) ? " " : ch;
  }).join("").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
}
