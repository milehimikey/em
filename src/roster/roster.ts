// SPDX-License-Identifier: MIT
// The optional ratifier roster (GH #259): `ratifiers.yaml` beside the model — a host-supplied list
// of who may sign slice docs. File absent = em behaves exactly as before (any non-empty name);
// file present = `em slice ratify --by` / `em slice review --by` refuse a name the roster does not
// permit for the slice's context(s), and `em validate --slice-ready` reports a hand-edited
// `ratifiedBy` that is not on it (`ratified-by-not-in-roster`).
//
// Placement follows `system.yaml`: the nearest `ratifiers.yaml` walking up from the model's
// directory to the repo root, so one roster can serve several models; an explicit path overrides.
// Pure parsing (`parseRoster`) is separate from filesystem discovery (`loadRoster`).

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { LineCounter, parseDocument, isMap, isSeq, isScalar, Node, Pair } from "yaml";
import type { Diagnostic } from "../model/validate.js";
import { normalizeName, type NormalizedModel } from "../model/model.js";
import { computeModelKey } from "../model/qualifiedRef.js";
import { pushDiag } from "../model/rules.js";

export const ROSTER_FILE = "ratifiers.yaml";
export const ROSTER_SCHEMA_VERSION = "1.0";

export interface RosterEntry {
  name: string;
  /** Contexts this person may sign for; `null` = the whole model. Stored without a leading `@`. */
  contexts: string[] | null;
  /** Model keys (as `em export` reports `model.key`) this entry applies to; `null` = every model
   *  the roster governs. */
  models: string[] | null;
}

/** em's own migration marker (`em upgrade`'s `ratified-signoff`), not a signer: exempt from roster checks. */
export function isGrandfatheredSignoff(name: string | null | undefined): boolean {
  return !!name && /^grandfathered\b/i.test(name.trim());
}

export interface Roster {
  rosterSchemaVersion: string;
  /** `null` = the file has no `ratifiers:` key, so ratification is not restricted. */
  ratifiers: RosterEntry[] | null;
  /** `null` = no `reviewers:` key, so review is not restricted. */
  reviewers: RosterEntry[] | null;
}

export type ParseRosterResult = { ok: true; roster: Roster } | { ok: false; diagnostics: Diagnostic[] };

const TOP_KEYS = new Set(["rosterSchemaVersion", "ratifiers", "reviewers"]);
const ENTRY_KEYS = new Set(["name", "contexts", "models"]);

function scalarString(node: unknown): string | undefined {
  return isScalar(node) && typeof node.value === "string" ? node.value : undefined;
}

export function normalizeContext(c: string): string {
  return c.trim().replace(/^@/, "");
}

/** Parse and shape-check roster text. Every problem is a `roster-invalid` error (never a throw);
 *  `ok: false` means the roster cannot be used, and callers refuse rather than fall back to open. */
