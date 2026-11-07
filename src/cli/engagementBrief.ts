// SPDX-License-Identifier: MIT
// `em engagement brief` (GH #454): a deterministic, self-contained per-slice work brief for
// implementers em does not control — a ticket-driven cloud agent fed by Jira/Linear tickets, not
// an em-aware session. `em implement` hands such a session the slice doc plus a conversation's
// worth of context; this hands a ticket EVERYTHING it needs in one paste, built from machinery
// that already exists elsewhere so nothing here is re-derived or re-judged:
//
//  - the spec: the bound slice doc, read the same way `readSliceDoc` always has, embedded
//    verbatim — it IS the spec. No doc: the model's own elements/fields for the slice, loudly
//    flagged as a gap rather than silently working around it.
//  - model context: cross-unit edges (`model/edges.ts`, `loops-to` excluded — the same exclusion
//    `engagement.ts`'s unit graph already uses) folded to engagement units exactly as
//    `unitPredecessors`/`buildEngagementPlan` do, via the exported `unitOfElement`.
//  - contract surface: `catalog/apiFirst.ts`'s `slicePublicTouching`/`contractPathFor` — the same
//    gate `--slice-ready` and `em slice ratify` already enforce.
//  - definition of done: the slice's own `INV-*` ids and authored scenario titles (the doc-side
//    extraction `em engagement plan`'s pre-flight already uses), a filled-in skeleton of the
//    bindings manifest (docs/bindings.md) scoped to this slice's own elements/invariants, the
//    exact `em conform bindings check` verify line, and the resolved PR title (`resolvePrTitle`,
//    the same helper `plan` calls).
//  - context documents: the engagement's `context:` list (GH #455) — pointers by default,
//    `--inline-context` embeds each file's full text (a missing file is a loud marker, never a
//    crash — the same spirit as `plan`'s `context-missing` pre-flight).
//
// One brief per engagement slice (model/Ledger order) unless `--slice` narrows it to one. `--json`
// is the MCP `engagement_brief` tool's document, byte-for-byte (see emit/engagementJson.ts).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Element, NormalizedModel, Slice, collectModelInvariants } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { semanticEdges } from "../model/edges.js";
import { computeModelKey } from "../model/qualifiedRef.js";
import { slicePublicTouching } from "../catalog/apiFirst.js";
import { contractPathFor } from "./api.js";
import { readSliceDoc } from "../catalog/readSliceDoc.js";
import { docFolders } from "../catalog/docLocate.js";
import { authoredScenarios } from "../catalog/sliceSections.js";
import { extractInvariantIds } from "../catalog/invTokens.js";
import { EngagementFile, EngagementSliceEntry, loadEngagement } from "./engagementFile.js";
import { UnitIndex, buildUnitIndex, effectiveTracking, missingKeys, missingMessage, resolvePrTitle, unitOfElement, SLICE_BASE } from "./engagement.js";

/** What `engagement brief` needs beyond `{file, model, refs}` — no readiness/diagnostics input
 *  (unlike `plan`): the brief describes the slice, it never judges whether it's ready to build. */
export interface EngagementBriefModelInput {
  file: string;
  model: NormalizedModel;
  refs: RefsResult;
  baseDir: string;
}

export interface BriefElementSummary {
  /** Bare `<kind>.<slug>` (docs/bindings.md's ref shape) — no `<sliceKey>/` prefix: the brief
   *  already names the one slice every one of these elements belongs to. */
  ref: string;
  kind: string;
  name: string;
  public: boolean;
  fields: Array<{ name: string; type: string | null; optional: boolean }>;
}

/** An element on the OTHER side of a cross-unit edge — full qualified export ref (model-wide
 *  unambiguous), plus which engagement unit owns it. */
export interface BriefNeighborItem {
  ref: string;
  kind: string;
  name: string;
  unit: string;
}

export interface BriefRepeatedView {
  /** The view's display name, as declared by this slice. */
  view: string;
  /** The other (textual) slice export keys where `view <this> again` reads it — every one of
   *  them folds (MIL-208) into this same unit, so none is a separate PR. */
  instances: string[];
}

export interface BriefContextDoc {
  /** As stored in the engagement file — repo-relative, exactly as given. */
  path: string;
  inline: boolean;
  /** The file's full text when `inline` and it was found; null otherwise. */
  content: string | null;
  /** Null when `inline` is false (never checked in pointer mode — the same "stored as given,
   *  never checked at write time" posture the engagement file itself holds for `context:`). */
  missing: boolean | null;
}

