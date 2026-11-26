// SPDX-License-Identifier: MIT
// GH #527: the code map — `code-map.yaml`, beside the model. It says where a model's code lives:
// a default place, a place per persona and per context, and per-element overrides. A place is a
// repo id plus a root path inside that repo. See docs/code-map-schema.md for the contract.
//
// It is a separate file, not `.em` syntax, on purpose: moving a service to another repository
// must not change the model's text, so it cannot move a ratified hash. The file names repo ids
// only. The ids are declared in `system.yaml` (`repos:`), and where each is checked out on one
// machine is recorded nowhere in git.
//
// This module is the pure half: text in, a `CodeMap` or line-numbered problems out. It never
// reads the filesystem and knows nothing about the model; codeMapValidate.ts checks a parsed map
// against the model and the declared repos, and places.ts derives each element's place from it.

import { LineCounter, parseDocument, isMap, isScalar, Node, Pair } from "yaml";
import { isRepoId, SELF_REPO_ID } from "../system/manifest.js";

/** The code map's file name, in the model's own directory. */
export const CODE_MAP_FILE = "code-map.yaml";
/** The code-map schema version this em reads (`codeMapSchemaVersion`). em never writes the file. */
export const CODE_MAP_SCHEMA_VERSION = "1.0";

/** Where code lives: a repo id (`self` = the model's own repository) and a root path inside it,
 *  posix, relative to the repository root, `""` for the root itself. */
export interface Place {
  repo: string;
  root: string;
}

export interface PlaceRule {
  /** The persona name, context name or element export ref this rule is keyed by, as written. */
  key: string;
  place: Place;
  /** 1-based line of the entry in the code map. */
  line: number;
}

export interface CodeMap {
  codeMapSchemaVersion: string;
  /** `model:` — the model file this map describes (a base name), or `null` when not given. */
  model: string | null;
  /** `default:` — the place of every element no other rule places. */
  default: { place: Place; line: number } | null;
  personas: PlaceRule[];
  contexts: PlaceRule[];
  elements: PlaceRule[];
}

export interface CodeMapProblem {
  message: string;
  line?: number;
}

export type ParseCodeMapResult = { ok: true; map: CodeMap } | { ok: false; problems: CodeMapProblem[] };

const TOP_KEYS = new Set(["codeMapSchemaVersion", "model", "default", "personas", "contexts", "elements"]);
const PLACE_KEYS = new Set(["repo", "root"]);

/** `a/b/`, `./a/b`, `a//b` -> `a/b`; `.`, `./`, `` -> `` (the repository root). `null` for a path
 *  that could leave the repository: absolute, a drive or backslash path, or one with a `..` segment. */
export function normalizeRoot(root: string): string | null {
  const trimmed = root.trim();
  if (trimmed.startsWith("/") || trimmed.includes("\\") || /^[A-Za-z]:/.test(trimmed)) return null;
  const segments = trimmed.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) return null;
  return segments.join("/");
}

/** Two places are the same place when repo and root both match. */
export function samePlace(a: Place, b: Place): boolean {
  return a.repo === b.repo && a.root === b.root;
}

/** `repo` or `repo:root` — the one-line form used in messages and text output. */
export function formatPlace(p: Place): string {
  return p.root === "" ? p.repo : `${p.repo}:${p.root}`;
}

/** Shape-validate a code map's YAML text. Never throws. Unknown keys are problems, not ignored:
 *  a misspelled `persona:` silently routing nothing would defeat the file. */
