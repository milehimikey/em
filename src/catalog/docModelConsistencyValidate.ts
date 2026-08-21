// SPDX-License-Identifier: MIT
// `em validate`'s doc↔model consistency check (MIL-124): the "internal surface" of the conform
// phase (does a bound slice doc's structured claims still agree with the `.em` model?) has always
// been checked by agent judgment. This module makes the mechanically-checkable core of that
// judgment call deterministic — the same fs-aware-sibling shape as catalog/lineageValidate.ts
// (MIL-84), catalog/frontmatterCoherenceValidate.ts (MIL-85), and catalog/noteBindingValidate.ts
// (MIL-126): a module next to model/validate.ts, not folded into it, because it needs
// `baseDir`/fs access the rest of validate deliberately never touches.
//
// Four things are checked, each declare-gated so a thin/draft doc stays silent rather than
// nagging (matching this codebase's bar for an unconditional rule — see the sibling modules
// above):
//
//   1. pattern: frontmatter `pattern:` vs the deterministic classification `classify.ts`'s
//      `classifySlicePattern()` computes from the `.em` AST — the same function `em export`
//      publishes as `slice.pattern`. Checked against the doc's OWNING slice only (the slice whose
//      own export key the doc's canonical path names) — `classifySlicePattern` is inherently
//      single-slice, so a MIL-121 cross-covered doc's `pattern:` is compared against the primary
//      slice it's canonically bound to, not some blend of the whole covered union. Silent when
//      the owning slice classifies as `unclassified` — nothing authoritative to compare against.
//
//   2. element rosters, per kind (command/event/view), both directions: the doc body's own
//      stable markers (`**Command:** \`Name\``, `**Event:** \`Name\`` [`→ context \`Ctx\``],
//      `- **View:** \`Name\` ...`) versus the model's elements of that kind. A kind with zero
//      markers in the doc is silent for that kind entirely — partial/draft docs are normal, and
//      this mirrors the field-level declare-gating below. `→ context` is deliberately never
//      compared against the model's `@Context` tag — out of scope for this ticket (judgment call,
//      see this module's test file / the MIL-124 report).
//
//   3. fields, per matched Command/Event: a markdown field table (first column = field name)
//      found in the marker's own section (before the next `##` heading or marker) versus the
//      model element's `{ fields }` block. Compared only when BOTH sides declare at least one
//      field — either side lacking fields entirely is silent, matching the roster gating above.
//      Name comparison (rosters and fields alike) uses `model.ts`'s own `normalizeName()`, so
//      case/spacing conventions match how the DSL itself resolves names — never a second,
//      independently-invented comparison.
//
// MIL-121 cross-covered docs: a doc can be the resolved binding (via `docJoin.ts`'s
// `resolveSliceDocJoin`) for more than one slice — its own canonical slice, plus any slice whose
// `covers:`-ratified cross-note points at it. This module resolves every slice's binding exactly
// that way (never re-deriving binding semantics), groups slices by resolved doc path, and checks
// each doc ONCE against the UNION of elements across every slice it's bound to — not once per
// slice, which would double-report the same disagreement. Findings anchor at whichever slice the
// model-side element actually lives in (element line + refs) for "model has it, doc doesn't
// mention it"; at the doc's OWNING slice (the one canonically bound to this doc's path — falling
// back to the earliest-declared covered slice if none is, an edge case that needs a floating
// `covers`-only doc with no slice of its own) for "doc names it, nothing in the model does" and
// for the pattern check, since neither has one specific model element to point at.
//
// Body-marker/table parsing lives here, not in sliceDoc.ts: it operates on `SliceDoc.body` (the
// post-frontmatter text sliceDoc.ts already exposes) but needs to talk in terms of element
// *kinds*, which is this rule's vocabulary, not the doc parser's. `pattern` is the one exception
// — a genuine frontmatter scalar sliceDoc.ts didn't parse onto the struct before this ticket — so
// it was added there instead (one line, alongside `status`/`version`), keeping every other
// frontmatter field's parsing in one place.
//
// All warnings, never errors — a genuine doc/model disagreement is worth flagging, but it's
// never a build-breaking condition (same posture every other fs-aware validate rule takes).

import { Element, NormalizedModel, Slice, normalizeName } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic } from "../model/validate.js";
import { pushDiag } from "../model/rules.js";
import { classifySlicePattern, slicePatternLabel } from "./classify.js";
import { resolveSliceDocJoin } from "./docJoin.js";
import { readSliceDoc } from "./readSliceDoc.js";
import { SliceDoc } from "./sliceDoc.js";

