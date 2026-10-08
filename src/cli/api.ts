// SPDX-License-Identifier: MIT
// `em api generate | check` (MIL-237): the contract path convention (briefing R6), the
// "is the committed contract current" text comparison, and the structural public-surface diff
// that annotates each change additive or breaking (briefing R8/R12). Pure where it can be —
// fs/git reads go through injectable readers so the diff and the classification are unit-
// testable without a repository; cli.ts and the MCP `api_check` tool share `runApiCheck`.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { normalizeName } from "../model/model.js";
import { computeModelKey } from "../model/qualifiedRef.js";
import { hasErrors, Diagnostic } from "../model/validate.js";
import { compile } from "../pipeline.js";
import { ParseError } from "../parser/parser.js";
import { buildApiContract, publicSurfaceOf } from "../emit/api.js";
import { buildExportDoc, ElementExport, FieldExport, TypeExport } from "../emit/json.js";
import { kebabSlug } from "../util/slug.js";
import { GitRunner, realGit, resolveRevision } from "./diff-inputs.js";

/** `<modelDir>/contracts/<modelKey>.tsp` (R6), built from the model path as given. */
export function contractPathFor(modelFile: string, modelKey: string): string {
  return join(dirname(modelFile), "contracts", `${modelKey}.tsp`);
}

/** The `Source:` label: the model path relative to the contract file's directory, `/`-separated,
 *  so the generated text never depends on the cwd `em api generate` ran from. */
export function sourceLabelFor(modelFile: string, contractFile: string): string {
  return relative(dirname(resolve(contractFile)), resolve(modelFile)).split(sep).join("/");
}

export interface GeneratedContract {
  modelKey: string;
  contractPath: string;
  /** Full file text, trailing newline included. */
  text: string;
  diagnostics: Diagnostic[];
}

/** Compile result + generated contract text for an error-free model. */
export function generateContract(
  file: string,
  source: string,
  compiled: ReturnType<typeof compile>,
  outPath?: string,
): GeneratedContract {
  const modelKey = computeModelKey(compiled.model, file);
  const contractPath = outPath ?? contractPathFor(file, modelKey);
  const result = buildApiContract(
    compiled.model,
    compiled.refs,
    compiled.diagnostics,
    source,
    file,
    sourceLabelFor(file, contractPath),
  );
  return { modelKey, contractPath, text: result.text + "\n", diagnostics: result.diagnostics };
}

// ---- Structural public-surface diff (R8) ------------------------------------------------

export type ApiChangeKind = "additive" | "breaking";

export interface ApiCheckChange {
  kind: ApiChangeKind;
  /** `<kind>.<slug>` of the element (or `type.<slug>` for a declared type) — contract-level
   *  identity, no slice key (moving an element between slices does not change the contract). */
  element: string;
  /** The field the change concerns, or null for an element-level change. */
  field: string | null;
  what: string;
}

type Role = "input" | "output";

interface SurfaceEntry {
  /** command | event | view | type */
  kind: string;
  name: string;
  /** Normalized identity key: kind + normalizeName(name). */
  key: string;
  fields: FieldExport[];
  renamedFrom: string[];
  roles: Set<Role>;
}

interface Surface {
  entries: SurfaceEntry[];
  /** Normalized `kind:name` of every element present in the model, public or not — tells
   *  "`public` dropped" apart from "removed". */
  allElements: Set<string>;
}

const keyOf = (kind: string, name: string) => `${kind}:${normalizeName(name)}`;


/** Build the public surface of one compiled model: public commands (input), events and views
 *  (output), and every declared type reachable from them (carrying the roles that reach it). */
export function surfaceOf(slices: { elements: ElementExport[] }[], types: TypeExport[]): Surface {
  const s = publicSurfaceOf(slices);
  const entries: SurfaceEntry[] = [];
  const typesByRef = new Map(types.map((t) => [t.ref, t]));
  const typeRoles = new Map<string, Set<Role>>();
  const reach = (fields: FieldExport[] | null, role: Role) => {
    for (const f of fields ?? []) {
      if (!f.typeRef) continue;
      const roles = typeRoles.get(f.typeRef.ref) ?? new Set<Role>();
      if (roles.has(role)) continue;
      roles.add(role);
      typeRoles.set(f.typeRef.ref, roles);
      reach(typesByRef.get(f.typeRef.ref)?.fields ?? null, role);
    }
  };
  const push = (el: ElementExport, role: Role) => {
    entries.push({
      kind: el.kind,
      name: el.name,
      key: keyOf(el.kind, el.name),
      fields: el.fields ?? [],
      renamedFrom: el.renamedFrom ?? [],
      roles: new Set([role]),
    });
    reach(el.fields, role);
  };
  for (const el of s.commands) push(el, "input");
  for (const el of s.events) push(el, "output");
  for (const el of s.views) push(el, "output");
  for (const t of types) {
    const roles = typeRoles.get(t.ref);
    if (!roles) continue;
    entries.push({ kind: "type", name: t.name, key: keyOf("type", t.name), fields: t.fields, renamedFrom: [], roles });
  }
  const allElements = new Set<string>();
  for (const slice of slices) for (const el of slice.elements) allElements.add(keyOf(el.kind, el.name));
  for (const t of types) allElements.add(keyOf("type", t.name));
  return { entries, allElements };
}