export interface EngagementBriefSlice {
  key: string;
  sliceName: string;
  pattern: string;
  docStatus: string | null;
  tracking: string | null;
  prTitle: string;
  /** The MIL-280 convention: every slice branch is `impl/<key>`, cut from and targeting `main`. */
  branch: string;
  base: string;
  /** The Ledger's OWN recorded state/branch/base/pr (`em engagement set`) — branch/base/pr are
   *  null until a human or the lead has actually recorded them; `branch`/`base` above are the
   *  convention to follow when they're still null. */
  ledgerState: string;
  ledgerBranch: string | null;
  ledgerBase: string | null;
  ledgerPr: string | null;
  doc: { found: boolean; path: string | null; content: string | null };
  /** Non-null only when `doc.found` is false: this slice's own elements/fields from the model,
   *  since there is no doc to read as the spec. */
  fallbackElements: BriefElementSummary[] | null;
  modelContext: {
    consumes: BriefNeighborItem[];
    produces: BriefNeighborItem[];
    neighborUnits: string[];
    repeatedViews: BriefRepeatedView[];
  };
  contract: {
    publicTouching: boolean;
    contractPath: string | null;
    publicElements: BriefElementSummary[];
  };
  definitionOfDone: {
    invariantIds: string[];
    scenarioTitles: string[];
    bindingsPath: string;
    bindingsExample: string;
    conformCheckCommand: string;
    isolationNote: string;
    prTitle: string;
  };
  context: BriefContextDoc[];
}

export interface EngagementBrief {
  file: string;
  engagement: string;
  slug: string;
  inlineContext: boolean;
  slices: EngagementBriefSlice[];
}

export type BriefResult = { ok: true; brief: EngagementBrief } | { ok: false; message: string };

const ISOLATION_NOTE =
  "Touch nothing outside this slice's own scope: no edits to a sibling slice's code or tests, " +
  "and no shared files beyond what the foundation PR already landed (implement.md §8). If the " +
  "work needs something outside this boundary, stop and say so instead of reaching across it.";

function bareRef(fullRef: string | undefined, kind: string, name: string, sliceKey: string): string {
  if (fullRef === undefined) return `${kind}.${name}`;
  const prefix = `${sliceKey}/`;
  return fullRef.startsWith(prefix) ? fullRef.slice(prefix.length) : fullRef;
}

function summarizeElement(el: Element, refs: RefsResult, sliceKey: string): BriefElementSummary {
  return {
    ref: bareRef(refs.refById.get(el.id), el.kind, el.name, sliceKey),
    kind: el.kind,
    name: el.name,
    public: el.public === true,
    fields: (el.fields ?? []).map((f) => ({ name: f.name, type: f.type ?? null, optional: f.optional === true })),
  };
}

/** docs/bindings.md's minimal shape, filled in for this slice's own elements and invariant ids —
 *  `TODO` placeholders where only the implementer who writes the code knows the file/identifier.
 *  A template to complete, not a claim. */
export function buildBindingsExample(key: string, elements: BriefElementSummary[], invariantIds: string[]): string {
  const lines = [`bindingsSchemaVersion: "1.0"`, `slice: ${key}`, "elements:"];
  if (elements.length === 0) {
    lines.push("  []");
  } else {
    for (const el of elements) lines.push(`  - ref: ${el.ref}`, "    file: TODO", "    identifier: TODO");
  }
  lines.push("invariants:");
  if (invariantIds.length === 0) {
    lines.push("  []");
  } else {
    for (const id of invariantIds) lines.push(`  - id: ${id}`, "    enforcedIn: {file: TODO, identifier: TODO}", "    testedIn: {file: TODO, identifier: TODO}");
  }
  return lines.join("\n");
}

/** Where `slices/<key>.md` sits — root first, then any storyline folder (`catalog/docLocate.ts`'s
 *  own search order) — without resolving against the process's cwd, so the path is a pure
 *  function of `baseDir` (deterministic regardless of where the command runs from). */
