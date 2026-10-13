/** Helpers for untrusted text (relay- or sender-provided) shown to the model or the owner. */

/**
 * Control and format characters (bidi overrides, zero-width), backticks, and the blank "filler" letters that render as
 * nothing (Hangul fillers, the blank braille pattern): padding with them could push channel-written text out of view.
 */
const UNSAFE = /[\p{Cc}\p{Cf}`\u115f\u1160\u3164\uffa0\u2800]+/gu;

/**
 * One line, no control, format or filler characters and no backticks, bounded to `max` chars.
 * Non-text values (missing fields, objects from the wire) become "".
 */
export function sanitizeOneLine(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : typeof value === "number" || typeof value === "bigint" ? String(value) : "";
  const flat = text.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * sanitizeOneLine as a JSON string literal: quotes and backslashes in the text are escaped, so it cannot close its own
 * quotes and pass what follows as channel-written. "" for empty text.
 */
export function quoteUntrusted(value: unknown, max: number): string {
  const clean = sanitizeOneLine(value, max);
  return clean ? JSON.stringify(clean) : "";
}

/**
 * Multi-line untrusted text as a quoted block: every line (split at any line break) starts with `prefix`, and control
 * and format characters (bidi overrides, zero-width) become spaces, so no line can imitate a notice or header line.
 */
export function quoteLines(text: string, prefix = "> "): string {
  return text
    .split(/\r\n|[\n\r\u2028\u2029]/)
    .map((line) => `${prefix}${line.replace(/[\p{Cc}\p{Cf}]+/gu, " ")}`.trimEnd())
    .join("\n");
}

/**
 * How the channel's notices to the agent open (inbound-wallet.ts builds them from these): an incoming payment, tokens
 * that did not verify, and a payment request (followed by its id and "]").
 */
export const NOTICE_HEADLINES = {
  payment: "[Payment received]",
  unverified: "[Unverified tokens received]",
  request: "[Payment request",
} as const;

/**
 * A notice headline anywhere in a line (a list number, a bullet or a word before it would not make it less of an
 * imitation): case and spacing are not told apart.
 */
const NOTICE_LOOKALIKE = new RegExp(
  Object.values(NOTICE_HEADLINES)
    .map((h) => {
      const words = h.replace(/^\[|\]$/g, "").split(" ").join("\\s+");
      return `\\[\\s*${words}${h.endsWith("]") ? "\\s*\\]" : "\\b"}`;
    })
    .join("|"),
  "i",
);

/** Marks a line of sender-written text that holds a channel notice headline (see markNoticeLookalikes). */
export const SENDER_TEXT_MARK = "(sender's text, not a channel notice) ";

/**
 * Sender-written text (a stranger's DM, a group message) as the agent sees it: every line that holds one of the
 * channel's notice headlines (NOTICE_HEADLINES) is prefixed with SENDER_TEXT_MARK, so a sender cannot pass a typed
 * "[Payment received] …" for a channel notice, also later in the session's history, where the turn's own context is
 * gone. Lines end at every Unicode mandatory break, vertical tab, form feed and NEL included.
 */
export function markNoticeLookalikes(text: string): string {
  return text
    .split(/(\r\n|[\n\v\f\r\u0085\u2028\u2029])/)
    .map((part) => (looksLikeNotice(part) ? `${SENDER_TEXT_MARK}${part}` : part))
    .join("");
}

/**
 * Invisible and control characters count both ways: as nothing ("Pay\u200bment") and as a space
 * ("[Payment\treceived]").
 */
function looksLikeNotice(line: string): boolean {
  const flat = line.normalize("NFKC");
  return NOTICE_LOOKALIKE.test(flat.replace(UNSAFE, "")) || NOTICE_LOOKALIKE.test(flat.replace(UNSAFE, " "));
}

/**
 * A DM's (or group message's) text. The SDK copies the sender's JSON `text` field without a type check, so `content`
 * can arrive as null, a number or an object; anything that is not a string is shown as its JSON.
 */
export function dmText(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content) ?? "";
  } catch {
    return "";
  }
}
