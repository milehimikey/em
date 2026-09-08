// SPDX-License-Identifier: MIT
// The conformance findings record (MIL-214): `conformance/<date>-findings.json`, sibling of that
// same date's `<date>-report.md`. Structured data for facts the report's markdown carried only
// as prose — one entry per `### n.` finding in the report, ids matching. Written directly by the
// conform skill (a dedicated `em conform-findings <model> <report> --add` writer was ruled out —
// too fiddly for an agent mid-run); `em` provides a read-only shape validator
// (`em conform-findings check <path>`, cli.ts) so a headless run can verify what it wrote, plus
// the consumers that read the file back: `em conform-supersede --locus/--by` (records a ruling
// via `applyFindingsRuling`), `em slice conform` (cli/sliceConform.ts — refuses when an in-scope
// finding is still unruled), `em state set-conformance` (refuses/--partial on the same basis,
// model-wide), and `em status` (unruledFindings per model). All four reuse `unruledFindingsInScope`
// below rather than re-deriving "is this finding still blocking" four different ways.
//
// Surface names use reference/conform.md's own vocabulary ("The three conformance surfaces"
// table): `structural` (`.em` <-> code), `spec` (slice doc <-> code), `internal` (slice doc <->
// `.em`) — plus `other` for anything that doesn't fit those three (a run-metadata note, a
// tooling problem, ...).
//
// Deterministic serialization: 2-space indent, keys in a fixed alphabetical order (both at the
// document level and within each finding), entries sorted by `id` ascending, trailing newline —
// this file is written directly to disk (not printed to stdout like every other em JSON
// surface), so it carries its own trailing newline rather than relying on a CLI caller to add
// one. `serializeFindingsDoc` is the ONE write path every producer of this file's bytes must go
// through — never a bare `JSON.stringify`, which would leave key order at the mercy of
// insertion/iteration order and break the "byte-deterministic for identical input" contract
// every em-emitted document holds.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isValidDateString } from "./stateFile.js";

export const FINDINGS_SCHEMA_VERSION = "1.0";

/** reference/conform.md's "The three conformance surfaces" table, plus `other` for anything that
 *  doesn't fit (a run-metadata note, a tooling problem noted in the report's run metadata). */
export const FINDING_SURFACES = ["structural", "spec", "internal", "other"] as const;
export type FindingSurface = (typeof FINDING_SURFACES)[number];

/** Who/what a ruled finding says is wrong — `none` when the finding is Accepted divergence/
 *  Unpropagated delta/Extraction uncertainty and nothing needs to change. Null (not yet ruled)
 *  is the initial state every finding is written in. */
export const FINDING_LOCI = ["model", "doc", "code", "none"] as const;
export type FindingLocus = (typeof FINDING_LOCI)[number];

export interface Finding {
  id: number;
  surface: FindingSurface;
  /** The classification from reference/conform.md step 4 (Real drift, Model gap, Internal
   *  inconsistency, Accepted divergence, Unpropagated delta, Extraction uncertainty) — free text,
   *  not a closed enum here, so the report's own vocabulary is never fought by the JSON's schema. */
  class: string;
  /** The slice this finding concerns, or null for a finding that isn't attributable to one slice
   *  (a whole-model observation, a cross-cutting tooling problem, ...). A null-slice finding
   *  counts as in scope for EVERY slice's unruled-findings check (`unruledFindingsInScope`) —
   *  it's ambiguous which slice(s) it blocks, so it blocks all of them until ruled. */
  slice: string | null;
  evidence: string;
  /** `null` until a human rules on this finding (docs/process.md's "Ruling on conformance
   *  findings") — `em conform-supersede --locus <l> --by <name>` is the one write path. */
  locus: FindingLocus | null;
  resolvedBy: string | null;
  resolvedOn: string | null;
}

export interface FindingsDoc {
  findingsSchemaVersion: string;
  model: string;
  report: string;
  revision: string;
  findings: Finding[];
}

