// Small lexing helpers shared by the line-oriented parser.

/** Remove a trailing `# comment`, ignoring `#` inside double quotes. */
export function stripComment(line: string): string {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === "#" && !inQuote) return line.slice(0, i);
  }
  return line;
}

/** Strip a single pair of surrounding double quotes, if present. */
export function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1);
  }
  return t;
}

/** Split a comma-separated list, honouring quotes, returning trimmed unquoted items. */
export function splitQuotedList(s: string): string[] {
  const items: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      inQuote = !inQuote;
      cur += c;
    } else if (c === "," && !inQuote) {
      items.push(unquote(cur));
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim().length > 0) items.push(unquote(cur));
  return items.filter((x) => x.length > 0);
}
