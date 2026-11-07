// SPDX-License-Identifier: MIT
// GH #449: the per-slice bindings manifest — `conformance/bindings/<slice-key>.yaml`, beside the
// model. It is a FILE CONTRACT, not a CLI feature: any implementer that can commit a file can
// write one by hand (see docs/bindings.md for the full schema an em-less agent can author from).
// This module is `em`'s read side only — it never writes a bindings file.
//
// Two halves, both here:
//  - `parseBindingsFile`: shape-validate the YAML (`yaml`'s `parseDocument` + `LineCounter`, the
//    exact approach src/system/manifest.ts already uses for `system.yaml` — no new dependency).
//    Pure: text in, a `BindingsFile` or line-numbered errors out. Never touches the filesystem.
//  - `runBindingsCheck` and friends: `em conform bindings check` — deterministic, grep-level
//    verification that every bound file exists under `--repo` and contains its bound identifier
//    (plain substring, never code-parsed — language-agnostic by construction). Also resolves
//    each element's `ref` against the compiled model's own export refs (model/refs.ts), so a
//    bindings file that drifted from a renamed/removed element is caught as `unknown-ref`
//    rather than silently "passing" because nobody looked at the file content.
//
// Advisory only (GH #449's own words): nothing here is wired into `em validate` or
// `--slice-ready`, and `em conform bindings check`'s exit code stays 0 unless `--exit-code` is
// given — the same opt-in-gate posture as `em refs --reachable-from`.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { LineCounter, parseDocument, isMap, isSeq, isScalar, Node } from "yaml";
import type { RefsResult } from "../model/refs.js";

/** The bindings-file schema version `em` writes expectations against. There is no writer in
 *  `em` itself (the file contract is hand-authored, or written by any other tool) — this is
 *  purely what `parseBindingsFile` accepts. */
export const BINDINGS_SCHEMA_VERSION = "1.0";

/** Where every per-slice bindings file lives, relative to the model's own directory. */
export const BINDINGS_DIR = "conformance/bindings";

/** The conventional path for one slice's bindings file, relative to the model directory. */
export function bindingsFilePath(sliceKey: string): string {
  return `${BINDINGS_DIR}/${sliceKey}.yaml`;
}

/** A `<kind>.<slug>` element ref, lowercase dot-separated — the bare form valid WITHIN a bindings
 *  file (the slice itself is already named by the file, so no `<sliceKey>/` prefix like `em
 *  export`'s refs carry). */
const REF_RE = /^[a-z][a-z0-9]*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface BindingSite {
  /** Repo-relative path (resolved against `--repo`, never absolutized here). */
  file: string;
  /** Plain substring to search for in `file` — never parsed as code. */
  identifier: string;
}

export interface BindingElement extends BindingSite {
  /** `<kind>.<slug>`, e.g. `event.order-placed` — bare, no `<sliceKey>/` prefix. */
  ref: string;
  note: string | null;
}

export interface BindingInvariant {
  /** An `INV-*` token, same grammar as src/catalog/invTokens.ts's `INV_TOKEN_RE` (not
   *  cross-checked against a slice doc here — that's `em validate`'s/`em coverage`'s job; this
   *  module only shape-checks the token itself). */
  id: string;
  enforcedIn: BindingSite;
  testedIn: BindingSite;
}

export interface BindingsFile {
  bindingsSchemaVersion: string;
  /** The slice export key this file binds — must equal the file's own name stem. */
  slice: string;
  elements: BindingElement[];
  invariants: BindingInvariant[];
}

export type ParseBindingsResult = { ok: true; doc: BindingsFile } | { ok: false; errors: string[] };

const TOP_KEYS = new Set(["bindingsSchemaVersion", "slice", "elements", "invariants"]);
const ELEMENT_KEYS = new Set(["ref", "file", "identifier", "note"]);
const INVARIANT_KEYS = new Set(["id", "enforcedIn", "testedIn"]);
const SITE_KEYS = new Set(["file", "identifier"]);

/**
 * Shape-validate a bindings file's YAML text. `expectedSlice`, when given, is the slice key the
 * file's NAME says it binds (`conformance/bindings/<expectedSlice>.yaml`) — a `slice:` field
 * disagreeing with it is a shape error, since "per-slice, named by the file" is the convention
 * the whole scheme (parallel slice PRs never touching the same file) depends on. Never throws;
 * every problem is a `"line N: ..."`-prefixed string (no line for a document-level problem),
 * document-level issues first, then one entry at a time — same error style
 * src/system/manifest.ts's `parseManifest` uses for the sibling `system.yaml` contract.
 */