/** Serialize a `FindingsDoc` deterministically — see module header. */
export function serializeFindingsDoc(doc: FindingsDoc): string {
  const sorted = [...doc.findings].sort((a, b) => a.id - b.id);
  const canonical = {
    findings: sorted.map((f) => ({
      class: f.class,
      evidence: f.evidence,
      id: f.id,
      locus: f.locus,
      resolvedBy: f.resolvedBy,
      resolvedOn: f.resolvedOn,
      slice: f.slice,
      surface: f.surface,
    })),
    findingsSchemaVersion: doc.findingsSchemaVersion,
    model: doc.model,
    report: doc.report,
    revision: doc.revision,
  };
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/**
 * Shape-validate an already-`JSON.parse`d value against the findings schema — the mechanical
 * check both `em conform-findings check` (a headless run verifying what it just wrote) and every
 * reader below (`lookupFindingsBesideReport`) apply. Never throws; every failure is a plain-text
 * message in `errors`, in file order (document-level problems first, then one finding at a time).
 */
export function validateFindingsShape(input: unknown): { ok: true; doc: FindingsDoc } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["top-level value must be a JSON object"] };
  }
  const obj = input as Record<string, unknown>;

  if (!isNonEmptyString(obj.findingsSchemaVersion)) errors.push('"findingsSchemaVersion" must be a non-empty string');
  if (!isNonEmptyString(obj.model)) errors.push('"model" must be a non-empty string');
  if (!isNonEmptyString(obj.report)) errors.push('"report" must be a non-empty string');
  if (!isNonEmptyString(obj.revision)) errors.push('"revision" must be a non-empty string');

  const findingsRaw = obj.findings;
  const findings: Finding[] = [];
  if (!Array.isArray(findingsRaw)) {
    errors.push('"findings" must be an array');
  } else {
    let prevId: number | null = null;
    const seenIds = new Set<number>();
    findingsRaw.forEach((entry, i) => {
      const where = `findings[${i}]`;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        errors.push(`${where} must be an object`);
        return;
      }
      const f = entry as Record<string, unknown>;
      const id = f.id;
      if (typeof id !== "number" || !Number.isInteger(id)) {
        errors.push(`${where}.id must be an integer`);
      } else {
        if (seenIds.has(id)) errors.push(`${where}.id ${id} is a duplicate — ids must be unique`);
        seenIds.add(id);
        if (prevId !== null && id <= prevId) errors.push(`${where}.id ${id} is out of order — findings must be sorted by id ascending`);
        prevId = id;
      }
      if (typeof f.surface !== "string" || !(FINDING_SURFACES as readonly string[]).includes(f.surface)) {
        errors.push(`${where}.surface must be one of: ${FINDING_SURFACES.join(", ")}`);
      }
      if (!isNonEmptyString(f.class)) errors.push(`${where}.class must be a non-empty string`);
      if (f.slice !== null && typeof f.slice !== "string") errors.push(`${where}.slice must be a string or null`);
      if (!isNonEmptyString(f.evidence)) errors.push(`${where}.evidence must be a non-empty string`);
      const locusOk = f.locus === null || (typeof f.locus === "string" && (FINDING_LOCI as readonly string[]).includes(f.locus));
      if (!locusOk) errors.push(`${where}.locus must be null or one of: ${FINDING_LOCI.join(", ")}`);
      const resolvedByOk = f.resolvedBy === null || isNonEmptyString(f.resolvedBy);
      if (!resolvedByOk) errors.push(`${where}.resolvedBy must be a non-empty string or null`);
      const resolvedOnOk = f.resolvedOn === null || (typeof f.resolvedOn === "string" && isValidDateString(f.resolvedOn));
      if (!resolvedOnOk) errors.push(`${where}.resolvedOn must be a YYYY-MM-DD string or null`);
      // A ruled finding (non-null locus) is a human decision, recorded with who and when — same
      // discipline every other ratify/review/rule act in em holds (docs/process.md's "ratified
      // means... recorded with a name and a date").
      if (locusOk && f.locus !== null) {
        if (f.resolvedBy === null || !isNonEmptyString(f.resolvedBy)) errors.push(`${where}.resolvedBy is required once locus is set`);
        if (f.resolvedOn === null || !(typeof f.resolvedOn === "string" && isValidDateString(f.resolvedOn))) {
          errors.push(`${where}.resolvedOn is required once locus is set`);
        }
      }
      findings.push({
        id: typeof id === "number" ? id : NaN,
        surface: (typeof f.surface === "string" ? f.surface : "other") as FindingSurface,
        class: typeof f.class === "string" ? f.class : "",
        slice: (f.slice as string | null) ?? null,
        evidence: typeof f.evidence === "string" ? f.evidence : "",
        locus: (f.locus as FindingLocus | null) ?? null,
        resolvedBy: (f.resolvedBy as string | null) ?? null,
        resolvedOn: (f.resolvedOn as string | null) ?? null,
      });
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    doc: {
      findingsSchemaVersion: obj.findingsSchemaVersion as string,
      model: obj.model as string,
      report: obj.report as string,
      revision: obj.revision as string,
      findings,
    },
  };
}

