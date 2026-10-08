// SPDX-License-Identifier: MIT
// `em engagement` (MIL-268): the pure logic behind `new | plan | set | status | close` — unit
// folding, selection, the dependency graph, the levelled plan, and the Ledger join. The file
// format and its splices live in `./engagementFile.ts`; the JSON envelopes in
// `../emit/engagementJson.ts`; the CLI action and the MCP tools only read files and print.
//
// The graph (R22) is the model's own semantic edges (`model/edges.ts`, serialized by `em export`
// as `model.edges`) with `source !== "loops-to"`: a `loops-to` edge re-feeds an EARLIER read
// model and would turn every to-do-list/reaction pair into a cycle. Edges are lifted from
// elements to UNITS — the slice that owns a doc: a continuation slice (an again-view-only slice,
// MIL-208) and an `again` view instance fold into the originating slice, and a slice whose doc
// is a ratified `covers:` cross-binding (MIL-121) folds into the slice owning that doc. One
// unit = one doc = one PR = one Ledger row.
//
// Determinism: units and every list derived from them are in model (slice) order; no sort by
// anything but that order and plain string order for stable tie-breaks.

import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { Diagnostic, serializeDiagnostic } from "../model/validate.js";
import { semanticEdges } from "../model/edges.js";
import { classifySlicePattern } from "../catalog/classify.js";
import { loadSliceDocsOnce, joinSliceDocFast } from "../model/sliceDocIndex.js";
import { computeSliceReadiness, ContractCheckInput } from "../catalog/sliceReadyValidate.js";
import { buildModelIndex } from "../model/queryIndex.js";
import { buildQuerySystem, resolveElement } from "../query/system.js";
import {
  EngagementFile,
  EngagementSliceEntry,
  LedgerState,
  LEDGER_STATES,
  LEDGER_MARKER,
  LedgerRowFacts,
  SLUG_RE,
  buildLedgerLines,
  formatSliceEntryLine,
  isLedgerState,
  loadEngagement,
  modelRefFor,
  engagementPath,
  renderEngagementFile,
  spliceLedger,
  spliceSliceEntry,
  spliceStatus,
} from "./engagementFile.js";
import { ENGAGEMENT_SCHEMA_VERSION } from "../emit/engagementJson.js";

/** Everything a plan/status needs about one compiled model — what both the CLI action and the
 *  MCP tool already hold after compiling (MCP parity: same input, same builder). */
export interface EngagementModelInput {
  file: string;
  model: NormalizedModel;
  refs: RefsResult;
  baseDir: string;
  /** For the `--slice-ready` contract gate (MIL-238). */
  contract: ContractCheckInput;
  /** The unconditional `em validate` diagnostic set (compile + fs-aware checks). */
  allDiagnostics: Diagnostic[];
}

// ---- units ----

export interface UnitIndex {
  /** Per `model.slices` index: the unit (doc-owning slice) key it folds into. */
  unitOfSlice: string[];
  /** Unit keys in model order. */
  units: string[];
  /** Unit key -> slice index of the unit's own slice. */
  sliceIndexOf: Map<string, number>;
  pattern: Map<string, string>;
  /** The unit doc's current `status:` (null: no doc / unusable frontmatter). */
  docStatus: Map<string, string | null>;
}