/** A field's type as the contract sees it: a declared type's name or the raw string,
 *  normalized, with its array arity. */
function typeLabel(f: FieldExport): string {
  if (f.typeRef) return `${f.typeRef.name}${f.typeRef.array ? "[]" : ""}`;
  return f.type ?? "(none)";
}
function typeIdentity(f: FieldExport): string {
  if (f.typeRef) return `ref:${f.typeRef.ref}:${f.typeRef.array}`;
  return `raw:${(f.type ?? "").replace(/\s+/g, "").toLowerCase()}`;
}

function diffFields(base: SurfaceEntry, head: SurfaceEntry, element: string, out: ApiCheckChange[]): void {
  const roles = new Set([...base.roles, ...head.roles]);
  const isInput = roles.has("input");
  const isOutput = roles.has("output");
  const headByName = new Map(head.fields.map((f) => [normalizeName(f.name), f]));
  const baseByName = new Map(base.fields.map((f) => [normalizeName(f.name), f]));
  // HEAD field -> base field it renames (a `renamed from` naming a base field that HEAD no
  // longer carries under its old name).
  const renamedTo = new Map<string, FieldExport>();
  for (const f of head.fields) {
    if (baseByName.has(normalizeName(f.name))) continue;
    for (const old of f.renamedFrom ?? []) {
      const k = normalizeName(old);
      if (baseByName.has(k) && !headByName.has(k) && !renamedTo.has(k)) {
        renamedTo.set(k, f);
        break;
      }
    }
  }
  const compare = (b: FieldExport, h: FieldExport) => {
    if (typeIdentity(b) !== typeIdentity(h)) {
      out.push({ kind: "breaking", element, field: h.name, what: `type changed ${typeLabel(b)} → ${typeLabel(h)}` });
    }
    if (b.optional !== h.optional) {
      if (h.optional) {
        // required → optional: outputs may now omit it (breaking); inputs only loosen.
        out.push({ kind: isOutput ? "breaking" : "additive", element, field: h.name, what: "changed required → optional" });
      } else {
        out.push({ kind: "breaking", element, field: h.name, what: "changed optional → required" });
      }
    }
  };
  // Base order first: removals, renames and changes to existing fields.
  for (const b of base.fields) {
    const k = normalizeName(b.name);
    const h = headByName.get(k);
    if (h) {
      compare(b, h);
      continue;
    }
    const renamed = renamedTo.get(k);
    if (renamed) {
      out.push({ kind: "breaking", element, field: renamed.name, what: `renamed from "${b.name}"` });
      compare(b, renamed);
      continue;
    }
    out.push({ kind: "breaking", element, field: b.name, what: "removed" });
  }
  // Then HEAD-only fields, HEAD order.
  const renameTargets = new Set([...renamedTo.values()]);
  for (const h of head.fields) {
    if (baseByName.has(normalizeName(h.name)) || renameTargets.has(h)) continue;
    const required = !h.optional;
    // Adding a required input is breaking (existing callers do not send it); adding to an
    // output is additive (consumers tolerate unknown fields).
    const kind: ApiChangeKind = isInput && required ? "breaking" : "additive";
    out.push({ kind, element, field: h.name, what: `added (${required ? "required" : "optional"})` });
  }
}

/** Diff two public surfaces. `base === null` means the model did not exist at the base
 *  revision: every HEAD element is an additive addition. */
export function diffSurfaces(base: Surface | null, head: Surface): ApiCheckChange[] {
  const out: ApiCheckChange[] = [];
  const elementId = (e: SurfaceEntry) => `${e.kind}.${kebabSlug(e.name)}`;
  if (!base) {
    for (const h of head.entries) out.push({ kind: "additive", element: elementId(h), field: null, what: "added" });
    return out;
  }
  const baseByKey = new Map(base.entries.map((e) => [e.key, e]));
  const matchedBase = new Set<string>();
  for (const h of head.entries) {
    const element = elementId(h);
    const same = baseByKey.get(h.key);
    if (same) {
      matchedBase.add(same.key);
      diffFields(same, h, element, out);
      continue;
    }
    const renamedFrom = h.renamedFrom
      .map((old) => baseByKey.get(keyOf(h.kind, old)))
      .find((b): b is SurfaceEntry => b !== undefined && !matchedBase.has(b.key) && !head.entries.some((x) => x.key === b.key));
    if (renamedFrom) {
      matchedBase.add(renamedFrom.key);
      out.push({ kind: "breaking", element, field: null, what: `renamed from "${renamedFrom.name}"` });
      diffFields(renamedFrom, h, element, out);
      continue;
    }
    if (h.kind !== "type" && base.allElements.has(h.key)) {
      out.push({ kind: "additive", element, field: null, what: "marked public" });
    } else {
      out.push({ kind: "additive", element, field: null, what: "added" });
    }
  }
  for (const b of base.entries) {
    if (matchedBase.has(b.key)) continue;
    const element = elementId(b);
    if (b.kind !== "type" && head.allElements.has(b.key)) {
      out.push({ kind: "breaking", element, field: null, what: "`public` dropped" });
    } else {
      out.push({ kind: "breaking", element, field: null, what: "removed" });
    }
  }
  return out;
}