export function parseRoster(text: string): ParseRosterResult {
  const diagnostics: Diagnostic[] = [];
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false });
  const lineOf = (n: Node | Pair | null | undefined): number | undefined => {
    const range = n && "range" in n ? n.range : n && "key" in n ? (n.key as Node | null)?.range : undefined;
    return range ? lc.linePos(range[0]).line : undefined;
  };
  const invalid = (message: string, line?: number) => pushDiag(diagnostics, "roster-invalid", { message, line });

  if (doc.errors.length > 0) {
    for (const e of doc.errors) invalid(`YAML parse error: ${e.message.trim()}`, e.linePos?.[0]?.line);
    return { ok: false, diagnostics };
  }
  const root = doc.contents;
  if (!isMap(root)) {
    invalid("roster must be a YAML mapping with `rosterSchemaVersion` and `ratifiers` and/or `reviewers`");
    return { ok: false, diagnostics };
  }
  const versionNode = root.get("rosterSchemaVersion", true) as Node | undefined;
  const version = scalarString(versionNode);
  if (version === undefined) {
    invalid(`missing or non-string \`rosterSchemaVersion\` — set \`rosterSchemaVersion: "${ROSTER_SCHEMA_VERSION}"\``, lineOf(versionNode));
  } else if (version !== ROSTER_SCHEMA_VERSION) {
    invalid(`unsupported rosterSchemaVersion "${version}" — this em accepts "${ROSTER_SCHEMA_VERSION}"`, lineOf(versionNode));
  }
  for (const pair of root.items) {
    const key = scalarString(pair.key);
    if (key === undefined || !TOP_KEYS.has(key)) {
      invalid(`unknown top-level key ${JSON.stringify(key ?? "?")} — expected one of: ${[...TOP_KEYS].join(", ")}`, lineOf(pair));
    }
  }

  const readList = (key: "ratifiers" | "reviewers"): RosterEntry[] | null => {
    const node = root.get(key, true) as Node | undefined;
    if (node === undefined) return null;
    if (!isSeq(node) || node.items.length === 0) {
      invalid(`\`${key}\` must be a non-empty list of { name, contexts? } entries (omit the key to leave it unrestricted)`, lineOf(node));
      return null;
    }
    const out: RosterEntry[] = [];
    for (const item of node.items) {
      if (!isMap(item)) {
        invalid(`\`${key}\` entries must be mappings with a \`name\` (and optional \`contexts\`)`, lineOf(item as Node));
        continue;
      }
      for (const p of item.items) {
        const k = scalarString(p.key);
        if (k === undefined || !ENTRY_KEYS.has(k)) invalid(`${key}: unknown key ${JSON.stringify(k ?? "?")} — expected name, contexts, models`, lineOf(p));
      }
      const name = scalarString(item.get("name", true));
      if (name === undefined || name.trim() === "") {
        invalid(`${key}: every entry needs a non-empty string \`name\``, lineOf(item));
        continue;
      }
      const ctxNode = item.get("contexts", true) as Node | undefined;
      let contexts: string[] | null = null;
      if (ctxNode !== undefined) {
        const names = isSeq(ctxNode) ? ctxNode.items.map((i) => scalarString(i)) : [];
        if (!isSeq(ctxNode) || names.length === 0 || names.some((n) => n === undefined || n.trim() === "")) {
          invalid(`${key}: "${name}": \`contexts\` must be a non-empty list of context names (omit it for the whole model)`, lineOf(ctxNode));
          continue;
        }
        contexts = (names as string[]).map(normalizeContext);
      }
      const modelsNode = item.get("models", true) as Node | undefined;
      let models: string[] | null = null;
      if (modelsNode !== undefined) {
        const keys = isSeq(modelsNode) ? modelsNode.items.map((i) => scalarString(i)) : [];
        if (!isSeq(modelsNode) || keys.length === 0 || keys.some((n) => n === undefined || n.trim() === "")) {
          invalid(`${key}: "${name}": \`models\` must be a non-empty list of model keys (omit it to apply to every model)`, lineOf(modelsNode));
          continue;
        }
        models = (keys as string[]).map((k) => k.trim());
      }
      out.push({ name: name.trim(), contexts, models });
    }
    return out;
  };
  const ratifiers = readList("ratifiers");
  const reviewers = readList("reviewers");
  if (root.get("ratifiers", true) === undefined && root.get("reviewers", true) === undefined) {
    invalid("a roster needs `ratifiers:` and/or `reviewers:`");
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, roster: { rosterSchemaVersion: version!, ratifiers, reviewers } };
}

export type LoadedRoster =
  | { state: "absent" }
  | { state: "present"; path: string; roster: Roster }
  | { state: "invalid"; path: string; diagnostics: Diagnostic[] };

/** The nearest `ratifiers.yaml` walking up from `startDir`, stopping at the nearest directory that
 *  holds `.git` (a directory or a file) or at the filesystem root. When no `.git` exists anywhere
 *  above, only `startDir` itself is searched -- without a repo root there is no principled place
 *  to stop, and a roster in some unrelated parent must not govern the model. */
export function findRosterAbove(startDir: string): string | null {
  let hasGit = false;
  for (let d = safeReal(resolve(startDir)); ; ) {
    if (existsSync(join(d, ".git"))) {
      hasGit = true;
      break;
    }
    const p = dirname(d);
    if (p === d) break;
    d = p;
  }
  let dir = startDir;
  let abs = safeReal(resolve(dir));
  for (;;) {
    const candidate = join(dir, ROSTER_FILE);
    if (existsSync(candidate)) return normalize(candidate).split(sep).join("/");
    if (!hasGit || existsSync(join(abs, ".git"))) return null;
    const parent = dirname(abs);
    if (parent === abs) return null;
    abs = parent;
    dir = join(dir, "..");
  }
}

function safeReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Discover (or take an explicit `override` path) and parse the roster for a model in `baseDir`.
 *  An explicit path that does not exist is `invalid` — asking for a roster and not finding it must
 *  not silently mean "no roster". */
export function loadRoster(baseDir: string, override?: string, modelCtx?: RosterModelContext): LoadedRoster {
  let path: string | null;
  if (override !== undefined) {
    path = override;
    if (!existsSync(path)) {
      const diagnostics: Diagnostic[] = [];
      pushDiag(diagnostics, "roster-invalid", { message: `roster file ${path} does not exist` });
      return { state: "invalid", path, diagnostics };
    }
  } else {
    path = findRosterAbove(baseDir);
    if (path === null) return { state: "absent" };
  }
  const parsed = parseRoster(readFileSync(path, "utf8"));
  if (!parsed.ok) return { state: "invalid", path, diagnostics: parsed.diagnostics };
  if (modelCtx) {
    const problems = validateRosterForModel(parsed.roster, modelCtx);
    if (problems.length > 0) return { state: "invalid", path, diagnostics: problems };
  }
  return { state: "present", path, roster: parsed.roster };
}

/** What a roster is validated against: the model it governs (and, when a system.yaml is known,
 *  its model keys). */
