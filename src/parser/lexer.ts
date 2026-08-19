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

/** Index of the first (or last) unquoted occurrence of the single character `ch` in
 *  `s` — one not inside a well-formed `"..."` span. A *closed* quoted span is
 *  skipped whole (escapes honoured throughout), so a literal `ch` written inside a
 *  properly-quoted string is invisible to this scan. A `"` that never finds its
 *  close is, by construction, not really opening a string at all — free-text
 *  element names carry no quoting convention of their own, so an incidental bare
 *  `"` (an inch mark, a scare quote) is just a character, not a lexing signal, and
 *  must not swallow whatever syntax follows it on the line. (A *genuinely*
 *  unterminated clause string, e.g. `issue "foo`, is instead caught precisely at
 *  its own extraction site — see `extractQuotedClause`/`hasUnterminatedQuote` in
 *  parser.ts — which knows it's looking at a real clause, not stray free text.)
 *  Returns -1 if `ch` never occurs outside a (closed) string. */
function scanUnquoted(s: string, ch: string, last: boolean): number {
  let result = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"') {
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

/** Remove a trailing `# comment`, ignoring `#` inside a well-formed pair of double
 *  quotes. A `"` with no matching close isn't treated as opening a string (same
 *  reasoning as `scanUnquoted` above) — a comment after a stray bare `"` still gets
 *  stripped. */
export function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
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