// ---- The check itself ------------------------------------------------------------------

export interface ApiCheckReport {
  file: string;
  contractPath: string;
  current: boolean;
  /** True when the contract file does not exist at all (a special case of not current). */
  missing: boolean;
  base: string | null;
  changes: ApiCheckChange[];
}

export type ApiCheckOutcome =
  | { ok: true; report: ApiCheckReport; diagnostics: Diagnostic[] }
  | { ok: false; message: string; diagnostics: Diagnostic[] };

/**
 * Run `em api check <file> [--base <rev>]`. (a) "current" = regenerate from the working-tree
 * model and compare to the committed contract file's text; (b) with `base`, compile the model
 * at that revision (`resolveRevision`) and diff the public surfaces structurally. A model
 * absent at `base` (new model) reports every public element as additive.
 */
export function runApiCheck(file: string, base: string | undefined, runGit: GitRunner = realGit): ApiCheckOutcome {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return { ok: false, message: `em api check: cannot read ${file}`, diagnostics: [] };
  }
  let head;
  try {
    head = compile(source);
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, message: `em api check: parse error in ${file} ${e.message}`, diagnostics: [] };
    throw e;
  }
  if (hasErrors(head.diagnostics)) {
    return { ok: false, message: "em api check: not checking — fix the errors above", diagnostics: head.diagnostics };
  }
  const generated = generateContract(file, source, head);
  const missing = !existsSync(generated.contractPath);
  const current = !missing && readFileSync(generated.contractPath, "utf8") === generated.text;

  let changes: ApiCheckChange[] = [];
  if (base !== undefined) {
    const top = runGit(["-C", dirname(resolve(file)), "rev-parse", "--show-toplevel"]);
    if (top.status !== 0) {
      return { ok: false, message: `em api check: ${file} is not inside a git repository (needed for --base)`, diagnostics: head.diagnostics };
    }
    const verify = runGit(["-C", dirname(resolve(file)), "rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
    if (verify.status !== 0) {
      return { ok: false, message: `em api check: unknown revision "${base}" (needed for --base)`, diagnostics: head.diagnostics };
    }
    const headDoc = buildExportDoc(head.model, head.refs, head.diagnostics, source, file).doc;
    const headSurface = surfaceOf(headDoc.model.slices, headDoc.model.types);
    const atBase = resolveRevision(file, base, runGit);
    let baseSurface: Surface | null = null;
    if (atBase.ok) {
      let baseCompiled;
      try {
        baseCompiled = compile(atBase.content);
      } catch (e) {
        if (e instanceof ParseError) {
          return { ok: false, message: `em api check: parse error in ${file}@${base} ${e.message}`, diagnostics: head.diagnostics };
        }
        throw e;
      }
      // Base-side validate errors (e.g. a pre-1.14 free-text public type) do not block the
      // structural diff — the diff reads shapes, not strictness.
      const baseDoc = buildExportDoc(baseCompiled.model, baseCompiled.refs, baseCompiled.diagnostics, atBase.content, file).doc;
      baseSurface = surfaceOf(baseDoc.model.slices, baseDoc.model.types);
    } else if (!/is not tracked by git/.test(atBase.message)) {
      return { ok: false, message: atBase.message.replace(/^em diff:/, "em api check:"), diagnostics: head.diagnostics };
    }
    changes = diffSurfaces(baseSurface, headSurface);
  }
  return {
    ok: true,
    report: { file, contractPath: generated.contractPath, current, missing, base: base ?? null, changes },
    diagnostics: generated.diagnostics,
  };
}

/** The text report: one status line, then one `additive:`/`breaking:` line per change. */
export function formatApiCheckText(r: ApiCheckReport): string[] {
  const lines: string[] = [];
  const regen = `run: em api generate ${r.file}`;
  if (r.current) lines.push(`contract ${r.contractPath} is current`);
  else if (r.missing) lines.push(`contract ${r.contractPath} is missing — ${regen}`);
  else lines.push(`contract ${r.contractPath} is stale — ${regen}`);
  if (r.base !== null) {
    if (r.changes.length === 0) lines.push(`no public-surface changes since ${r.base}`);
    for (const c of r.changes) {
      lines.push(`${c.kind}: ${c.element}${c.field !== null ? ` field "${c.field}"` : ""} ${c.what}`);
    }
  }
  return lines;
}