export function parseBindingsFile(text: string, expectedSlice?: string): ParseBindingsResult {
  const errors: string[] = [];
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const lineOf = (node: unknown): number | undefined => {
    const range = node && typeof node === "object" && "range" in (node as { range?: unknown }) ? (node as Node).range : undefined;
    return range ? lineCounter.linePos(range[0]).line : undefined;
  };
  const invalid = (message: string, line?: number) => errors.push(line !== undefined ? `line ${line}: ${message}` : message);

  if (doc.errors.length > 0) {
    for (const e of doc.errors) invalid(`YAML parse error: ${e.message.trim()}`, e.linePos?.[0]?.line);
    return { ok: false, errors };
  }
  const root = doc.contents;
  if (!isMap(root)) {
    invalid("bindings file must be a YAML mapping with `bindingsSchemaVersion`, `slice`, `elements`, `invariants`");
    return { ok: false, errors };
  }

  for (const pair of root.items) {
    const key = scalarString(pair.key);
    if (key === undefined || !TOP_KEYS.has(key)) {
      invalid(`unknown top-level key ${describeKey(pair.key)} — expected one of: ${[...TOP_KEYS].join(", ")}`, lineOf(pair));
    }
  }

  const versionNode = root.get("bindingsSchemaVersion", true) as Node | undefined;
  const version = scalarString(versionNode);
  if (version === undefined) {
    invalid(`missing or non-string \`bindingsSchemaVersion\` — set \`bindingsSchemaVersion: "${BINDINGS_SCHEMA_VERSION}"\``, lineOf(versionNode));
  } else if (version !== BINDINGS_SCHEMA_VERSION) {
    invalid(`unsupported bindingsSchemaVersion "${version}" — this em accepts "${BINDINGS_SCHEMA_VERSION}"`, lineOf(versionNode));
  }

  const sliceNode = root.get("slice", true) as Node | undefined;
  const slice = scalarString(sliceNode);
  if (slice === undefined || slice.trim() === "") {
    invalid("`slice` must be a non-empty string (the slice export key this file binds)", lineOf(sliceNode));
  } else if (expectedSlice !== undefined && slice.trim() !== expectedSlice) {
    invalid(
      `\`slice: ${slice}\` does not match this file's name — a bindings file is named ` +
        `\`${bindingsFilePath(expectedSlice)}\`, so \`slice:\` must be "${expectedSlice}"`,
      lineOf(sliceNode),
    );
  }

  const elements: BindingElement[] = [];
  const elementsNode = root.get("elements", true) as Node | undefined;
  if (elementsNode !== undefined && !isExplicitNull(elementsNode)) {
    if (!isSeq(elementsNode)) {
      invalid("`elements` must be a list of { ref, file, identifier, note? }", lineOf(elementsNode));
    } else {
      elementsNode.items.forEach((item, i) => {
        const line = lineOf(item) ?? lineOf(elementsNode);
        if (!isMap(item)) {
          invalid(`elements[${i}] must be a mapping with \`ref\`, \`file\`, \`identifier\``, line);
          return;
        }
        for (const p of item.items) {
          const k = scalarString(p.key);
          if (k === undefined || !ELEMENT_KEYS.has(k)) invalid(`elements[${i}]: unknown key ${describeKey(p.key)} — expected ref, file, identifier, note`, lineOf(p));
        }
        const ref = scalarString(item.get("ref", true) as Node | undefined);
        const file = scalarString(item.get("file", true) as Node | undefined);
        const identifier = scalarString(item.get("identifier", true) as Node | undefined);
        if (ref === undefined || ref.trim() === "") invalid(`elements[${i}]: \`ref\` must be a non-empty string ("<kind>.<slug>")`, line);
        else if (!REF_RE.test(ref.trim())) invalid(`elements[${i}]: \`ref\` "${ref}" doesn't look like "<kind>.<slug>" (lowercase, dot-separated, e.g. "event.order-placed")`, line);
        if (file === undefined || file.trim() === "") invalid(`elements[${i}]: \`file\` must be a non-empty repo-relative path`, line);
        if (identifier === undefined || identifier.trim() === "") invalid(`elements[${i}]: \`identifier\` must be a non-empty string`, line);
        const noteNode = item.get("note", true) as Node | undefined;
        let note: string | null = null;
        if (noteNode !== undefined && !isExplicitNull(noteNode)) {
          const n = scalarString(noteNode);
          if (n === undefined) invalid(`elements[${i}]: \`note\` must be a string`, lineOf(noteNode));
          else note = n;
        }
        if (ref !== undefined && ref.trim() !== "" && file !== undefined && file.trim() !== "" && identifier !== undefined && identifier.trim() !== "") {
          elements.push({ ref: ref.trim(), file: file.trim(), identifier, note });
        }
      });
    }
  }

  const invariants: BindingInvariant[] = [];
  const invariantsNode = root.get("invariants", true) as Node | undefined;
  if (invariantsNode !== undefined && !isExplicitNull(invariantsNode)) {
    if (!isSeq(invariantsNode)) {
      invalid("`invariants` must be a list of { id, enforcedIn: {file, identifier}, testedIn: {file, identifier} }", lineOf(invariantsNode));
    } else {
      invariantsNode.items.forEach((item, i) => {
        const line = lineOf(item) ?? lineOf(invariantsNode);
        if (!isMap(item)) {
          invalid(`invariants[${i}] must be a mapping with \`id\`, \`enforcedIn\`, \`testedIn\``, line);
          return;
        }
        for (const p of item.items) {
          const k = scalarString(p.key);
          if (k === undefined || !INVARIANT_KEYS.has(k)) invalid(`invariants[${i}]: unknown key ${describeKey(p.key)} — expected id, enforcedIn, testedIn`, lineOf(p));
        }
        const id = scalarString(item.get("id", true) as Node | undefined);
        if (id === undefined || id.trim() === "") invalid(`invariants[${i}]: \`id\` must be a non-empty string ("INV-...")`, line);
        else if (!/^INV-/.test(id.trim())) invalid(`invariants[${i}]: \`id\` "${id}" doesn't look like an INV-* token`, line);

        const parseSite = (key: "enforcedIn" | "testedIn"): BindingSite | undefined => {
          const siteNode = item.get(key, true) as Node | undefined;
          const siteLine = lineOf(siteNode) ?? line;
          if (!isMap(siteNode)) {
            invalid(`invariants[${i}].${key} must be a mapping with \`file\`, \`identifier\``, siteLine);
            return undefined;
          }
          for (const p of siteNode.items) {
            const k = scalarString(p.key);
            if (k === undefined || !SITE_KEYS.has(k)) invalid(`invariants[${i}].${key}: unknown key ${describeKey(p.key)} — expected file, identifier`, lineOf(p));
          }
          const file = scalarString(siteNode.get("file", true) as Node | undefined);
          const identifier = scalarString(siteNode.get("identifier", true) as Node | undefined);
          if (file === undefined || file.trim() === "") invalid(`invariants[${i}].${key}.file must be a non-empty repo-relative path`, siteLine);
          if (identifier === undefined || identifier.trim() === "") invalid(`invariants[${i}].${key}.identifier must be a non-empty string`, siteLine);
          if (file !== undefined && file.trim() !== "" && identifier !== undefined && identifier.trim() !== "") {
            return { file: file.trim(), identifier };
          }
          return undefined;
        };
        const enforcedIn = parseSite("enforcedIn");
        const testedIn = parseSite("testedIn");
        if (id !== undefined && id.trim() !== "" && enforcedIn && testedIn) {
          invariants.push({ id: id.trim(), enforcedIn, testedIn });
        }
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    doc: { bindingsSchemaVersion: version!, slice: slice!.trim(), elements, invariants },
  };
}

function isExplicitNull(node: unknown): boolean {
  return isScalar(node) && node.value === null;
}

/** A scalar node's value as a string — `undefined` for a missing node, a non-scalar, or a
 *  non-string scalar (same discipline src/system/manifest.ts's `scalarString` holds: a number/
 *  boolean/null is never silently coerced to a string). */
function scalarString(node: unknown): string | undefined {
  if (!isScalar(node)) return undefined;
  return typeof node.value === "string" ? node.value : undefined;
}

function describeKey(node: unknown): string {
  if (isScalar(node)) return `"${String(node.value)}"`;
  return "(non-scalar key)";
}

// ---- `em conform bindings check` ----------------------------------------------------------

export const BINDINGS_CHECK_SCHEMA_VERSION = "1.0";

export interface SiteCheck extends BindingSite {
  fileExists: boolean;
  identifierFound: boolean;
  ok: boolean;
}

export interface ElementCheck {
  ref: string;
  file: string;
  identifier: string;
  note: string | null;
  /** False when `ref` isn't among the compiled model's own element refs for this slice — the
   *  file/identifier are never even looked at in that case (`fileExists`/`identifierFound` stay
   *  `null`), since there is nothing in the model to anchor the check to. */
  knownRef: boolean;
  fileExists: boolean | null;
  identifierFound: boolean | null;
  ok: boolean;
}

export interface InvariantCheck {
  id: string;
  enforcedIn: SiteCheck;
  testedIn: SiteCheck;
  ok: boolean;
}

/** One bindings file's check outcome. `malformed`/`missing`/`unknown-slice` are distinct failure
 *  KINDS (GH #449): a shape problem in the YAML, no file at the conventional path, or a `slice:`
 *  naming a key the compiled model doesn't have (a renamed/removed slice left an orphaned
 *  bindings file behind). Only `checked` carries `elements`/`invariants`. */
export type BindingsFileResult =
  | { path: string; slice: string; kind: "missing"; ok: false; errors: string[]; elements: []; invariants: [] }
  | { path: string; slice: string; kind: "malformed"; ok: false; errors: string[]; elements: []; invariants: [] }
  | { path: string; slice: string; kind: "unknown-slice"; ok: false; errors: string[]; elements: []; invariants: [] }
  | { path: string; slice: string; kind: "checked"; ok: boolean; errors: []; elements: ElementCheck[]; invariants: InvariantCheck[] };

export interface BindingsCheckSummary {
  filesChecked: number;
  filesOk: number;
  filesFailed: number;
  elementsChecked: number;
  elementsOk: number;
  elementsFailed: number;
  invariantsChecked: number;
  invariantsOk: number;
  invariantsFailed: number;
}

export interface BindingsCheckRunResult {
  ok: boolean;
  /** The `--slice` key given, or `null` when every `conformance/bindings/*.yaml` was scanned. */
  slice: string | null;
  files: BindingsFileResult[];
  summary: BindingsCheckSummary;
}

/** Every `<slice-key>` with a `conformance/bindings/<slice-key>.yaml` beside the model, sorted —
 *  deterministic file order for both the text report and `--json`. `[]` when the directory
 *  doesn't exist (bindings are opt-in; no files yet is not an error). */
export function listBindingsSliceKeys(modelDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(join(modelDir, BINDINGS_DIR));
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".yaml"))
    .map((n) => n.slice(0, -".yaml".length))
    .sort();
}

/** The bare `<kind>.<slug>` refs (no `<sliceKey>/` prefix) the compiled model actually declares
 *  for `sliceKey` — what a bindings file's `elements[].ref` is checked against. */
function elementRefsForSlice(refs: RefsResult, sliceKey: string): Set<string> {
  const prefix = `${sliceKey}/`;
  const out = new Set<string>();
  for (const ref of refs.refById.values()) {
    if (ref.startsWith(prefix)) out.add(ref.slice(prefix.length));
  }
  return out;
}

/** Grep-level only: does `file` (resolved under `repoDir`) exist, and does it contain
 *  `identifier` as a plain substring. Never parses code, never cares about language. */
function checkSite(repoDir: string, site: BindingSite): SiteCheck {
  const absPath = join(repoDir, site.file);
  let fileExists = false;
  try {
    fileExists = statSync(absPath).isFile();
  } catch {
    fileExists = false;
  }
  let identifierFound = false;
  if (fileExists) {
    try {
      identifierFound = readFileSync(absPath, "utf8").includes(site.identifier);
    } catch {
      identifierFound = false;
    }
  }
  return { file: site.file, identifier: site.identifier, fileExists, identifierFound, ok: fileExists && identifierFound };
}

function checkElement(repoDir: string, el: BindingElement, validRefs: ReadonlySet<string>): ElementCheck {
  if (!validRefs.has(el.ref)) {
    return { ref: el.ref, file: el.file, identifier: el.identifier, note: el.note, knownRef: false, fileExists: null, identifierFound: null, ok: false };
  }
  const site = checkSite(repoDir, el);
  return {
    ref: el.ref,
    file: el.file,
    identifier: el.identifier,
    note: el.note,
    knownRef: true,
    fileExists: site.fileExists,
    identifierFound: site.identifierFound,
    ok: site.ok,
  };
}

function checkInvariant(repoDir: string, inv: BindingInvariant): InvariantCheck {
  const enforcedIn = checkSite(repoDir, inv.enforcedIn);
  const testedIn = checkSite(repoDir, inv.testedIn);
  return { id: inv.id, enforcedIn, testedIn, ok: enforcedIn.ok && testedIn.ok };
}

function checkOneBindingsFile(refs: RefsResult, modelDir: string, repoDir: string, sliceKey: string): BindingsFileResult {
  const path = bindingsFilePath(sliceKey);
  const absPath = join(modelDir, path);
  if (!existsSync(absPath)) {
    return { path, slice: sliceKey, kind: "missing", ok: false, errors: [`no bindings file at ${path}`], elements: [], invariants: [] };
  }
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch (e) {
    return { path, slice: sliceKey, kind: "malformed", ok: false, errors: [`could not read ${path}: ${(e as Error).message}`], elements: [], invariants: [] };
  }
  const parsed = parseBindingsFile(text, sliceKey);
  if (!parsed.ok) {
    return { path, slice: sliceKey, kind: "malformed", ok: false, errors: parsed.errors, elements: [], invariants: [] };
  }
  if (!refs.sliceKeys.includes(parsed.doc.slice)) {
    return { path, slice: parsed.doc.slice, kind: "unknown-slice", ok: false, errors: [`slice "${parsed.doc.slice}" is not in the model`], elements: [], invariants: [] };
  }
  const validRefs = elementRefsForSlice(refs, parsed.doc.slice);
  const elements = parsed.doc.elements.map((el) => checkElement(repoDir, el, validRefs));
  const invariants = parsed.doc.invariants.map((inv) => checkInvariant(repoDir, inv));
  const ok = elements.every((e) => e.ok) && invariants.every((i) => i.ok);
  return { path, slice: parsed.doc.slice, kind: "checked", ok, errors: [], elements, invariants };
}

function summarize(files: BindingsFileResult[]): BindingsCheckSummary {
  let filesOk = 0;
  let elementsChecked = 0;
  let elementsOk = 0;
  let invariantsChecked = 0;
  let invariantsOk = 0;
  for (const f of files) {
    if (f.ok) filesOk++;
    elementsChecked += f.elements.length;
    elementsOk += f.elements.filter((e) => e.ok).length;
    invariantsChecked += f.invariants.length;
    invariantsOk += f.invariants.filter((i) => i.ok).length;
  }
  return {
    filesChecked: files.length,
    filesOk,
    filesFailed: files.length - filesOk,
    elementsChecked,
    elementsOk,
    elementsFailed: elementsChecked - elementsOk,
    invariantsChecked,
    invariantsOk,
    invariantsFailed: invariantsChecked - invariantsOk,
  };
}

/**
 * `em conform bindings check <model.em> --repo <path> [--slice <key>]`'s core: with `sliceKey`,
 * checks exactly that one `conformance/bindings/<sliceKey>.yaml` (reporting `missing` rather than
 * an empty result when it doesn't exist — the caller asked for this one, by name); without it,
 * checks every bindings file present (an empty `files` list, `ok: true`, when none exist yet —
 * bindings are opt-in). `modelDir` is the model's own directory (`dirname(<model>.em)`, the same
 * convention every doc/note/conformance path in `em` uses); `repoDir` is `--repo`, resolved as
 * given (never required to be a git repository — this check never shells out to git).
 */
export function runBindingsCheck(refs: RefsResult, modelDir: string, repoDir: string, sliceKey?: string): BindingsCheckRunResult {
  const sliceKeys = sliceKey !== undefined ? [sliceKey] : listBindingsSliceKeys(modelDir);
  const files = sliceKeys.map((key) => checkOneBindingsFile(refs, modelDir, repoDir, key));
  return { ok: files.every((f) => f.ok), slice: sliceKey ?? null, files, summary: summarize(files) };
}

/** `em conform bindings check --json` document. Explicit nulls, deterministic key order, no
 *  schema field reused from any other surface. */
export function buildBindingsCheckJson(result: BindingsCheckRunResult): string {
  const doc = {
    bindingsCheckSchemaVersion: BINDINGS_CHECK_SCHEMA_VERSION,
    slice: result.slice,
    ok: result.ok,
    files: result.files.map((f) => ({
      path: f.path,
      slice: f.slice,
      kind: f.kind,
      ok: f.ok,
      errors: f.errors,
      elements: f.elements.map((e) => ({
        ref: e.ref,
        file: e.file,
        identifier: e.identifier,
        note: e.note,
        knownRef: e.knownRef,
        fileExists: e.fileExists,
        identifierFound: e.identifierFound,
        ok: e.ok,
      })),
      invariants: f.invariants.map((i) => ({
        id: i.id,
        enforcedIn: {
          file: i.enforcedIn.file,
          identifier: i.enforcedIn.identifier,
          fileExists: i.enforcedIn.fileExists,
          identifierFound: i.enforcedIn.identifierFound,
          ok: i.enforcedIn.ok,
        },
        testedIn: {
          file: i.testedIn.file,
          identifier: i.testedIn.identifier,
          fileExists: i.testedIn.fileExists,
          identifierFound: i.testedIn.identifierFound,
          ok: i.testedIn.ok,
        },
        ok: i.ok,
      })),
    })),
    summary: result.summary,
  };
  return JSON.stringify(doc, null, 2);
}

/** The reason a single element/invariant-site check failed, for the text report — `null` on a
 *  pass. Checked in the same order the checker itself short-circuits. Takes the two flags rather
 *  than a `SiteCheck` so it also reads an `ElementCheck` with `knownRef: true` (whose
 *  `fileExists`/`identifierFound` are booleans in practice, `boolean | null` only in the type —
 *  never called on a `knownRef: false` element, which has its own "unknown ref" message). */
function siteFailureReason(flags: { fileExists: boolean | null; identifierFound: boolean | null }): string | null {
  if (!flags.fileExists) return "file not found";
  if (!flags.identifierFound) return "identifier not found";
  return null;
}

/** The plain-text report `em conform bindings check` prints (no `--json`): per-binding pass/fail
 *  lines, then one summary line. Exported so tests can assert on it without spawning the CLI. */
export function renderBindingsCheckText(result: BindingsCheckRunResult): string {
  const lines: string[] = [];
  if (result.files.length === 0) {
    lines.push(result.slice !== null ? `no bindings files found for slice "${result.slice}"` : `no bindings files found (${BINDINGS_DIR}/*.yaml)`);
    return lines.join("\n");
  }
  for (const f of result.files) {
    lines.push(`${f.path} (slice "${f.slice}")`);
    if (f.kind === "missing") {
      lines.push(`  [FAIL] ${f.errors[0]}`);
      continue;
    }
    if (f.kind === "malformed") {
      lines.push("  [FAIL] malformed bindings file:");
      for (const e of f.errors) lines.push(`    - ${e}`);
      continue;
    }
    if (f.kind === "unknown-slice") {
      lines.push(`  [FAIL] ${f.errors[0]}`);
      continue;
    }
    if (f.elements.length === 0 && f.invariants.length === 0) {
      lines.push("  (no elements or invariants bound)");
    }
    for (const e of f.elements) {
      if (!e.knownRef) {
        lines.push(`  [FAIL] ${e.ref} -> ${e.file} ("${e.identifier}") — unknown element ref (not in the model)`);
        continue;
      }
      const reason = siteFailureReason(e);
      lines.push(`  [${e.ok ? "ok" : "FAIL"}] ${e.ref} -> ${e.file} ("${e.identifier}")${reason ? ` — ${reason}` : ""}`);
    }
    for (const i of f.invariants) {
      for (const [label, site] of [
        ["enforced", i.enforcedIn],
        ["tested", i.testedIn],
      ] as const) {
        const reason = siteFailureReason(site);
        lines.push(`  [${site.ok ? "ok" : "FAIL"}] ${i.id} ${label}: ${site.file} ("${site.identifier}")${reason ? ` — ${reason}` : ""}`);
      }
    }
  }
  const s = result.summary;
  lines.push("");
  lines.push(
    `summary: ${s.filesChecked} file(s) checked, ${s.filesFailed} failed; ` +
      `${s.elementsChecked} element binding(s), ${s.elementsFailed} failed; ` +
      `${s.invariantsChecked} invariant binding(s), ${s.invariantsFailed} failed`,
  );
  return lines.join("\n");
}