export interface RosterModelContext {
  model: NormalizedModel;
  /** The model key `em export` reports; entries scoped to other models are not checked here. */
  modelKey: string;
  /** Every model key of the enclosing system, when one is known; `models:` entries must name one. */
  systemModelKeys?: string[];
}

export function rosterModelContext(model: NormalizedModel, file: string, systemModelKeys?: string[]): RosterModelContext {
  return { model, modelKey: computeModelKey(model, file), systemModelKeys };
}

/** `roster-invalid` for a `contexts:` entry the model does not declare (case-sensitive) -- checked
 *  only for entries that apply to this model -- and for a `models:` key the enclosing system does
 *  not have. */
export function validateRosterForModel(roster: Roster, ctx: RosterModelContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const role of ["ratifiers", "reviewers"] as const) {
    for (const e of roster[role] ?? []) {
      if (e.models && ctx.systemModelKeys) {
        for (const k of e.models) {
          if (!ctx.systemModelKeys.includes(k)) {
            pushDiag(diagnostics, "roster-invalid", { message: `${role}: "${e.name}": \`models\` names "${k}", which is not a model of the system (${ctx.systemModelKeys.join(", ")})` });
          }
        }
      }
      if (!appliesToModel(e, ctx.modelKey) || !e.contexts) continue;
      for (const c of e.contexts) {
        if (!ctx.model.contexts.includes(c)) {
          pushDiag(diagnostics, "roster-invalid", {
            message: `${role}: "${e.name}": unknown context "${c}" for model "${ctx.modelKey}" (declared: ${ctx.model.contexts.join(", ")})`,
          });
        }
      }
    }
  }
  return diagnostics;
}

function appliesToModel(e: RosterEntry, modelKey: string | undefined): boolean {
  return e.models === null || modelKey === undefined || e.models.includes(modelKey);
}

/** The contexts of a slice: those of its events, plus those of the events its views read (every
 *  instance of a read model -- `again` instances included -- contributes its `from`, so a
 *  continuation slice takes its originating view's events). A slice with neither has none. */
export function sliceContexts(model: NormalizedModel, sliceIndex: number): string[] {
  const out: string[] = [];
  const add = (c: string | undefined) => {
    if (c && !out.includes(c)) out.push(c);
  };
  const slice = model.slices[sliceIndex];
  for (const el of slice?.elements ?? []) if (el.kind === "event") add(el.context);
  const views = new Set((slice?.elements ?? []).filter((e) => e.kind === "view").map((e) => e.logicalId));
  if (views.size > 0) {
    const byName = new Map<string, string[]>();
    for (const s of model.slices) {
      for (const el of s.elements) {
        if (el.kind !== "event" || !el.context) continue;
        const k = normalizeName(el.name);
        byName.set(k, [...(byName.get(k) ?? []), el.context]);
      }
    }
    for (const s of model.slices) {
      for (const el of s.elements) {
        if (el.kind !== "view" || !views.has(el.logicalId)) continue;
        for (const from of el.from ?? []) for (const c of byName.get(normalizeName(from)) ?? []) add(c);
      }
    }
  }
  return out;
}

/** An entry permits a slice when it applies to the model and either carries no `contexts` or lists
 *  EVERY context of the slice. A slice with no context of its own is permitted only by entries
 *  without `contexts`. */
function permits(entry: RosterEntry, contexts: string[], modelKey?: string): boolean {
  if (!appliesToModel(entry, modelKey)) return false;
  if (entry.contexts === null) return true;
  return contexts.length > 0 && contexts.every((c) => entry.contexts!.includes(normalizeContext(c)));
}

export type RosterRole = "ratifiers" | "reviewers";

/** `null` = allowed (including: this role is unrestricted). Otherwise the refusal text. */
export function rosterRefusal(roster: Roster, role: RosterRole, name: string, contexts: string[], modelKey?: string): string | null {
  const list = roster[role];
  if (list === null) return null;
  const trimmed = name.trim();
  if (list.some((e) => e.name === trimmed && permits(e, contexts, modelKey))) return null;
  const permitted = [...new Set(list.filter((e) => permits(e, contexts, modelKey)).map((e) => e.name))];
  const where = contexts.length > 0 ? `context ${contexts.join(" + ")}` : "this slice";
  const who = permitted.length > 0 ? `permitted: ${permitted.join(", ")}` : "nobody is permitted for it";
  return `"${trimmed}" is not on the ${role} roster for ${where} (${who})`;
}

/** Resolve a roster check for a CLI/MCP write path: `null` = proceed, else the refusal message. */
export function checkRosterForWrite(
  loaded: LoadedRoster,
  role: RosterRole,
  name: string,
  model: NormalizedModel,
  sliceIndex: number,
  modelKey?: string,
): string | null {
  if (loaded.state === "absent") return null;
  if (loaded.state === "invalid") return `roster ${loaded.path} is invalid — ${loaded.diagnostics.map((d) => d.message).join("; ")}`;
  const msg = rosterRefusal(loaded.roster, role, name, sliceContexts(model, sliceIndex), modelKey);
  return msg === null ? null : `${msg} — roster: ${loaded.path}`;
}
