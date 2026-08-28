// SPDX-License-Identifier: MIT
// Shared marker-delimited region patcher: `<!-- GENERATED:<name>:start -->...
// <!-- GENERATED:<name>:end -->` (or, for a file whose format doesn't support HTML comments,
// `# GENERATED:<name>:start` ... `# GENERATED:<name>:end`). Originally
// scripts/generate-skill-docs.ts's own local helper (MIL-92, docs-generation only); extracted
// here so a real runtime command — `em slice index` (MIL-98) — can reuse the exact same marker
// convention instead of re-deriving its own regex. The `hash` style was added for `em ci init`
// (MIL-166), whose generated files are YAML (no `<!-- -->` comment syntax).
// Pure string in, string (or null) out — no fs access, so both a dev script and a CLI command
// can layer their own file-reading and error reporting on top.

/** Comment syntax the marker lines are written in: `"html"` (`<!-- ... -->`, the default —
 *  Markdown files) or `"hash"` (`# ...`, unterminated — YAML/shell-style files). */
export type MarkerStyle = "html" | "hash";

/** Captures the exact start/end marker lines separately from whatever sits between them, so
 *  replacement never depends on how much whitespace happened to separate them before — matters
 *  for a freshly-added, still-empty marker pair (start line immediately followed by end line,
 *  nothing in between to non-greedily match a leading "\n" against). The `[^\n]*` tail on the
 *  start line lets a caller append trailing prose after `:start` (e.g. em-dsl.md's "-- run `npm
 *  run docs:generate` to refresh, do not hand-edit") without breaking the match. */
export function markerRegex(name: string, style: MarkerStyle = "html"): RegExp {
  const start = style === "hash" ? `# GENERATED:${name}:start[^\\n]*` : `<!-- GENERATED:${name}:start[^\\n]*-->`;
  const end = style === "hash" ? `# GENERATED:${name}:end` : `<!-- GENERATED:${name}:end -->`;
  return new RegExp(`(${start})([\\s\\S]*?)(${end})`);
}

/**
 * Replace the body between the named marker pair in `content` with `newBody`, preserving the
 * marker lines themselves verbatim. Returns `null` (never throws) when the marker pair isn't
 * found in `content` — callers decide how to report that: a dev-tooling throw
 * (scripts/generate-skill-docs.ts), or a user-facing CLI error suggesting how to add the
 * markers (`em slice index`, src/cli/sliceIndex.ts; `em ci init`, src/cli/ciInit.ts).
 */
export function applyMarker(content: string, markerName: string, newBody: string, style: MarkerStyle = "html"): string | null {
  const re = markerRegex(markerName, style);
  if (!re.test(content)) return null;
  return content.replace(re, (_m, open, _old, close) => `${open}\n${newBody}\n${close}`);
}

/** The bare start/end marker lines for `markerName`, for a caller writing a fresh marker pair
 *  from scratch (e.g. `em ci init` creating a brand-new file, or `em ci init --check` reporting
 *  what a from-scratch file would contain). */
export function markerPair(markerName: string, style: MarkerStyle = "html"): { start: string; end: string } {
  return style === "hash"
    ? { start: `# GENERATED:${markerName}:start`, end: `# GENERATED:${markerName}:end` }
    : { start: `<!-- GENERATED:${markerName}:start -->`, end: `<!-- GENERATED:${markerName}:end -->` };
}
