// SPDX-License-Identifier: MIT
// The engagement file (MIL-268, R24/R25): `<modelDir>/engagements/<slug>.md` — YAML frontmatter
// carrying the engagement's data (`engagementSchemaVersion`, `slug`, `created`, `createdBy`,
// `parallel`, `status`, `slices[]`) plus a body whose Ledger table is DERIVED from that
// frontmatter and lives inside a `<!-- GENERATED:em-engagement-ledger:start -->` … `:end -->`
// marker region (MIL-266's generated-region convention).
//
// Write discipline (same as `frontmatterSurgery.ts`/`em slice sync`): the file is never parsed
// and re-serialized. `new` writes the whole file once; every later write (`set`, `close`) is a
// splice — one `slices:` entry line, the `status:` line, or the Ledger region — copying every
// other byte through verbatim and keeping the file's own line ending. That is why each slice
// entry is written as a ONE-LINE flow mapping with JSON-quoted strings: one entry = one line =
// one splice, and the line is valid YAML whatever a branch name or PR URL contains.
//
// Pure string functions, plus `readOpenEngagements` (the one fs read `em status` needs).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { locateFrontmatterInner, fieldLineRegex } from "./frontmatterSurgery.js";
import { markerPair, markerRegex } from "../util/markers.js";
import { ENGAGEMENT_SCHEMA_VERSION } from "../emit/engagementJson.js";

/** The Ledger states (R23), in lifecycle order. Any state is settable; `merged` is terminal. */
export const LEDGER_STATES = ["planned", "building", "validating", "review", "awaiting-merge", "merged", "held", "gap"] as const;
export type LedgerState = (typeof LEDGER_STATES)[number];

export function isLedgerState(value: string): value is LedgerState {
  return (LEDGER_STATES as readonly string[]).includes(value);
}

export const ENGAGEMENTS_DIR = "engagements";
export const LEDGER_MARKER = "em-engagement-ledger";
/** Same kebab grammar as a slice export key — the slug is a filename stem. */
export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface EngagementSliceEntry {
  key: string;
  state: LedgerState;
  branch: string | null;
  base: string | null;
  pr: string | null;
  /** R23: present (always `"human"`) only while `state` is `held` via `em engagement set`. */
  heldBy?: "human";
}

export interface EngagementFile {
  engagementSchemaVersion: string;
  slug: string;
  /** The model file's path relative to the engagement file (`/`-separated, e.g. `../checkout.em`). */
  model: string;
  created: string;
  createdBy: string | null;
  parallel: number;
  status: "open" | "closed";
  slices: EngagementSliceEntry[];
}

/** `<modelDir>/engagements/<slug>.md`, built from the model path as given (never absolutized —
 *  it is echoed into JSON output). */
export function engagementPath(modelFile: string, slug: string): string {
  return join(dirname(modelFile), ENGAGEMENTS_DIR, `${slug}.md`);
}

/** The file's dominant line ending — CRLF if it contains any, else LF. */
export function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

const q = (s: string | null): string => (s === null ? "null" : JSON.stringify(s));

/** One `slices:` entry as its single frontmatter line (no EOL). Key order is fixed. */
export function formatSliceEntryLine(e: EngagementSliceEntry): string {
  const held = e.heldBy ? `, heldBy: ${e.heldBy}` : "";
  return `  - {key: ${e.key}, state: ${e.state}, branch: ${q(e.branch)}, base: ${q(e.base)}, pr: ${q(e.pr)}${held}}`;
}

/** Escape a markdown table cell (backslash first, then `|`, newlines flattened) — the same rule
 *  `em slice index`'s table uses. */
