// SPDX-License-Identifier: MIT
// Shared marker-delimited region patcher: `<!-- GENERATED:<name>:start -->...
// <!-- GENERATED:<name>:end -->`. Originally scripts/generate-skill-docs.ts's own local helper
// (MIL-92, docs-generation only); extracted here so a real runtime command — `em slice index`
// (MIL-98) — can reuse the exact same marker convention instead of re-deriving its own regex.
// Pure string in, string (or null) out — no fs access, so both a dev script and a CLI command
// can layer their own file-reading and error reporting on top.

/** Captures the exact start/end marker lines separately from whatever sits between them, so
 *  replacement never depends on how much whitespace happened to separate them before — matters
 *  for a freshly-added, still-empty marker pair (start line immediately followed by end line,
 *  nothing in between to non-greedily match a leading "\n" against). */
export function markerRegex(name: string): RegExp {
  const start = `<!-- GENERATED:${name}:start[^\\n]*-->`;
  const end = `<!-- GENERATED:${name}:end -->`;
  return new RegExp(`(${start})([\\s\\S]*?)(${end})`);
}

/**
 * Replace the body between the named marker pair in `content` with `newBody`, preserving the
 * marker lines themselves verbatim. Returns `null` (never throws) when the marker pair isn't
 * found in `content` — callers decide how to report that: a dev-tooling throw
 * (scripts/generate-skill-docs.ts), or a user-facing CLI error suggesting how to add the
 * markers (`em slice index`, src/cli/sliceIndex.ts).
 */
export function applyMarker(content: string, markerName: string, newBody: string): string | null {
  const re = markerRegex(markerName);
  if (!re.test(content)) return null;
  return content.replace(re, (_m, open, _old, close) => `${open}\n${newBody}\n${close}`);
}