/** The three element kinds this rule's doc markers can name — the DSL has more (`ui`,
 *  `automation`/`processor`/`saga`/`translation`), but the slice.md template only gives
 *  command/event/view their own stable structured markers; the rest are prose (Trigger & Actor,
 *  Consumed by, ...) this ticket deliberately leaves to judgment. */
type MarkerKind = "command" | "event" | "view";

interface DocField {
  /** Raw field-name text as written in the doc's table (backticks/whitespace stripped). */
  name: string;
  /** Raw type text, or null when the table has no Type column, or the cell is a template
   *  placeholder (`{{Type}}`) or blank. */
  type: string | null;
}

interface DocMarker {
  kind: MarkerKind;
  /** Raw name text as written between backticks in the marker line. */
  name: string;
  /** 0-based line index within `SliceDoc.body`'s line array — informational only (no diagnostic
   *  in this module points into the doc file itself; every diagnostic anchors at a `.em` line). */
  bodyLine: number;
  /** The field table found between this marker and the next `##` heading/marker, or null when
   *  none was found (or the table had nothing but placeholder rows) — command/event only, always
   *  null for view (the template gives read models no field table of their own). */
  fieldsTable: DocField[] | null;
}

const COMMAND_MARKER = /^\*\*Command:\*\*\s*`([^`]+)`\s*$/;
const EVENT_MARKER = /^\*\*Event:\*\*\s*`([^`]+)`(?:\s*→\s*context\s*`[^`]+`\s*)?$/;
const VIEW_MARKER = /^-\s*\*\*View:\*\*\s*`([^`]+)`/;

function matchMarker(line: string): { kind: MarkerKind; name: string } | null {
  const cmd = COMMAND_MARKER.exec(line);
  if (cmd) return { kind: "command", name: cmd[1].trim() };
  const evt = EVENT_MARKER.exec(line);
  if (evt) return { kind: "event", name: evt[1].trim() };
  const view = VIEW_MARKER.exec(line);
  if (view) return { kind: "view", name: view[1].trim() };
  return null;
}

const TABLE_ROW = /^\s*\|/;
const TABLE_SEPARATOR_CELL = /^:?-+:?$/;
const PLACEHOLDER = /\{\{.*\}\}/;

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function cleanCell(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const stripped = raw.replace(/^`|`$/g, "").trim();
  if (!stripped || PLACEHOLDER.test(raw)) return null;
  return stripped;
}

/** Finds the first markdown table between `start` and `end` (exclusive) whose header's first
 *  column reads "Field" (case/spacing-insensitive) — the shape every field table in the template
 *  uses (`| Field | Type | ... |`). Returns null when no such table exists, or every data row is
 *  a template placeholder (an unfilled `{{field}}` row is the same as no table — nothing real was
 *  declared yet). */
function findFieldTable(lines: string[], start: number, end: number): DocField[] | null {
  for (let i = start; i < end - 1; i++) {
    if (!TABLE_ROW.test(lines[i]) || !TABLE_ROW.test(lines[i + 1])) continue;
    const sepCells = splitRow(lines[i + 1]);
    if (sepCells.length === 0 || !sepCells.every((c) => TABLE_SEPARATOR_CELL.test(c))) continue;
    const headerCells = splitRow(lines[i]);
    if (normalizeName(headerCells[0] ?? "") !== "field") continue;
    const typeIdx = headerCells.findIndex((c, idx) => idx > 0 && normalizeName(c) === "type");

    const fields: DocField[] = [];
    for (let j = i + 2; j < end; j++) {
      if (!TABLE_ROW.test(lines[j])) break;
      const cells = splitRow(lines[j]);
      const name = cleanCell(cells[0]);
      if (!name) continue; // blank or placeholder row — not a real field declaration
      const type = typeIdx >= 0 ? cleanCell(cells[typeIdx]) : null;
      fields.push({ name, type });
    }
    return fields.length > 0 ? fields : null;
  }
  return null;
}

/** Parses every Command/Event/View marker out of a slice doc's body, each paired with its own
 *  field table (command/event only) when one follows before the next `##` heading or marker.
 *  Tolerant by construction: only the exact template marker shapes match at all (see the regexes
 *  above); anything else — prose, a differently-shaped table, a heading that isn't `##` — is
 *  simply not recognized, never a parse error. */
function parseDocMarkers(body: string): DocMarker[] {
  const lines = body.split(/\r?\n/);
  const hits: Array<{ kind: MarkerKind; name: string; idx: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = matchMarker(lines[i]);
    if (m) hits.push({ ...m, idx: i });
  }
  return hits.map((hit) => {
    let end = lines.length;
    for (let j = hit.idx + 1; j < lines.length; j++) {
      if (/^##\s/.test(lines[j]) || matchMarker(lines[j])) {
        end = j;
        break;
      }
    }
    const fieldsTable = hit.kind === "view" ? null : findFieldTable(lines, hit.idx + 1, end);
    return { kind: hit.kind, name: hit.name, bodyLine: hit.idx, fieldsTable };
  });
}

/** First-occurrence-wins map of a marker kind's declared names, normalized — mirrors every other
 *  "first wins" dedup convention in this codebase (docJoin.ts's cross-binding search, etc.). A
 *  doc that (unusually) declares the same command/event/view name twice is not this rule's
 *  business; only the first table (if any) is what gets compared. */
function firstByName(markers: DocMarker[], kind: MarkerKind): Map<string, DocMarker> {
  const map = new Map<string, DocMarker>();
  for (const m of markers) {
    if (m.kind !== kind) continue;
    const key = normalizeName(m.name);
    if (!map.has(key)) map.set(key, m);
  }
  return map;
}

/**
 * Resolve every slice's doc consistency findings. `baseDir` is the `.em` file's directory, same
 * convention every other doc/note path in em uses.
 */
export function validateDocModelConsistency(model: NormalizedModel, refs: RefsResult, baseDir: string): Diagnostic[] {
  const diags: Diagnostic[] = [];

  // Resolve every slice's actual doc binding exactly the way `em export` does — never re-deriving
  // canonical-vs-cross-binding precedence — and group slices by the resolved doc path so a
  // MIL-121 cross-covered doc is checked once against the union, not once per covered slice.
  const groups = new Map<string, number[]>();
  model.slices.forEach((slice, i) => {
    const sliceKey = refs.sliceKeys[i];
    const { doc } = resolveSliceDocJoin(slice, sliceKey, baseDir, (id) => refs.refById.get(id)!);
    if (!doc.found || doc.reason !== null) return; // unbound, missing file, or unusable frontmatter
    const arr = groups.get(doc.path);
    if (arr) arr.push(i);
    else groups.set(doc.path, [i]);
  });

  const docCache = new Map<string, SliceDoc | null>();
  const docForKey = (key: string): SliceDoc | null => {
    if (!docCache.has(key)) docCache.set(key, readSliceDoc(baseDir, key));
    return docCache.get(key)!;
  };

  for (const [docPath, sliceIndices] of groups) {
    const docKey = docPath.replace(/^slices\//, "").replace(/\.md$/, "");
    const parsed = docForKey(docKey);
    if (!parsed) continue; // defensive — resolveSliceDocJoin already guaranteed this file parses

    // The "owning" slice is the one canonically bound to this exact doc (its own export key ==
    // docKey) — the anchor for findings with no single model element to point at. A doc reached
    // ONLY via a `covers`-ratified cross-note, whose own canonical key names no slice currently
    // in the model, has no such slice; fall back to the earliest-declared covered slice instead,
    // same "first wins" determinism as everywhere else in this module.
    const ownerIdx = sliceIndices.find((i) => refs.sliceKeys[i] === docKey) ?? Math.min(...sliceIndices);
    const ownerSlice = model.slices[ownerIdx];
    const ownerKey = refs.sliceKeys[ownerIdx];

    checkPattern(diags, parsed, ownerSlice, ownerKey, docPath);

    const markers = parseDocMarkers(parsed.body);
    const coveredNames = sliceIndices.map((i) => model.slices[i].name);

    for (const kind of ["command", "event", "view"] as const) {
      const docByName = firstByName(markers, kind);
      if (docByName.size === 0) continue; // kind not declared in this doc at all — silent

      const modelEls: Element[] = [];
      for (const i of sliceIndices) for (const el of model.slices[i].elements) if (el.kind === kind) modelEls.push(el);
      const modelByName = new Map<string, Element[]>();
      for (const el of modelEls) {
        const key = normalizeName(el.name);
        const list = modelByName.get(key);
        if (list) list.push(el);
        else modelByName.set(key, [el]);
      }

      checkRosterDirections(diags, kind, docPath, docByName, modelByName, ownerSlice, ownerKey, coveredNames, model, refs);
      if (kind !== "view") checkFields(diags, kind, docPath, docByName, modelByName, model, refs);
    }
  }

  return diags;
}

function checkPattern(
  diags: Diagnostic[],
  doc: SliceDoc,
  ownerSlice: Slice,
  ownerKey: string,
  docPath: string,
): void {
  if (!doc.pattern) return; // usable-frontmatter gate already guarantees presence in practice; defensive
  const classified = classifySlicePattern(ownerSlice);
  if (classified === "unclassified") return; // nothing authoritative to compare the doc's claim against
  if (normalizeName(doc.pattern) === classified) return;
  pushDiag(diags, "doc-model-pattern-mismatch", {
    message:
      `slice doc "${docPath}" declares \`pattern: ${doc.pattern}\`, but the model classifies slice ` +
      `"${ownerSlice.name}" as "${classified}" (${slicePatternLabel(classified)}) — see src/catalog/classify.ts`,
    line: ownerSlice.line,
    refs: [ownerKey],
  });
}

function checkRosterDirections(
  diags: Diagnostic[],
  kind: MarkerKind,
  docPath: string,
  docByName: Map<string, DocMarker>,
  modelByName: Map<string, Element[]>,
  ownerSlice: Slice,
  ownerKey: string,
  coveredNames: string[],
  model: NormalizedModel,
  refs: RefsResult,
): void {
  const coverage =
    coveredNames.length > 1 ? ` (covering slices: ${coveredNames.map((n) => `"${n}"`).join(", ")})` : "";

  // (a) the doc names a command/event/view the model doesn't have.
  for (const [key, marker] of docByName) {
    if (modelByName.has(key)) continue;
    pushDiag(diags, "doc-model-element-not-in-model", {
      message: `slice doc "${docPath}" declares ${kind} \`${marker.name}\`, but no ${kind} named "${marker.name}" exists in the model${coverage}`,
      line: ownerSlice.line,
      refs: [ownerKey],
    });
  }

  // (b) the model has a command/event/view this doc never mentions.
  for (const [key, els] of modelByName) {
    if (docByName.has(key)) continue;
    const el = els[0];
    const sliceKey = refs.sliceKeys[el.sliceIndex];
    const sliceName = model.slices[el.sliceIndex].name;
    pushDiag(diags, "doc-model-element-not-in-doc", {
      message: `slice "${sliceName}" has ${kind} "${el.name}", but slice doc "${docPath}" doesn't declare it — expected ${markerHint(kind, el.name)}`,
      line: el.line,
      refs: [sliceKey, refs.refById.get(el.id)!],
    });
  }
}

function markerHint(kind: MarkerKind, name: string): string {
  if (kind === "view") return `a "- **View:** \`${name}\` ..." marker`;
  const label = kind === "command" ? "Command" : "Event";
  return `a "**${label}:** \`${name}\`" marker`;
}

function checkFields(
  diags: Diagnostic[],
  kind: "command" | "event",
  docPath: string,
  docByName: Map<string, DocMarker>,
  modelByName: Map<string, Element[]>,
  model: NormalizedModel,
  refs: RefsResult,
): void {
  for (const [key, marker] of docByName) {
    if (!marker.fieldsTable) continue; // doc declares no fields for this element — silent
    const modelMatches = modelByName.get(key);
    if (!modelMatches) continue; // already reported as doc-model-element-not-in-model above
    const el = modelMatches[0];
    if (!el.fields || el.fields.length === 0) continue; // model declares no fields — silent

    const docFields = new Map<string, DocField>();
    for (const f of marker.fieldsTable) {
      const k = normalizeName(f.name);
      if (!docFields.has(k)) docFields.set(k, f);
    }
    const modelFields = new Map<string, { name: string; type?: string }>();
    for (const f of el.fields) {
      const k = normalizeName(f.name);
      if (!modelFields.has(k)) modelFields.set(k, f);
    }

    const sliceKey = refs.sliceKeys[el.sliceIndex];
    const sliceName = model.slices[el.sliceIndex].name;
    const elRef = refs.refById.get(el.id)!;
    const elRefs = [sliceKey, elRef];

    for (const [fk, df] of docFields) {
      if (modelFields.has(fk)) continue;
      pushDiag(diags, "doc-model-field-mismatch", {
        message: `slice doc "${docPath}"'s ${kind} \`${marker.name}\` field table lists "${df.name}", but ${kind} "${el.name}" (slice "${sliceName}") has no such field`,
        line: el.line,
        refs: elRefs,
      });
    }
    for (const [fk, mf] of modelFields) {
      const df = docFields.get(fk);
      if (!df) {
        pushDiag(diags, "doc-model-field-mismatch", {
          message: `${kind} "${el.name}" (slice "${sliceName}") has field "${mf.name}", but slice doc "${docPath}"'s ${kind} \`${marker.name}\` field table doesn't list it`,
          line: el.line,
          refs: elRefs,
        });
        continue;
      }
      if (df.type && mf.type && normalizeName(df.type) !== normalizeName(mf.type)) {
        pushDiag(diags, "doc-model-field-mismatch", {
          message: `field "${mf.name}" on ${kind} "${el.name}" (slice "${sliceName}") is typed \`${mf.type}\` in the model but \`${df.type}\` in slice doc "${docPath}"`,
          line: el.line,
          refs: elRefs,
        });
      }
    }
  }
}
