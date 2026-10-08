// SPDX-License-Identifier: MIT
// `em system codeowners` (MIL-234): turn the models' `owner` handles and the translations'
// `consumes` refs into a managed CODEOWNERS block, so review of a model's public surface is
// routed by the platform, not by convention. Three kinds of entry, per model in system order:
//   - the model's design directory (`<modelDir>/`) -> the model's own team(s);
//   - its contract file (`<modelDir>/contracts/<modelKey>.tsp`) -> the producer's team(s) FIRST,
//     then every team whose model has a translation that `consumes` one of its refs (sorted).
//     The contract carries no source hash (R12), so internal edits never touch it: only a real
//     change of the public surface summons the consuming teams;
//   - the model's slice docs (`<modelDir>/slices/**`) -> the model's team(s), unless the repo's
//     own CODEOWNERS already routes them (the ratification convention, docs/ci.md) — in which
//     case that rule is restated after the directory entry, because CODEOWNERS is last-match-
//     wins and the directory entry would otherwise silently take the ratifiers' review away.
// The planning half is pure over export documents (compile isolation, MIL-194): paths are handed
// in CODEOWNERS-root-relative and nothing there touches the filesystem. `runCodeowners` at the
// bottom is the thin fs half the CLI and the MCP tool share, so both load the system, find the
// file and splice the block identically.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { GitRunner, realGit } from "../cli/diff-inputs.js";
import { loadSystem } from "../cli/systemInputs.js";
import { parseContractRef } from "../model/qualifiedRef.js";
import { isOwnerHandle } from "../model/validate.js";
import { applyMarker, markerPair } from "../util/markers.js";
import type { SystemExportDoc } from "./verify.js";

/** The managed block's marker name (`# GENERATED:em-codeowners:start` ... `:end`). */
export const CODEOWNERS_MARKER = "em-codeowners";

/** The doc comment written into the block: why the contract file lists every consumer. */
export const CODEOWNERS_CONTRACT_NOTE =
  "Contract files list every consuming team: a change to a model's public surface cannot merge without the teams that depend on it.";

export type CodeownersReason = "model-dir" | "contract" | "slices" | "slices-existing";

export interface CodeownersEntry {
  /** CODEOWNERS pattern, anchored with a leading `/`, forward slashes. */
  path: string;
  owners: string[];
  reason: CodeownersReason;
}

/** One model as the generator needs it. `dir` is the model's directory relative to the
 *  CODEOWNERS root ("" when the model sits at the root), `/`-separated. */
export interface CodeownersModelInput {
  key: string;
  dir: string;
  /** The header's `owner` entries, as written. */
  owner: string[];
  doc: SystemExportDoc;
}

export interface CodeownersPlan {
  entries: CodeownersEntry[];
  /** Human notes (a skipped non-handle owner); stderr in the CLI, never in the JSON. */
  notes: string[];
  /** Refusals: a model with no usable owner. Non-empty means no entries should be written. */
  errors: string[];
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];
const usable = (owners: string[]): string[] => dedupe(owners.filter(isOwnerHandle));

/** `/<dir>/<rest>` with the root case handled and spaces escaped the CODEOWNERS way. */
function patternFor(dir: string, rest: string): string {
  const joined = dir === "" ? rest : `${dir}/${rest}`;
  return `/${joined}`.replace(/ /g, "\\ ");
}

/** The parsed lines of an existing CODEOWNERS, outside the managed block, as `{pattern, owners}`. */
export function existingRules(text: string): Array<{ pattern: string; owners: string[] }> {
  const out: Array<{ pattern: string; owners: string[] }> = [];
  const outside = stripManagedBlock(text);
  for (const raw of outside.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    out.push({ pattern: parts[0], owners: parts.slice(1) });
  }
  return out;
}

function stripManagedBlock(text: string): string {
  const { start, end } = markerPair(CODEOWNERS_MARKER, "hash");
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (s < 0 || e < s) return text;
  return text.slice(0, s) + text.slice(e + end.length);
}

/** gitignore-style pattern match as CODEOWNERS applies it, for a file path relative to the
 *  root. A pattern with a slash (other than a trailing one) is anchored at the root; one
 *  without matches at any depth. `*` stops at `/`, `**` crosses it; a trailing `/` (or a
 *  pattern naming a directory) covers everything beneath. */