function escapeCell(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** One Ledger row's derived facts that do not live in the file (the model's pattern, the slice
 *  doc's current status). */
export interface LedgerRowFacts {
  pattern: string;
  docStatus: string | null;
}

/** The Ledger table lines (header + one row per slice, file order) — the body of the
 *  generated region. Every cell comes from the frontmatter entry or the model/doc facts. */
export function buildLedgerLines(slices: EngagementSliceEntry[], facts: Map<string, LedgerRowFacts>): string[] {
  const cell = (v: string | null) => (v === null ? "—" : escapeCell(v));
  const lines = ["| Slice | Pattern | Doc status | State | Branch | Base | PR |", "|---|---|---|---|---|---|---|"];
  for (const e of slices) {
    const f = facts.get(e.key);
    const state = e.state === "held" && e.heldBy ? `held (${e.heldBy})` : e.state;
    lines.push(
      `| \`${e.key}\` | ${cell(f?.pattern ?? null)} | ${cell(f?.docStatus ?? null)} | ${state} | ${cell(e.branch)} | ${cell(e.base)} | ${cell(e.pr)} |`,
    );
  }
  return lines;
}

/** The whole file `em engagement new` writes (LF). */
export function renderEngagementFile(fm: EngagementFile, ledgerLines: string[]): string {
  const { start, end } = markerPair(LEDGER_MARKER);
  const lines = [
    "---",
    `engagementSchemaVersion: "${fm.engagementSchemaVersion}"`,
    `slug: ${fm.slug}`,
    `model: ${q(fm.model)}`,
    `created: ${fm.created}`,
    `createdBy: ${q(fm.createdBy)}`,
    `parallel: ${fm.parallel}`,
    `status: ${fm.status}`,
    "slices:",
    ...fm.slices.map(formatSliceEntryLine),
    "---",
    `# Engagement: ${fm.slug}`,
    "",
    "Written by `em engagement new` and updated only by `em engagement set` / `em engagement close` —",
    "never hand-edit the frontmatter `slices:` entries or the Ledger table (see docs/engagement-schema.md).",
    "",
    "## Ledger",
    "",
    start,
    ...ledgerLines,
    end,
    "",
  ];
  return lines.join("\n");
}

export type ParseResult = { ok: true; file: EngagementFile } | { ok: false; message: string };

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Read the frontmatter (read-only — writes never go through this). Strict on the fields every
 *  command relies on; the message is appended to the caller's `em engagement <verb>: ` prefix. */
export function parseEngagementFile(text: string): ParseResult {
  const loc = locateFrontmatterInner(text);
  if (!loc) return { ok: false, message: "no frontmatter (expected a leading --- fence)" };
  let data: unknown;
  try {
    data = parseYaml(text.slice(loc.innerStart, loc.innerEnd));
  } catch (e) {
    return { ok: false, message: `frontmatter is not valid YAML (${(e as Error).message.split("\n")[0]})` };
  }
  if (!data || typeof data !== "object") return { ok: false, message: "frontmatter is not a mapping" };
  const d = data as Record<string, unknown>;
  const version = str(d.engagementSchemaVersion);
  if (version !== ENGAGEMENT_SCHEMA_VERSION) {
    return { ok: false, message: `unsupported engagementSchemaVersion "${version ?? "(missing)"}" (this em reads "${ENGAGEMENT_SCHEMA_VERSION}")` };
  }
  const model = str(d.model);
  if (!model) return { ok: false, message: "model must name the model file (path relative to the engagement file)" };
  const status = str(d.status);
  if (status !== "open" && status !== "closed") return { ok: false, message: `status must be open or closed, got "${status ?? "(missing)"}"` };
  const parallel = Number(d.parallel);
  if (!Number.isInteger(parallel) || parallel < 1) return { ok: false, message: "parallel must be a positive integer" };
  if (!Array.isArray(d.slices)) return { ok: false, message: "slices must be a list" };
  const slices: EngagementSliceEntry[] = [];
  for (const raw of d.slices) {
    if (!raw || typeof raw !== "object") return { ok: false, message: "every slices entry must be a mapping" };
    const r = raw as Record<string, unknown>;
    const key = str(r.key);
    const state = str(r.state);
    if (!key) return { ok: false, message: "a slices entry has no key" };
    if (!state || !isLedgerState(state)) return { ok: false, message: `slice "${key}" has an unknown state "${state ?? "(missing)"}"` };
    const entry: EngagementSliceEntry = { key, state, branch: str(r.branch), base: str(r.base), pr: str(r.pr) };
    if (r.heldBy === "human") entry.heldBy = "human";
    slices.push(entry);
  }
  return {
    ok: true,
    file: {
      engagementSchemaVersion: version,
      slug: str(d.slug) ?? "",
      model,
      created: str(d.created) ?? "",
      createdBy: str(d.createdBy),
      parallel,
      status,
      slices,
    },
  };
}

/** Replace slice `key`'s one entry line in the frontmatter, keeping its EOL. Null when the line
 *  is not found (the file was hand-edited out of the one-line shape). */
export function spliceSliceEntry(text: string, entry: EngagementSliceEntry): string | null {
  const loc = locateFrontmatterInner(text);
  if (!loc) return null;
  const inner = text.slice(loc.innerStart, loc.innerEnd);
  const escaped = entry.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^[ \\t]*- \\{key: ${escaped},[^\\r\\n]*`, "m");
  if (!re.test(inner)) return null;
  const next = inner.replace(re, formatSliceEntryLine(entry));
  return text.slice(0, loc.innerStart) + next + text.slice(loc.innerEnd);
}

/** Replace the frontmatter `status:` value. Null when the line is not found. */
export function spliceStatus(text: string, status: "open" | "closed"): string | null {
  const loc = locateFrontmatterInner(text);
  if (!loc) return null;
  const inner = text.slice(loc.innerStart, loc.innerEnd);
  const re = fieldLineRegex("status");
  if (!re.test(inner)) return null;
  const next = inner.replace(re, (_m, prefix: string) => `${prefix}${status}`);
  return text.slice(0, loc.innerStart) + next + text.slice(loc.innerEnd);
}

/** Regenerate the Ledger region's body in the file's own EOL. Null when the marker pair is
 *  missing. */
export function spliceLedger(text: string, ledgerLines: string[]): string | null {
  const re = markerRegex(LEDGER_MARKER);
  if (!re.test(text)) return null;
  const eol = detectEol(text);
  return text.replace(re, (_m, open: string, _old: string, close: string) => `${open}${eol}${ledgerLines.join(eol)}${eol}${close}`);
}

/** MIL-268 `em status` line: the open engagements beside each input model (one scan per
 *  distinct model directory), slugs sorted. Unreadable or unparseable files are skipped — `em
 *  status` reports, it does not lint (`em engagement status` names the problem). */
export function readOpenEngagements(modelFiles: string[]): { open: number; slugs: string[] } {
  const slugs: string[] = [];
  const seen = new Set<string>();
  for (const file of modelFiles) {
    const dir = join(dirname(file), ENGAGEMENTS_DIR);
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      let text: string;
      try {
        text = readFileSync(join(dir, name), "utf8");
      } catch {
        continue;
      }
      const parsed = parseEngagementFile(text);
      // Only engagements belonging to one of the input models (a directory may hold several).
      if (parsed.ok && parsed.file.status === "open" && modelFiles.some((f) => belongsTo(join(dir, name), parsed.file, f))) {
        slugs.push(name.replace(/\.md$/, ""));
      }
    }
  }
  slugs.sort();
  return { open: slugs.length, slugs };
}

export type LoadResult = { ok: true; path: string; text: string; file: EngagementFile } | { ok: false; message: string };

/** Read + parse `<modelDir>/engagements/<slug>.md`; the message completes `em engagement <verb>: `. */
export function loadEngagement(modelFile: string, slug: string): LoadResult {
  if (!SLUG_RE.test(slug)) return { ok: false, message: `invalid slug "${slug}" — expected kebab-case (a-z, 0-9, -)` };
  const path = engagementPath(modelFile, slug);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { ok: false, message: `no engagement "${slug}" (expected ${path})` };
  }
  const parsed = parseEngagementFile(text);
  if (!parsed.ok) return { ok: false, message: `${path}: ${parsed.message}` };
  if (!belongsTo(path, parsed.file, modelFile)) {
    return { ok: false, message: `${path} belongs to ${parsed.file.model}, not ${modelFile}` };
  }
  return { ok: true, path, text, file: parsed.file };
}

/** `model:` for a new engagement file: the model's path relative to the file, `/`-separated. */
export function modelRefFor(engagementFile: string, modelFile: string): string {
  return relative(dirname(resolve(engagementFile)), resolve(modelFile)).split(sep).join("/");
}

/** Does the engagement file at `path` belong to `modelFile` (its `model:` resolves to it)? */
export function belongsTo(path: string, eng: EngagementFile, modelFile: string): boolean {
  return resolve(dirname(path), eng.model) === resolve(modelFile);
}