export function parseCodeMap(text: string): ParseCodeMapResult {
  const problems: CodeMapProblem[] = [];
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const lineOf = (node: Node | Pair | null | undefined): number | undefined => {
    if (!node) return undefined;
    const range = "range" in node ? (node as Node).range : ((node as Pair).key as Node | null)?.range;
    return range ? lineCounter.linePos(range[0]).line : undefined;
  };
  const bad = (message: string, line?: number): void => {
    problems.push(line === undefined ? { message } : { message, line });
  };

  if (doc.errors.length > 0) {
    for (const e of doc.errors) bad(`YAML parse error: ${e.message.trim()}`, e.linePos?.[0]?.line);
    return { ok: false, problems };
  }
  const root = doc.contents;
  if (!isMap(root)) {
    bad("code map must be a YAML mapping with `codeMapSchemaVersion` and at least one of `default`, `personas`, `contexts`, `elements`");
    return { ok: false, problems };
  }
  for (const pair of root.items) {
    const key = str(pair.key);
    if (key === undefined || !TOP_KEYS.has(key)) {
      bad(`unknown top-level key ${describe(pair.key)} — expected one of: ${[...TOP_KEYS].join(", ")}`, lineOf(pair));
    }
  }

  const versionNode = root.get("codeMapSchemaVersion", true) as Node | undefined;
  const version = str(versionNode);
  if (version === undefined) {
    bad(`missing or non-string \`codeMapSchemaVersion\` — set \`codeMapSchemaVersion: "${CODE_MAP_SCHEMA_VERSION}"\``, lineOf(versionNode));
  } else if (version !== CODE_MAP_SCHEMA_VERSION) {
    bad(`unsupported codeMapSchemaVersion "${version}" — this em reads "${CODE_MAP_SCHEMA_VERSION}"`, lineOf(versionNode));
  }

  let model: string | null = null;
  const modelNode = root.get("model", true) as Node | undefined;
  if (modelNode !== undefined) {
    const m = str(modelNode);
    if (m === undefined || m.trim() === "" || /[\\/]/.test(m)) {
      bad("`model` must be the model file's name, with no directory (the code map sits beside it)", lineOf(modelNode));
    } else model = m.trim();
  }

  const placeOf = (node: Node | null | undefined, what: string, line: number | undefined): Place | null => {
    if (!isMap(node)) {
      bad(`${what} must be a mapping with \`repo\` and/or \`root\``, line);
      return null;
    }
    let ok = true;
    for (const p of node.items) {
      const k = str(p.key);
      if (k === undefined || !PLACE_KEYS.has(k)) {
        bad(`${what}: unknown key ${describe(p.key)} — expected repo, root`, lineOf(p));
        ok = false;
      }
    }
    const repoNode = node.get("repo", true) as Node | undefined;
    const rootNode = node.get("root", true) as Node | undefined;
    if (repoNode === undefined && rootNode === undefined) {
      bad(`${what} must name a \`repo\`, a \`root\`, or both`, line);
      return null;
    }
    let repo = SELF_REPO_ID;
    if (repoNode !== undefined) {
      const r = str(repoNode);
      if (r === undefined || !isRepoId(r)) {
        bad(`${what}: \`repo\` must be a repo id (letters, digits, \`.\`, \`_\`, \`-\`), or \`${SELF_REPO_ID}\` for the model's own repository`, lineOf(repoNode));
        ok = false;
      } else repo = r;
    }
    let rootPath = "";
    if (rootNode !== undefined) {
      const r = str(rootNode);
      const normalized = r === undefined ? null : normalizeRoot(r);
      if (normalized === null) {
        bad(`${what}: \`root\` must be a path relative to the repository root, with no \`..\` segment`, lineOf(rootNode));
        ok = false;
      } else rootPath = normalized;
    }
    return ok ? { repo, root: rootPath } : null;
  };

  let defaultPlace: CodeMap["default"] = null;
  const defaultNode = root.get("default", true) as Node | undefined;
  if (defaultNode !== undefined && !isNull(defaultNode)) {
    const line = lineOf(defaultNode);
    const place = placeOf(defaultNode, "`default`", line);
    if (place) defaultPlace = { place, line: line ?? 1 };
  }

  const rulesOf = (section: "personas" | "contexts" | "elements", noun: string): PlaceRule[] => {
    const out: PlaceRule[] = [];
    const node = root.get(section, true) as Node | undefined;
    if (node === undefined || isNull(node)) return out;
    if (!isMap(node)) {
      bad(`\`${section}\` must be a mapping of ${noun} -> { repo, root }`, lineOf(node));
      return out;
    }
    for (const pair of node.items) {
      const key = str(pair.key);
      const line = lineOf(pair) ?? lineOf(node);
      if (key === undefined || key.trim() === "") {
        bad(`\`${section}\`: key ${describe(pair.key)} must be a non-empty string (${noun})`, line);
        continue;
      }
      const place = placeOf(pair.value as Node | null, `\`${section}\` entry "${key}"`, line);
      if (place) out.push({ key: key.trim(), place, line: line ?? 1 });
    }
    return out;
  };
  const personas = rulesOf("personas", "persona name");
  const contexts = rulesOf("contexts", "context name");
  const elements = rulesOf("elements", "element ref");

  if (problems.length === 0 && defaultPlace === null && personas.length + contexts.length + elements.length === 0) {
    bad("code map places nothing — give it a `default`, or at least one entry under `personas`, `contexts` or `elements`");
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, map: { codeMapSchemaVersion: version!, model, default: defaultPlace, personas, contexts, elements } };
}

function isNull(node: unknown): boolean {
  return isScalar(node) && node.value === null;
}

/** A scalar node's string value; `undefined` for anything else (a number is never coerced). */
function str(node: unknown): string | undefined {
  if (!isScalar(node)) return undefined;
  return typeof node.value === "string" ? node.value : undefined;
}

function describe(node: unknown): string {
  if (isScalar(node)) return `"${String(node.value)}"`;
  return "(non-scalar key)";
}