const REPORT_SUFFIX_RE = /-report\.md$/;

/** `conformance/<date>-report.md` -> `conformance/<date>-findings.json` — the sibling-path
 *  convention every consumer of the findings record uses. Null when `reportPath` doesn't match
 *  the conventional `<date>-report.md` naming (an older/hand-named report) — callers treat that
 *  the same as "no findings file", the migration path for a report predating this feature. */
export function findingsPathForReport(reportPath: string): string | null {
  return REPORT_SUFFIX_RE.test(reportPath) ? reportPath.replace(REPORT_SUFFIX_RE, "-findings.json") : null;
}

export type FindingsLookup =
  | { kind: "absent" }
  | { kind: "invalid"; path: string; message: string }
  | { kind: "found"; path: string; doc: FindingsDoc };

/**
 * Resolve the findings JSON beside `reportPath` (relative to `baseDir`, the `.em` file's
 * directory — same convention every doc/note/report path in em uses), reading and shape-
 * validating it. `absent` covers both "no sibling-path convention to try" (a hand-named report)
 * and "the file just isn't there" — both are the SAME migration-path signal to every caller:
 * warn once, fall back to the pre-MIL-214 behavior. `invalid` is a genuine problem (the file
 * exists but doesn't parse or fails shape validation) — callers refuse rather than silently
 * treating a broken findings file as if it were absent.
 */
