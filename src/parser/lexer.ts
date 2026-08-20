// SPDX-License-Identifier: MIT
// Small lexing helpers shared by the line-oriented parser.
//
// All quote-awareness below shares one escape convention: inside a double-quoted
// string, `\"` is a literal quote (doesn't end the string) and `\\` is a literal
// backslash — no other `\x` sequence is special, so e.g. `C:\path` round-trips
// untouched. Everything else between an opening and closing `"` — including `{`,
// `}`, and `#` — is inert literal content, never re-interpreted as syntax.

/** Advance past an escape (`\` + next char) starting at `i`, if one starts there.
 *  Returns the index to resume scanning from, or `i` if there's no escape here. A
 *  trailing lone `\` (nothing left to escape) still advances to end-of-string —
 *  never returns `i` unchanged for a `\`, or callers scanning in a `while (i <
 *  s.length)` loop spin forever on it. */
function skipEscape(s: string, i: number): number {
  return s[i] === "\\" ? Math.min(i + 2, s.length) : i;
}

/** Index of `ch`'s matching closing `"`, scanning from just after the opening `"`
 *  at `openIdx`, honouring `\"`/`\\` escapes. Returns -1 if unterminated. */
export function matchQuote(s: string, openIdx: number): number {
  for (let i = openIdx + 1; i < s.length; ) {
    if (s[i] === "\\") {
      i = skipEscape(s, i);
      continue;
    }
    if (s[i] === '"') return i;
    i++;
  }
  return -1;
}

/** Keywords after which a `"` is grammar-legitimate as the start of a quoted
 *  string: a declaration's name (`model "Name"`, `slice "Name"`, `type "Name"`)
 *  or a clause's value (`note`/`issue`/`divergence`/`from`/`source`/`external "..."`).
 *  `external` (MIL-66) is here so a `#`/`{`/`}` inside a `tag X external "..."` description is
 *  inert string content, never mistaken for a comment or block boundary (same MIL-122 discipline
 *  every other quoted clause value gets). */
const QUOTE_OPENER_KEYWORDS =
  /(?:^|\s)(?:model|slice|type|note|issue|divergence|from|source|external)$/i;

/** True if the `"` at `s[i]` is grammar-legitimate as the START of a quoted
 *  string — the very first character of `s`, immediately after one of
 *  `QUOTE_OPENER_KEYWORDS` (`keyword "value"`), or immediately after a
 *  list-item comma (`from "A", "B"`). Any other `"` — an inch mark, a scare
 *  quote inside otherwise-unquoted free text — is just a character, never a
 *  quote-opener: free-text element names carry no quoting convention of their
 *  own, and treating every bare `"` as an opener let two *independently* stray
 *  quotes accidentally pair with *each other*, silently swallowing a real
 *  field block or comment between them (MIL-122 follow-up). A quote that fails
 *  this check can still validly serve as some other span's *closing* quote —
 *  only opens are anchored, `matchQuote` finds the close unconditionally. */
function isQuoteOpener(s: string, i: number): boolean {
  if (s[i] !== '"') return false;
  if (i === 0) return true;
  const before = s.slice(0, i).replace(/\s+$/, "");
  return before.endsWith(",") || QUOTE_OPENER_KEYWORDS.test(before);
}

/** Index of the first (or last) unquoted occurrence of the single character `ch` in
 *  `s` — one not inside a grammar-anchored `"..."` span (see `isQuoteOpener`).
 *  A span is skipped whole once opened (escapes honoured throughout), so a
 *  literal `ch` written inside it is invisible to this scan. Returns -1 if `ch`
 *  never occurs outside such a span. */
function scanUnquoted(s: string, ch: string, last: boolean): number {
  let result = -1;
  for (let i = 0; i < s.length; i++) {
    if (isQuoteOpener(s, i)) {
      const close = matchQuote(s, i);
      if (close >= 0) i = close;
      continue;
    }
    if (s[i] === ch) {
      if (!last) return i;
      result = i;
    }
  }
  return result;
}

/** First unquoted occurrence of `ch` in `s`, or -1. */
export function indexOfUnquoted(s: string, ch: string): number {
  return scanUnquoted(s, ch, false);
}

/** Last unquoted occurrence of `ch` in `s`, or -1. */
export function lastIndexOfUnquoted(s: string, ch: string): number {
  return scanUnquoted(s, ch, true);
}

/** Decode a quoted string's captured inner text: `\"` -> `"`, `\\` -> `\`. */
export function decodeQuoted(s: string): string {
  return s.replace(/\\(["\\])/g, "$1");
}

/** True if `s` contains a `"` whose string never closes (accounting for escapes). */
export function hasUnterminatedQuote(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') {
      const close = matchQuote(s, i);
      if (close < 0) return true;
      i = close;
    }
  }
  return false;
}

/** Remove a trailing `# comment`, ignoring `#` inside a grammar-anchored `"..."`
 *  span (see `isQuoteOpener`) — a stray, unopened bare `"` doesn't hide a `#`
 *  that follows it. */
export function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (isQuoteOpener(line, i)) {
      const close = matchQuote(line, i);
      if (close >= 0) i = close;
      continue;
    }
    if (line[i] === "#") return line.slice(0, i);
  }
  return line;
}

/** Strip a single pair of surrounding double quotes, if present, decoding any
 *  `\"`/`\\` escapes inside. Text that merely starts with `"` but whose string
 *  never actually closes at the end of `s` is left untouched, unquoted. */
export function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"')) {
    const close = matchQuote(t, 0);
    if (close === t.length - 1) return decodeQuoted(t.slice(1, -1));
  }
  return t;
}

/** Split a comma-separated list, honouring quotes — a comma inside a quoted span is literal, not
 *  a separator — but unlike `splitQuotedList` below, returns each segment's RAW text untrimmed
 *  and unquoted, with the same "one entry per separator, including a trailing empty one" contract
 *  as native `String.split(sep)` (for input with no quotes at all, output is character-for-
 *  character identical to `s.split(sep)`). Used for field specs: `parseInlineFields` needs one
 *  comma-separated span per field, but a field-level clause may itself contain a quoted list with
 *  embedded commas (MIL-68's planned `renamed from "Old1", "Old2"`), which a naive `.split(",")`
 *  would break apart mid-string. */
export function splitTopLevel(s: string, sep: string): string[] {
  const items: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      const close = matchQuote(s, i);
      const end = close >= 0 ? close : s.length - 1;
      cur += s.slice(i, end + 1);
      i = end;
    } else if (c === sep) {
      items.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  items.push(cur);
  return items;
}

/** Split a comma-separated list, honouring quotes, returning trimmed unquoted items. */
export function splitQuotedList(s: string): string[] {
  const items: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      const close = matchQuote(s, i);
      const end = close >= 0 ? close : s.length - 1;
      cur += s.slice(i, end + 1);
      i = end;
    } else if (c === ",") {
      items.push(unquote(cur));
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim().length > 0) items.push(unquote(cur));
  return items.filter((x) => x.length > 0);
}