export function buildUnitIndex(model: NormalizedModel, refs: RefsResult, baseDir: string): UnitIndex {
  const docsByKey = loadSliceDocsOnce(baseDir);
  const keys = refs.sliceKeys;
  const unitOfSlice: string[] = keys.map((key, i) => {
    const join = joinSliceDocFast(model, refs, model.slices[i], key, docsByKey);
    if (join.continuationOf) return join.continuationOf;
    const own = `slices/${key}.md`;
    if (join.found && join.reason === null && join.path !== own) {
      const other = join.path.replace(/^slices\//, "").replace(/\.md$/, "");
      if (keys.includes(other)) return other;
    }
    return key;
  });
  // A continuation of a covered slice resolves one more hop (rare; the chain is at most 2).
  for (let i = 0; i < unitOfSlice.length; i++) {
    const j = keys.indexOf(unitOfSlice[i]);
    if (j !== -1 && unitOfSlice[j] !== unitOfSlice[i]) unitOfSlice[i] = unitOfSlice[j];
  }
  const units: string[] = [];
  const sliceIndexOf = new Map<string, number>();
  const pattern = new Map<string, string>();
  const docStatus = new Map<string, string | null>();
  for (let i = 0; i < keys.length; i++) {
    if (unitOfSlice[i] !== keys[i]) continue;
    units.push(keys[i]);
    sliceIndexOf.set(keys[i], i);
    pattern.set(keys[i], classifySlicePattern(model.slices[i]));
    const join = joinSliceDocFast(model, refs, model.slices[i], keys[i], docsByKey);
    docStatus.set(keys[i], join.found && join.reason === null ? join.status : null);
  }
  return { unitOfSlice, units, sliceIndexOf, pattern, docStatus };
}

/** Unit of one element: an `again` view instance belongs to its originating declaration. */
function unitOfElement(model: NormalizedModel, idx: UnitIndex, id: string): string | null {
  const el = model.byId.get(id);
  if (!el) return null;
  const origin = el.again ? model.byId.get(el.logicalId) ?? el : el;
  return idx.unitOfSlice[origin.sliceIndex] ?? null;
}

/** Direct unit-level predecessors over the non-`loops-to` edges (self-edges dropped). */
export function unitPredecessors(model: NormalizedModel, idx: UnitIndex): Map<string, Set<string>> {
  const preds = new Map<string, Set<string>>(idx.units.map((u) => [u, new Set<string>()]));
  for (const e of semanticEdges(model)) {
    if (e.source === "loops-to") continue;
    const from = unitOfElement(model, idx, e.from);
    const to = unitOfElement(model, idx, e.to);
    if (!from || !to || from === to) continue;
    preds.get(to)?.add(from);
  }
  return preds;
}

const byOrder = (idx: UnitIndex) => (a: string, b: string) => (idx.sliceIndexOf.get(a) ?? 0) - (idx.sliceIndexOf.get(b) ?? 0);

// ---- selection (`new`) ----

export type Selector = { kind: "slices"; keys: string[] } | { kind: "context"; context: string } | { kind: "downstream-of"; ref: string };

export type SelectionResult = { ok: true; units: string[] } | { ok: false; message: string };

export function resolveSelection(input: { file: string; model: NormalizedModel; refs: RefsResult; baseDir: string }, idx: UnitIndex, sel: Selector): SelectionResult {
  const { model, refs } = input;
  const picked = new Set<string>();
  if (sel.kind === "slices") {
    const unknown = sel.keys.filter((k) => !refs.sliceKeys.includes(k));
    if (unknown.length > 0) return { ok: false, message: `unknown slice key(s): ${unknown.join(", ")}` };
    for (const k of sel.keys) picked.add(idx.unitOfSlice[refs.sliceKeys.indexOf(k)]);
  } else if (sel.kind === "context") {
    const want = sel.context.toLowerCase();
    model.slices.forEach((slice, i) => {
      if (slice.elements.some((el) => el.kind === "event" && (el.context ?? "").toLowerCase() === want)) picked.add(idx.unitOfSlice[i]);
    });
  } else {
    // Starting elements: every element of a named slice, or the one element a ref/display name
    // resolves to (`em query`'s own resolver, so the same inputs work and fail the same way).
    let start: string[];
    const sliceIdx = refs.sliceKeys.indexOf(sel.ref);
    if (sliceIdx !== -1) {
      start = model.slices[sliceIdx].elements.map((el) => el.id);
    } else {
      const system = buildQuerySystem([{ file: input.file, model, refs, index: buildModelIndex(model, refs, input.baseDir) }]);
      const resolved = resolveElement(system, sel.ref);
      if (!resolved.ok) return { ok: false, message: `--downstream-of: ${resolved.error.replace(/^em query: /, "")}` };
      const el = resolved.match.entry.index.byRef.get(resolved.match.ref)!;
      start = [el.id];
    }
    // `em query downstream`'s closure (instances of one read model are one node), minus
    // `loops-to` edges (R22) — a loop back re-feeds an EARLIER view and is not "downstream".
    const out = new Map<string, string[]>();
    for (const e of semanticEdges(model)) {
      if (e.source === "loops-to") continue;
      (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e.to);
    }
    const instances = new Map<string, string[]>();
    for (const el of model.elements) {
      if (el.kind !== "view") continue;
      (instances.get(el.logicalId) ?? instances.set(el.logicalId, []).get(el.logicalId)!).push(el.id);
    }
    const visited = new Set<string>();
    const queue: string[] = [];
    const visit = (id: string) => {
      const el = model.byId.get(id);
      const group = el && el.kind === "view" ? instances.get(el.logicalId) ?? [id] : [id];
      for (const g of group) {
        if (visited.has(g)) continue;
        visited.add(g);
        queue.push(g);
      }
    };
    start.forEach(visit);
    while (queue.length > 0) for (const next of out.get(queue.shift()!) ?? []) visit(next);
    for (const id of visited) {
      const u = unitOfElement(model, idx, id);
      if (u) picked.add(u);
    }
  }
  return { ok: true, units: [...picked].sort(byOrder(idx)) };
}

/** Connected components of the selection, judged over the WHOLE model's non-`loops-to` unit
 *  graph (undirected): two selected slices that share an upstream (e.g. two views over one
 *  foundation event) are related; three lifecycles that never touch are three components. */
export function selectionComponents(units: string[], idx: UnitIndex, preds: Map<string, Set<string>>): string[][] {
  const parent = new Map<string, string>(idx.units.map((u) => [u, u]));
  const find = (u: string): string => {
    let r = u;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(u, r);
    return r;
  };
  for (const [to, froms] of preds) for (const from of froms) {
    const a = find(to);
    const b = find(from);
    if (a !== b) parent.set(a, b);
  }
  const groups = new Map<string, string[]>();
  for (const u of units) {
    const r = find(u);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(u);
  }
  return [...groups.values()];
}

export function formatComponentsWarning(components: string[][]): string {
  const lines = [
    `warn: em engagement new: the selection has ${components.length} unconnected components in the dependency graph — consider ${components.length} engagements:`,
  ];
  components.forEach((c, i) => lines.push(`  ${i + 1}: ${c.join(", ")}`));
  return lines.join("\n");
}

/** Ledger facts (pattern, doc status) for the derived table. */
export function ledgerFacts(idx: UnitIndex, keys: string[]): Map<string, LedgerRowFacts> {
  return new Map(keys.map((k) => [k, { pattern: idx.pattern.get(k) ?? "unknown", docStatus: idx.docStatus.get(k) ?? null }]));
}

// ---- the Ledger join (status, plan) ----

/** R23: `merged` is also inferred (read-only) when the slice doc has reached `implemented`. */
export function effectiveState(entry: EngagementSliceEntry, docStatus: string | null): { state: LedgerState; stateInferred: boolean } {
  if (entry.state !== "merged" && docStatus === "implemented") return { state: "merged", stateInferred: true };
  return { state: entry.state, stateInferred: false };
}

export interface EngagementStatusSlice {
  key: string;
  pattern: string;
  docStatus: string | null;
  state: LedgerState;
  stateInferred: boolean;
  heldBy: "human" | null;
  branch: string | null;
  base: string | null;
  pr: string | null;
}

export interface EngagementStatus {
  file: string;
  engagement: string;
  slug: string;
  status: "open" | "closed";
  created: string;
  createdBy: string | null;
  parallel: number;
  slices: EngagementStatusSlice[];
  counts: Record<LedgerState, number>;
  /** R25: every slice is `merged` (recorded or inferred) or `gap`. */
  closable: boolean;
}

export function buildEngagementStatus(file: string, engagementFile: string, eng: EngagementFile, idx: UnitIndex): EngagementStatus {
  const counts = Object.fromEntries(LEDGER_STATES.map((s) => [s, 0])) as Record<LedgerState, number>;
  const slices = eng.slices.map((e) => {
    const docStatus = idx.docStatus.get(e.key) ?? null;
    const { state, stateInferred } = effectiveState(e, docStatus);
    counts[state]++;
    return {
      key: e.key,
      pattern: idx.pattern.get(e.key) ?? "unknown",
      docStatus,
      state,
      stateInferred,
      heldBy: e.heldBy ?? null,
      branch: e.branch,
      base: e.base,
      pr: e.pr,
    };
  });
  const closable = slices.every((s) => s.state === "merged" || s.state === "gap");
  return {
    file,
    engagement: engagementFile,
    slug: eng.slug,
    status: eng.status,
    created: eng.created,
    createdBy: eng.createdBy,
    parallel: eng.parallel,
    slices,
    counts,
    closable,
  };
}

export function formatEngagementStatusText(s: EngagementStatus): string {
  const by = s.createdBy ? ` by ${s.createdBy}` : "";
  const lines = [`engagement "${s.slug}" (${s.status}) — ${s.slices.length} slice(s), parallel ${s.parallel}, created ${s.created}${by}`];
  for (const x of s.slices) {
    const state = `${x.state}${x.stateInferred ? " (inferred: doc implemented)" : ""}${x.heldBy ? ` (${x.heldBy})` : ""}`;
    const extra = [x.branch ? `branch ${x.branch}` : null, x.base ? `base ${x.base}` : null, x.pr ? `pr ${x.pr}` : null].filter(Boolean).join(" · ");
    lines.push(`  ${x.key} [${x.pattern}] doc: ${x.docStatus ?? "(no doc)"} · state: ${state}${extra ? ` · ${extra}` : ""}`);
  }
  const open = s.slices.filter((x) => x.state !== "merged" && x.state !== "gap").length;
  lines.push(s.closable ? "closable: yes — every slice is merged or gap" : `closable: no — ${open} slice(s) not merged or gap`);
  return lines.join("\n");
}

// ---- the plan ----

export const HOLD_REASONS = ["not-ready", "upstream-outside-engagement-unmerged", "multiple-unmerged-upstreams"] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

export interface EngagementPlanSlice {
  key: string;
  pattern: string;
  docStatus: string | null;
  ready: boolean;
  readyDiagnostics: ReturnType<typeof serializeDiagnostic>[];
  level: number;
  /** Direct upstreams inside the engagement (model order). */
  upstreams: string[];
  branch: string;
  /** `main`, `impl/<upstream>` (exactly one in-engagement upstream unmerged), or null (≥2). */
  base: string | null;
  /** The plan's own computed hold (R23) — never written to the Ledger. */
  planHeld: HoldReason | null;
  /** `planHeld`, else `"human"` when the Ledger records a human hold, else null. */
  held: HoldReason | "human" | null;
  state: LedgerState;
  stateInferred: boolean;
}

export interface EngagementPlanLevel {
  level: number;
  width: number;
  ceiling: number;
  slices: string[];
}

export interface EngagementPlan {
  file: string;
  engagement: string;
  slug: string;
  status: "open" | "closed";
  parallel: number;
  levels: EngagementPlanLevel[];
  slices: EngagementPlanSlice[];
}

export type PlanResult = { ok: true; plan: EngagementPlan } | { ok: false; message: string };

/** Names the engagement keys the current model no longer has as units, or null. */
export function missingKeys(eng: EngagementFile, idx: UnitIndex): string[] {
  return eng.slices.map((e) => e.key).filter((k) => !idx.sliceIndexOf.has(k));
}

export function buildEngagementPlan(input: EngagementModelInput, engagementFile: string, eng: EngagementFile, idx: UnitIndex): PlanResult {
  const preds = unitPredecessors(input.model, idx);
  const members = eng.slices.map((e) => e.key);
  const memberSet = new Set(members);
  const order = byOrder(idx);
  const inPreds = new Map(members.map((k) => [k, [...(preds.get(k) ?? [])].filter((p) => memberSet.has(p)).sort(order)]));

  // Levels: longest path from an in-engagement root (Kahn's algorithm).
  const level = new Map<string, number>();
  let remaining = [...members];
  while (remaining.length > 0) {
    const next = remaining.filter((k) => inPreds.get(k)!.every((p) => level.has(p)));
    if (next.length === 0) return { ok: false, message: `the engagement's dependency graph has a cycle (loops-to edges already excluded): ${describeCycle(remaining, inPreds)}` };
    for (const k of next) level.set(k, Math.max(-1, ...inPreds.get(k)!.map((p) => level.get(p)!)) + 1);
    remaining = remaining.filter((k) => !level.has(k));
  }

  const entryOf = new Map(eng.slices.map((e) => [e.key, e]));
  const mergedOf = (k: string): boolean => {
    const e = entryOf.get(k);
    const doc = idx.docStatus.get(k) ?? null;
    return e ? effectiveState(e, doc).state === "merged" : doc === "implemented";
  };

  const slices: EngagementPlanSlice[] = members.map((key) => {
    const entry = entryOf.get(key)!;
    const docStatus = idx.docStatus.get(key) ?? null;
    const { state, stateInferred } = effectiveState(entry, docStatus);
    const { scoped, ready } = computeSliceReadiness(input.model, input.refs, input.baseDir, key, input.contract, input.allDiagnostics);
    const upstreams = inPreds.get(key)!;
    const unmergedIn = upstreams.filter((p) => !mergedOf(p));
    const unmergedOut = [...(preds.get(key) ?? [])].filter((p) => !memberSet.has(p) && idx.docStatus.get(p) !== "implemented");
    let planHeld: HoldReason | null = null;
    if (state !== "merged") {
      if (!ready) planHeld = "not-ready";
      else if (unmergedOut.length > 0) planHeld = "upstream-outside-engagement-unmerged";
      else if (unmergedIn.length >= 2) planHeld = "multiple-unmerged-upstreams";
    }
    const base = unmergedIn.length >= 2 ? null : unmergedIn.length === 1 ? `impl/${unmergedIn[0]}` : "main";
    return {
      key,
      pattern: idx.pattern.get(key) ?? "unknown",
      docStatus,
      ready,
      readyDiagnostics: scoped.map(serializeDiagnostic),
      level: level.get(key)!,
      upstreams,
      branch: `impl/${key}`,
      base,
      planHeld,
      held: planHeld ?? (entry.heldBy === "human" && state === "held" ? "human" : null),
      state,
      stateInferred,
    };
  });

  const maxLevel = Math.max(-1, ...slices.map((s) => s.level));
  const levels: EngagementPlanLevel[] = [];
  for (let l = 0; l <= maxLevel; l++) {
    const at = slices.filter((s) => s.level === l).map((s) => s.key);
    levels.push({ level: l, width: at.length, ceiling: eng.parallel, slices: at });
  }
  // Slices listed level by level, model order within a level.
  slices.sort((a, b) => a.level - b.level || order(a.key, b.key));
  return { ok: true, plan: { file: input.file, engagement: engagementFile, slug: eng.slug, status: eng.status, parallel: eng.parallel, levels, slices } };
}

/** Walk predecessors among the unlevelled nodes until one repeats: `a -> b -> a` (upstream
 *  first). Every unlevelled node has an unlevelled predecessor, so the walk always closes. */
function describeCycle(remaining: string[], inPreds: Map<string, string[]>): string {
  const left = new Set(remaining);
  const path: string[] = [];
  let cur = remaining[0];
  while (!path.includes(cur)) {
    path.push(cur);
    cur = inPreds.get(cur)!.find((p) => left.has(p))!;
  }
  const cycle = path.slice(path.indexOf(cur));
  cycle.reverse();
  return [...cycle, cycle[0]].join(" -> ");
}

export function formatEngagementPlanText(p: EngagementPlan): string {
  const lines = [`engagement "${p.slug}" (${p.status}) — ${p.slices.length} slice(s) in ${p.levels.length} level(s), parallel ${p.parallel}`];
  for (const lvl of p.levels) {
    lines.push(`level ${lvl.level}: ${lvl.width} slice${lvl.width === 1 ? "" : "s"} (ceiling ${lvl.ceiling})`);
    for (const s of p.slices.filter((x) => x.level === lvl.level)) {
      const held = s.held ? ` · held: ${s.held}` : "";
      const inferred = s.stateInferred ? " (inferred)" : "";
      lines.push(`  ${s.key} [${s.pattern}] ${s.branch} on ${s.base ?? "(none)"} · state: ${s.state}${inferred}${held}`);
    }
  }
  return lines.join("\n");
}

// ---- load + build (shared by the CLI actions and the MCP tools) ----

export function engagementPlanFor(input: EngagementModelInput, slug: string): PlanResult {
  const loaded = loadEngagement(input.file, slug);
  if (!loaded.ok) return loaded;
  const idx = buildUnitIndex(input.model, input.refs, input.baseDir);
  const missing = missingKeys(loaded.file, idx);
  if (missing.length > 0) return { ok: false, message: missingMessage(slug, missing) };
  return buildEngagementPlan(input, loaded.path, loaded.file, idx);
}

export type StatusResult = { ok: true; status: EngagementStatus } | { ok: false; message: string };

export function engagementStatusFor(input: { file: string; model: NormalizedModel; refs: RefsResult; baseDir: string }, slug: string): StatusResult {
  const loaded = loadEngagement(input.file, slug);
  if (!loaded.ok) return loaded;
  const idx = buildUnitIndex(input.model, input.refs, input.baseDir);
  const missing = missingKeys(loaded.file, idx);
  if (missing.length > 0) return { ok: false, message: missingMessage(slug, missing) };
  return { ok: true, status: buildEngagementStatus(input.file, loaded.path, loaded.file, idx) };
}

export function missingMessage(slug: string, missing: string[]): string {
  return `engagement "${slug}" names slice(s) the model no longer has as a doc-owning slice: ${missing.join(", ")}`;
}

// ---- writes (`new`, `set`, `close`): pure text in, text out; the CLI owns the fs ----

export interface NewEngagementOptions {
  slug: string;
  selector: Selector;
  parallel: number;
  createdBy: string | null;
  created: string;
}

export type NewResult = { ok: true; text: string; units: string[]; warning: string | null } | { ok: false; message: string };

export function buildNewEngagement(input: { file: string; model: NormalizedModel; refs: RefsResult; baseDir: string }, opts: NewEngagementOptions): NewResult {
  if (!SLUG_RE.test(opts.slug)) return { ok: false, message: `invalid slug "${opts.slug}" — expected kebab-case (a-z, 0-9, -)` };
  if (!Number.isInteger(opts.parallel) || opts.parallel < 1) return { ok: false, message: "--parallel must be a positive integer" };
  const idx = buildUnitIndex(input.model, input.refs, input.baseDir);
  const sel = resolveSelection(input, idx, opts.selector);
  if (!sel.ok) return sel;
  if (sel.units.length === 0) return { ok: false, message: "the selection is empty — nothing to engage" };
  const preds = unitPredecessors(input.model, idx);
  const components = selectionComponents(sel.units, idx, preds);
  const fm: EngagementFile = {
    engagementSchemaVersion: ENGAGEMENT_SCHEMA_VERSION,
    slug: opts.slug,
    model: modelRefFor(engagementPath(input.file, opts.slug), input.file),
    created: opts.created,
    createdBy: opts.createdBy,
    parallel: opts.parallel,
    status: "open",
    slices: sel.units.map((key) => ({ key, state: "planned", branch: null, base: null, pr: null })),
  };
  return {
    ok: true,
    text: renderEngagementFile(fm, buildLedgerLines(fm.slices, ledgerFacts(idx, sel.units))),
    units: sel.units,
    warning: components.length > 1 ? formatComponentsWarning(components) : null,
  };
}

export interface SetOptions {
  key: string;
  state: string;
  branch?: string;
  base?: string;
  pr?: string;
}

export type SetResult = { ok: true; changed: boolean; text: string; entry: EngagementSliceEntry } | { ok: false; message: string };

/** R23: any state is settable, same-state-and-fields is a no-op, `merged` is terminal, `held`
 *  records `heldBy: human`. Splices the one entry line and regenerates the Ledger region. */
export function applyEngagementSet(
  input: { file: string; model: NormalizedModel; refs: RefsResult; baseDir: string },
  slug: string,
  text: string,
  eng: EngagementFile,
  opts: SetOptions,
): SetResult {
  if (!isLedgerState(opts.state)) return { ok: false, message: `invalid --state "${opts.state}" — expected one of: ${LEDGER_STATES.join(", ")}` };
  if (eng.status === "closed") return { ok: false, message: `engagement "${slug}" is closed` };
  const current = eng.slices.find((e) => e.key === opts.key);
  if (!current) return { ok: false, message: `slice "${opts.key}" is not in engagement "${slug}"` };
  const next: EngagementSliceEntry = {
    key: current.key,
    state: opts.state,
    branch: opts.branch ?? current.branch,
    base: opts.base ?? current.base,
    pr: opts.pr ?? current.pr,
  };
  if (opts.state === "held") next.heldBy = "human";
  const same = formatSliceEntryLine(next) === formatSliceEntryLine(current);
  if (current.state === "merged" && !same) return { ok: false, message: `slice "${opts.key}" is merged — merged is terminal` };
  if (same) return { ok: true, changed: false, text, entry: current };
  const spliced = spliceSliceEntry(text, next);
  if (spliced === null) return { ok: false, message: `slice "${opts.key}"'s slices entry is not on one line — the file was hand-edited; restore the one-line entry shape` };
  const idx = buildUnitIndex(input.model, input.refs, input.baseDir);
  const slices = eng.slices.map((e) => (e.key === next.key ? next : e));
  const withLedger = spliceLedger(spliced, buildLedgerLines(slices, ledgerFacts(idx, slices.map((e) => e.key))));
  if (withLedger === null) return { ok: false, message: `the Ledger markers (<!-- GENERATED:${LEDGER_MARKER}:start/end -->) are missing — the file was hand-edited` };
  return { ok: true, changed: true, text: withLedger, entry: next };
}

export type CloseResult = { ok: true; changed: boolean; text: string } | { ok: false; message: string };

/** R25: closes only when every slice is merged (recorded or inferred) or gap. */
export function applyEngagementClose(slug: string, text: string, status: EngagementStatus): CloseResult {
  if (status.status === "closed") return { ok: true, changed: false, text };
  if (!status.closable) {
    const open = status.slices.filter((s) => s.state !== "merged" && s.state !== "gap").map((s) => `${s.key} (${s.state})`);
    return { ok: false, message: `engagement "${slug}" is not closable — every slice must be merged or gap; still open: ${open.join(", ")}` };
  }
  const spliced = spliceStatus(text, "closed");
  if (spliced === null) return { ok: false, message: "no status: line in the frontmatter — the file was hand-edited" };
  return { ok: true, changed: true, text: spliced };
}