function sliceDocDisplayPath(baseDir: string, key: string): string | null {
  const rel = `slices/${key}.md`;
  for (const folder of docFolders(baseDir)) {
    const candidate = join(baseDir, folder, rel);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The slice's own model context: cross-UNIT edges only (same-unit pattern edges, and anything
 *  folded into this unit via `unitOfElement`, are internal and not "context"). `loops-to` is
 *  excluded, matching every other engagement graph read (it re-feeds an earlier read model, never
 *  a build or context dependency). */
function buildModelContext(model: NormalizedModel, refs: RefsResult, idx: UnitIndex, key: string): EngagementBriefSlice["modelContext"] {
  const consumes = new Map<string, BriefNeighborItem>();
  const produces = new Map<string, BriefNeighborItem>();
  const neighborUnits = new Set<string>();
  for (const e of semanticEdges(model)) {
    if (e.source === "loops-to") continue;
    const fromUnit = unitOfElement(model, idx, e.from);
    const toUnit = unitOfElement(model, idx, e.to);
    if (!fromUnit || !toUnit || fromUnit === toUnit) continue;
    if (toUnit === key) {
      const el = model.byId.get(e.from);
      if (el) {
        const ref = refs.refById.get(el.id) ?? `${el.kind}.${el.name}`;
        consumes.set(ref, { ref, kind: el.kind, name: el.name, unit: fromUnit });
        neighborUnits.add(fromUnit);
      }
    }
    if (fromUnit === key) {
      const el = model.byId.get(e.to);
      if (el) {
        const ref = refs.refById.get(el.id) ?? `${el.kind}.${el.name}`;
        produces.set(ref, { ref, kind: el.kind, name: el.name, unit: toUnit });
        neighborUnits.add(toUnit);
      }
    }
  }
  const order = (a: string, b: string) => (idx.sliceIndexOf.get(a) ?? 0) - (idx.sliceIndexOf.get(b) ?? 0);
  const byRef = (a: BriefNeighborItem, b: BriefNeighborItem) => a.ref.localeCompare(b.ref);

  const sliceIndex = idx.sliceIndexOf.get(key);
  const repeatedViews: BriefRepeatedView[] = [];
  if (sliceIndex !== undefined) {
    for (const el of model.slices[sliceIndex].elements) {
      if (el.kind !== "view" || el.again) continue;
      const instances = [
        ...new Set(model.elements.filter((x) => x.again === true && x.logicalId === el.id).map((x) => refs.sliceKeys[x.sliceIndex]).filter((s): s is string => s !== undefined)),
      ];
      if (instances.length > 0) repeatedViews.push({ view: el.name, instances });
    }
  }

  return {
    consumes: [...consumes.values()].sort(byRef),
    produces: [...produces.values()].sort(byRef),
    neighborUnits: [...neighborUnits].sort(order),
    repeatedViews,
  };
}

function buildContextDoc(path: string, inline: boolean): BriefContextDoc {
  if (!inline) return { path, inline: false, content: null, missing: null };
  if (!existsSync(path)) return { path, inline: true, content: null, missing: true };
  try {
    return { path, inline: true, content: readFileSync(path, "utf8"), missing: false };
  } catch {
    return { path, inline: true, content: null, missing: true };
  }
}

function buildSliceBrief(input: EngagementBriefModelInput, eng: EngagementFile, idx: UnitIndex, entry: EngagementSliceEntry, inlineContext: boolean): EngagementBriefSlice {
  const { model, refs, baseDir } = input;
  const key = entry.key;
  const sliceIndex = idx.sliceIndexOf.get(key)!;
  const slice: Slice = model.slices[sliceIndex];
  const sliceName = slice.name ?? key;
  const tracking = effectiveTracking(idx.docTracking.get(key) ?? null, eng.tracking);
  const prTitle = resolvePrTitle(eng.prTitle, tracking, sliceName, key);

  const docPath = sliceDocDisplayPath(baseDir, key);
  const doc = readSliceDoc(baseDir, key);
  const ownElements = slice.elements.map((el) => summarizeElement(el, refs, key));

  const invariantIds = doc ? extractInvariantIds(doc.body) : collectModelInvariants(model).filter((inv) => inv.element.sliceIndex === sliceIndex).map((inv) => inv.id);
  const scenarioTitles = doc ? authoredScenarios(doc.body).map((s) => s.title) : [];

  const publicTouching = slicePublicTouching(slice);
  const contractPath = publicTouching ? contractPathFor(input.file, computeModelKey(model, input.file)) : null;
  const publicElements = ownElements.filter((e) => e.public);

  const bindingsPath = join(dirname(input.file), "conformance", "bindings", `${key}.yaml`);
  const bindingsExample = buildBindingsExample(key, ownElements, invariantIds);
  const conformCheckCommand = `em conform bindings check ${input.file} --repo <path-to-target-repo> --slice ${key} --exit-code`;

  return {
    key,
    sliceName,
    pattern: idx.pattern.get(key) ?? "unknown",
    docStatus: idx.docStatus.get(key) ?? null,
    tracking,
    prTitle,
    branch: `impl/${key}`,
    base: SLICE_BASE,
    ledgerState: entry.state,
    ledgerBranch: entry.branch,
    ledgerBase: entry.base,
    ledgerPr: entry.pr,
    doc: { found: doc !== null, path: docPath, content: doc ? doc.body.trim() : null },
    fallbackElements: doc ? null : ownElements,
    modelContext: buildModelContext(model, refs, idx, key),
    contract: { publicTouching, contractPath, publicElements },
    definitionOfDone: { invariantIds, scenarioTitles, bindingsPath, bindingsExample, conformCheckCommand, isolationNote: ISOLATION_NOTE, prTitle },
    context: eng.context.map((path) => buildContextDoc(path, inlineContext)),
  };
}

/** GH #454: the shared builder the CLI action and the MCP `engagement_brief` tool both call — one
 *  input, one document, byte-identical. Refusal posture matches `plan`: an unreadable/invalid
 *  engagement file or a model the engagement no longer matches (`missingKeys`) refuses with no
 *  partial brief. An unresolved `--slice` is passed through AS GIVEN (same GH #237 convention
 *  `engagement set`'s CLI action uses) so the "not in engagement" refusal below is what speaks,
 *  not a generic resolver error. */
export function engagementBriefFor(input: EngagementBriefModelInput, slug: string, opts: { sliceKey?: string | null; inlineContext?: boolean } = {}): BriefResult {
  const loaded = loadEngagement(input.file, slug);
  if (!loaded.ok) return loaded;
  const idx = buildUnitIndex(input.model, input.refs, input.baseDir);
  const missing = missingKeys(loaded.file, idx);
  if (missing.length > 0) return { ok: false, message: missingMessage(slug, missing) };

  let entries = loaded.file.slices;
  if (opts.sliceKey !== undefined && opts.sliceKey !== null) {
    const entry = entries.find((e) => e.key === opts.sliceKey);
    if (!entry) return { ok: false, message: `slice "${opts.sliceKey}" is not in engagement "${slug}"` };
    entries = [entry];
  }
  const inlineContext = opts.inlineContext === true;
  const slices = entries.map((entry) => buildSliceBrief(input, loaded.file, idx, entry, inlineContext));
  return { ok: true, brief: { file: input.file, engagement: loaded.path, slug: loaded.file.slug, inlineContext, slices } };
}

const RULE = "=".repeat(72);

function formatOneBrief(brief: EngagementBrief, s: EngagementBriefSlice): string {
  const lines: string[] = [];
  lines.push(`# Work brief: ${brief.slug} / ${s.key} — "${s.sliceName}"`, "");
  lines.push(`- Tracking: ${s.tracking ?? "none"}`);
  lines.push(`- PR title to use: "${s.prTitle}"`);
  lines.push(`- Branch: \`${s.branch}\` on \`${s.base}\` (MIL-280: every slice PR targets main, never another slice's branch)`);
  const ledgerBits = [s.ledgerBranch ? `branch ${s.ledgerBranch}` : null, s.ledgerBase ? `base ${s.ledgerBase}` : null, s.ledgerPr ? `pr ${s.ledgerPr}` : null].filter((x): x is string => x !== null);
  lines.push(`- Ledger: ${s.ledgerState}${ledgerBits.length > 0 ? ` (${ledgerBits.join(", ")})` : ""}`);
  lines.push(`- Pattern: ${s.pattern} · doc status: ${s.docStatus ?? "(no doc)"}`, "");

  lines.push("## The spec", "");
  if (s.doc.found) {
    lines.push(`Verbatim from \`${s.doc.path}\` — this IS the spec.`, "", "<!-- BEGIN SPEC -->", s.doc.content ?? "", "<!-- END SPEC -->");
  } else {
    lines.push(
      `**NO BOUND DOC FOUND for slice "${s.key}" — there is nothing to read as a spec.** Expected \`slices/${s.key}.md\`. ` +
        "The model's own elements for this slice are listed below; this brief is INCOMPLETE until a slice doc is authored and ratified.",
      "",
      "| Kind | Name | Public | Fields |",
      "|---|---|---|---|",
    );
    for (const el of s.fallbackElements ?? []) {
      const fields = el.fields.map((f) => `${f.name}${f.optional ? "?" : ""}${f.type ? `: ${f.type}` : ""}`).join(", ") || "—";
      lines.push(`| ${el.kind} | ${el.name} | ${el.public ? "yes" : "no"} | ${fields} |`);
    }
  }
  lines.push("");

  lines.push("## Model context", "");
  lines.push(s.modelContext.consumes.length > 0 ? "Consumes:" : "Consumes: nothing from outside this slice.");
  for (const c of s.modelContext.consumes) lines.push(`- ${c.kind} \`${c.name}\` (${c.ref}) — produced by unit \`${c.unit}\``);
  lines.push(s.modelContext.produces.length > 0 ? "Produces:" : "Produces: nothing read outside this slice.");
  for (const p of s.modelContext.produces) lines.push(`- ${p.kind} \`${p.name}\` (${p.ref}) — read by unit \`${p.unit}\``);
  lines.push(`Neighbor slices: ${s.modelContext.neighborUnits.length > 0 ? s.modelContext.neighborUnits.map((u) => `\`${u}\``).join(", ") : "none"}`);
  if (s.modelContext.repeatedViews.length > 0) {
    lines.push("Repeated view instances:");
    for (const r of s.modelContext.repeatedViews) lines.push(`- \`${r.view}\` is read again, later, in: ${r.instances.map((i) => `\`${i}\``).join(", ")} (same unit — no separate PR)`);
  }
  lines.push("");

  lines.push("## Contract surface", "");
  lines.push(
    s.contract.publicTouching
      ? `This slice is **public-touching**. Contract file: \`${s.contract.contractPath}\`.`
      : "This slice is not public-touching — it owns no `public` command, event or view.",
  );
  if (s.contract.publicElements.length > 0) {
    lines.push("Public elements:");
    for (const el of s.contract.publicElements) lines.push(`- ${el.kind} \`${el.name}\` (${el.ref})`);
  }
  lines.push("");

  lines.push("## Definition of done", "");
  lines.push(
    s.definitionOfDone.invariantIds.length > 0
      ? `- Tests traceable to this slice's invariants: ${s.definitionOfDone.invariantIds.join(", ")}`
      : "- This slice declares no INV-* invariants.",
  );
  lines.push(
    s.definitionOfDone.scenarioTitles.length > 0
      ? `- Tests traceable to this slice's scenarios: ${s.definitionOfDone.scenarioTitles.map((t) => `"${t}"`).join(", ")}`
      : "- The spec has no authored `### Scenario:` blocks yet.",
  );
  lines.push(`- Commit \`${s.definitionOfDone.bindingsPath}\` (see docs/bindings.md) binding every element ref and invariant id above to the file/identifier that implements it. Minimal shape:`, "");
  lines.push("  ```yaml");
  for (const l of s.definitionOfDone.bindingsExample.split("\n")) lines.push(`  ${l}`);
  lines.push("  ```", "");
  lines.push(`  Then verify: \`${s.definitionOfDone.conformCheckCommand}\``);
  lines.push(`- Slice isolation: ${s.definitionOfDone.isolationNote}`);
  lines.push(`- PR title: "${s.definitionOfDone.prTitle}"`, "");

  lines.push(brief.inlineContext ? "## Context documents (inlined: --inline-context)" : "## Context documents", "");
  if (s.context.length === 0) {
    lines.push("No engagement-level context documents.");
  } else if (!brief.inlineContext) {
    for (const c of s.context) lines.push(`- ${c.path}`);
  } else {
    for (const c of s.context) {
      lines.push(`### ${c.path}`, "");
      if (c.missing) {
        lines.push(`**MISSING: context document "${c.path}" was not found on disk — this brief could not inline it.**`);
      } else {
        lines.push(`<!-- BEGIN CONTEXT: ${c.path} -->`, c.content ?? "", `<!-- END CONTEXT: ${c.path} -->`);
      }
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd();
}

/** Text form: a self-contained brief per slice, each pasteable into its own ticket as-is, in
 *  engagement order. More than one is separated by a plain rule line (not nested under one
 *  shared heading) so each chunk still reads as its own document. */
export function formatEngagementBriefText(brief: EngagementBrief): string {
  return brief.slices.map((s) => formatOneBrief(brief, s)).join(`\n\n${RULE}\n\n`);
}