export function lookupFindingsBesideReport(baseDir: string, reportPath: string): FindingsLookup {
  const findingsRel = findingsPathForReport(reportPath);
  if (findingsRel === null) return { kind: "absent" };
  const absPath = join(baseDir, findingsRel);
  if (!existsSync(absPath)) return { kind: "absent" };
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch (e) {
    return { kind: "invalid", path: findingsRel, message: `could not read ${findingsRel}: ${(e as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "invalid", path: findingsRel, message: `${findingsRel} is not valid JSON` };
  }
  const shape = validateFindingsShape(parsed);
  if (!shape.ok) return { kind: "invalid", path: findingsRel, message: `${findingsRel}: ${shape.errors.join("; ")}` };
  return { kind: "found", path: findingsRel, doc: shape.doc };
}

/** Every `conformance/*-findings.json` beside `baseDir`, newest filename first, that parses and
 *  shape-validates — a malformed candidate is silently skipped (`em conform-findings check` is
 *  the loud diagnosis for a broken file, not this scan). Shared by `cli/sliceConform.ts`'s
 *  `findLatestFindingsForRevision` (filters to one `revision`) and `em slice reratify`'s advisory
 *  (`reratifyAdvisory`, cli/reratify.ts — looks across every past run, not just one revision).
 *  Returns `[]` when `conformance/` doesn't exist. */
export function listAllFindingsFiles(baseDir: string): { path: string; doc: FindingsDoc }[] {
  const dir = join(baseDir, "conformance");
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const names = entries.filter((f) => /^\d{4}-\d{2}-\d{2}-findings\.json$/.test(f)).sort().reverse();
  const results: { path: string; doc: FindingsDoc }[] = [];
  for (const name of names) {
    const relPath = `conformance/${name}`;
    let raw: string;
    try {
      raw = readFileSync(join(dir, name), "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const shape = validateFindingsShape(parsed);
    if (shape.ok) results.push({ path: relPath, doc: shape.doc });
  }
  return results;
}

/** Every finding still blocking `inScope` — `locus === null` (never ruled) AND (`slice === null`,
 *  ambiguous/whole-model, counts as in scope for everything, OR `slice` names a key in
 *  `inScope`). The one predicate `em slice conform` (a single-key `inScope`), `em state
 *  set-conformance` (every `implemented` slice), and `em status`'s `unruledFindings` count all
 *  share — never re-derived three different ways. */
export function unruledFindingsInScope(findings: Finding[], inScope: ReadonlySet<string>): Finding[] {
  return findings.filter((f) => f.locus === null && (f.slice === null || inScope.has(f.slice)));
}

/** Parse a `--findings` spec (`"1-3"`, `"1, 2, 4"`, `"1-3, 7"`) into a deduped, ascending list of
 *  finding ids. Accepts the same conservative charset `applySupersededBanner`'s `FINDINGS_RE`
 *  already gates on (digits/commas/spaces/either dash style) — this just additionally parses the
 *  numbers out rather than treating the spec as opaque banner text. Returns null for anything
 *  that doesn't parse cleanly (an empty spec, a reversed range, a stray token) — same
 *  never-guess discipline every other em parser holds. */
export function parseFindingsSpec(spec: string): number[] | null {
  const trimmed = spec.trim();
  if (!trimmed) return null;
  const ids = new Set<number>();
  for (const part of trimmed.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const range = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(p);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      if (lo > hi) return null;
      for (let n = lo; n <= hi; n++) ids.add(n);
      continue;
    }
    const single = /^(\d+)$/.exec(p);
    if (!single) return null;
    ids.add(Number(single[1]));
  }
  return ids.size > 0 ? [...ids].sort((a, b) => a - b) : null;
}

export type ApplyFindingsRulingResult = { ok: true; doc: FindingsDoc; changed: boolean } | { ok: false; message: string };

/**
 * Pure transform: records `locus`/`resolvedBy`/`resolvedOn` on every finding named by `ids` in
 * `doc`. Refuses (`ok: false`, no partial write) if any named id doesn't exist, or if any named
 * finding already carries a DIFFERENT locus — the same refuse-different-identity discipline
 * `ratify.ts` holds for `ratifiedBy`/`ratifiedOn` (docs/process.md: a ruling is recorded once,
 * with a name and a date; changing it needs a human decision, not a silent overwrite). Idempotent
 * per-finding: a finding already carrying the exact same locus/resolvedBy/resolvedOn is left
 * alone (doesn't count toward `changed`).
 */
export function applyFindingsRuling(
  doc: FindingsDoc,
  ids: number[],
  locus: FindingLocus,
  resolvedBy: string,
  resolvedOn: string,
): ApplyFindingsRulingResult {
  const trimmedBy = resolvedBy.trim();
  if (!trimmedBy) return { ok: false, message: "a resolver name is required (--by)" };
  if (!isValidDateString(resolvedOn)) return { ok: false, message: `invalid date "${resolvedOn}" — expected YYYY-MM-DD` };

  const byId = new Map(doc.findings.map((f) => [f.id, f]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return { ok: false, message: `no finding(s) with id ${missing.join(", ")} in the findings record` };
  }
  for (const id of ids) {
    const f = byId.get(id)!;
    if (f.locus !== null && f.locus !== locus) {
      return { ok: false, message: `finding ${id} already has locus "${f.locus}" — refusing to overwrite with "${locus}"` };
    }
  }

  let changed = false;
  const idSet = new Set(ids);
  const findings = doc.findings.map((f) => {
    if (!idSet.has(f.id)) return f;
    if (f.locus === locus && f.resolvedBy === trimmedBy && f.resolvedOn === resolvedOn) return f; // no-op
    changed = true;
    return { ...f, locus, resolvedBy: trimmedBy, resolvedOn };
  });
  return { ok: true, doc: { ...doc, findings }, changed };
}

export type CheckFindingsResult = { ok: true; path: string; findingsCount: number } | { ok: false; path: string; errors: string[] };

/** `em conform-findings check <path>` — read `path` off disk, parse, and shape-validate. Never
 *  throws; every failure comes back as `errors`, one message per problem. */
export function checkFindingsFile(path: string): CheckFindingsResult {
  if (!existsSync(path)) return { ok: false, path, errors: [`no such file: ${path}`] };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { ok: false, path, errors: [`could not read ${path}: ${(e as Error).message}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, path, errors: [`${path} is not valid JSON`] };
  }
  const shape = validateFindingsShape(parsed);
  if (!shape.ok) return { ok: false, path, errors: shape.errors };
  return { ok: true, path, findingsCount: shape.doc.findings.length };
}

/** `em conform-findings check --json` document shape — a small envelope, no schema-version field
 *  of its own (this IS the check tool for `findingsSchemaVersion`; the tool's own output isn't a
 *  long-lived emitted artifact the way a report/status document is). */
export function buildCheckFindingsJson(result: CheckFindingsResult): string {
  const doc = result.ok
    ? { ok: true, path: result.path, findingsCount: result.findingsCount, errors: [] as string[] }
    : { ok: false, path: result.path, findingsCount: null, errors: result.errors };
  return JSON.stringify(doc, null, 2);
}