export function codeownersPatternMatches(pattern: string, path: string): boolean {
  let p = pattern.replace(/\\ /g, " ");
  const anchored = p.startsWith("/") || p.slice(0, -1).includes("/");
  p = p.replace(/^\//, "");
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        i++;
        if (p[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const prefix = anchored ? "^" : "^(?:.*/)?";
  return new RegExp(`${prefix}${re}(?:/.*)?$`).test(path);
}

/** The last existing rule that routes `path`, ignoring a bare catch-all `*` (it is a default,
 *  not a decision about slice docs). */
function routedBy(rules: Array<{ pattern: string; owners: string[] }>, path: string): { pattern: string; owners: string[] } | null {
  let hit: { pattern: string; owners: string[] } | null = null;
  for (const r of rules) {
    if (r.pattern === "*" || r.pattern === "/*") continue;
    if (codeownersPatternMatches(r.pattern, path)) hit = r;
  }
  return hit;
}

/** Build the entries. Deterministic: system order, then dir / contract / slices per model. */
export function planCodeowners(models: CodeownersModelInput[], existingText: string = ""): CodeownersPlan {
  const notes: string[] = [];
  const errors: string[] = [];
  const rules = existingRules(existingText);
  const ownersOf = new Map<string, string[]>();
  for (const m of models) {
    const good = usable(m.owner);
    for (const o of m.owner) {
      if (!isOwnerHandle(o)) notes.push(`model "${m.key}": skipping owner "${o}" — not a CODEOWNERS handle (use "@user", "@org/team" or an email)`);
    }
    if (good.length === 0) {
      errors.push(
        m.owner.length === 0
          ? `model "${m.key}" has no \`owner\` — add \`owner "@org/team"\` to its \`model\` header line`
          : `model "${m.key}" has no usable owner — every \`owner\` entry is free text; use "@user", "@org/team" or an email`,
      );
    }
    ownersOf.set(m.key, good);
  }

  // consumer teams per producing model: the owners of every model with a translation that
  // consumes one of the producer's refs. Refs to models outside the system and self-refs
  // route nothing (`em system` reports those).
  const consumers = new Map<string, string[]>();
  for (const m of models) {
    for (const slice of m.doc.model.slices) {
      for (const el of slice.elements) {
        if (el.kind !== "translation") continue;
        for (const ref of el.consumes ?? []) {
          const parsed = parseContractRef(ref);
          if (!parsed || parsed.modelKey === m.key) continue;
          consumers.set(parsed.modelKey, [...(consumers.get(parsed.modelKey) ?? []), ...(ownersOf.get(m.key) ?? [])]);
        }
      }
    }
  }

  const entries: CodeownersEntry[] = [];
  for (const m of models) {
    const own = ownersOf.get(m.key) ?? [];
    if (own.length === 0) continue;
    entries.push({ path: patternFor(m.dir, ""), owners: own, reason: "model-dir" });
    const consuming = dedupe(consumers.get(m.key) ?? []).filter((o) => !own.includes(o)).sort();
    entries.push({ path: patternFor(m.dir, `contracts/${m.key}.tsp`), owners: [...own, ...consuming], reason: "contract" });
    const sample = m.dir === "" ? "slices/x.md" : `${m.dir}/slices/x.md`;
    const existing = routedBy(rules, sample);
    if (existing === null) entries.push({ path: patternFor(m.dir, "slices/**"), owners: own, reason: "slices" });
    else entries.push({ path: patternFor(m.dir, "slices/**"), owners: existing.owners, reason: "slices-existing" });
  }
  return { entries, notes, errors };
}

/** The block body (between the marker lines): the explanatory comments, then one line per entry. */
export function codeownersBlockBody(entries: CodeownersEntry[]): string {
  const lines = [
    "# Generated by `em system codeowners` from each model's `owner` and each translation's `consumes`.",
    "# Re-run it after changing either; `em system codeowners --check` fails on drift.",
    `# ${CODEOWNERS_CONTRACT_NOTE}`,
    ...entries.map((e) => `${e.path} ${e.owners.join(" ")}`),
  ];
  return lines.join("\n");
}

export type CodeownersStatus = "ok" | "missing" | "stale" | "no-markers" | "created" | "updated";

export interface CodeownersResult {
  /** The full file text the managed block implies (existing content untouched). */
  text: string;
  /** What `--check` would report; `created`/`updated` are the write-mode equivalents of
   *  `missing`/`stale`+`no-markers`. */
  state: "ok" | "missing" | "stale" | "no-markers";
}

/** Splice the block into `existing` (`null` = no file). Unmarked content is kept byte-for-byte;
 *  a file with no markers gets the block appended after a blank line. */
export function spliceCodeowners(existing: string | null, entries: CodeownersEntry[]): CodeownersResult {
  const { start, end } = markerPair(CODEOWNERS_MARKER, "hash");
  const body = codeownersBlockBody(entries);
  if (existing === null) return { text: `${start}\n${body}\n${end}\n`, state: "missing" };
  const spliced = applyMarker(existing, CODEOWNERS_MARKER, body, "hash");
  if (spliced !== null) return { text: spliced, state: spliced === existing ? "ok" : "stale" };
  const sep = existing === "" ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return { text: `${existing}${sep}${start}\n${body}\n${end}\n`, state: "no-markers" };
}

/** The files em looks for, in order, when no `-o` is given (GitHub's three locations). */
export const CODEOWNERS_CANDIDATES = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];

export type RunCodeownersResult =
  | { ok: false; message: string }
  | {
      ok: true;
      /** The CODEOWNERS path (as given with `-o`, else root-joined; never absolutized). */
      file: string;
      plan: CodeownersPlan;
      status: CodeownersStatus;
      /** The file text after the splice (what `write` puts on disk). */
      text: string;
      /** True when the file on disk differs from `text` (a write is needed). */
      changed: boolean;
    };

/** The directory CODEOWNERS paths are relative to: the parent of a `.github/` or `docs/`
 *  CODEOWNERS, else the file's own directory. */
function rootOfCodeownersFile(file: string): string {
  const dir = dirname(file);
  const name = basename(dir);
  return name === ".github" || name === "docs" ? dirname(dir) : dir;
}

/** Load the system, plan the entries and compute the spliced file. With `write`, also puts it
 *  on disk (creating the file and its directory). `--check` callers pass `write: false` and
 *  report `status`; the MCP tool is always read-only. */
export function runCodeowners(
  target: string,
  opts: { output?: string; write: boolean },
  runGit: GitRunner = realGit,
): RunCodeownersResult {
  const loaded = loadSystem(target, runGit);
  if (!loaded.ok) {
    return {
      ok: false,
      message: `${target} could not be loaded — ${loaded.diagnostics.map((d) => `${d.file}${d.line ? `:${d.line}` : ""}: ${d.message}`).join("; ")}`,
    };
  }

  let file: string;
  let root: string;
  if (opts.output !== undefined) {
    file = opts.output;
    root = rootOfCodeownersFile(file);
  } else {
    const start = loaded.manifestPath !== null ? dirname(loaded.manifestPath) : loaded.discovery!.root;
    const up = runGit(["-C", start, "rev-parse", "--show-cdup"]);
    root = up.status === 0 ? join(start, up.stdout.trim()) : start;
    file = join(root, CODEOWNERS_CANDIDATES.find((c) => existsSync(join(root, c))) ?? "CODEOWNERS");
  }

  const notes: string[] = [];
  const inputs: CodeownersModelInput[] = [];
  for (const m of loaded.models) {
    if (m.sourceKind !== "em") {
      notes.push(`model "${m.key}": sourced from an export document, not a .em file — it has no design directory to route; skipped`);
      continue;
    }
    const rel = relative(resolve(root), resolve(dirname(m.file)));
    if (rel === ".." || rel.startsWith(`..${sep}`)) {
      return { ok: false, message: `model "${m.key}" (${m.file}) lives outside the CODEOWNERS root ${root} — pass -o with a CODEOWNERS file at or above its directory` };
    }
    inputs.push({ key: m.key, dir: rel.split(sep).join("/"), owner: m.owner, doc: m.doc });
  }

  const existing = existsSync(file) ? readFileSync(file, "utf8") : null;
  const plan = planCodeowners(inputs, existing ?? "");
  plan.notes.unshift(...notes);
  if (plan.errors.length > 0) return { ok: false, message: plan.errors.join("\n") };
  const spliced = spliceCodeowners(existing, plan.entries);
  const changed = spliced.state !== "ok";
  if (opts.write && changed) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, spliced.text);
  }
  const status: CodeownersStatus = opts.write && changed ? (spliced.state === "missing" ? "created" : "updated") : spliced.state;
  return { ok: true, file, plan, status, text: spliced.text, changed };
}
