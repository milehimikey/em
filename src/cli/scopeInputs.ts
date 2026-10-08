// SPDX-License-Identifier: MIT
// The git/fs half of `em system scope` (MIL-240): gather the change set (committed since the
// base, and/or staged), apply the `Em-Upgrade:` exemption, build each model's base-vs-HEAD
// public-surface changes and `consumes` bindings, and hand the lot to the pure
// `evaluateScope` (src/system/scope.ts). `buildScopeModels` is shared with `em metrics`' per-
// commit `seamCrossings`, which feeds it the models as committed instead of as checked out.
//
// Compile isolation (MIL-194) holds: each model is compiled on its own, to its own export
// document; only export-shaped facts reach `src/system/*`.

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { compile } from "../pipeline.js";
import { ParseError } from "../parser/parser.js";
import { buildExportDoc, ExportDoc } from "../emit/json.js";
import { ScopeJsonFacts } from "../emit/scopeJson.js";
import { evaluateScope, parseCodeRoots, ScopeModel, ScopeReport } from "../system/scope.js";
import type { SystemDiagnostic } from "../system/verify.js";
import { surfaceOf, diffSurfaces, ApiCheckChange } from "./api.js";
import { changedEntriesSince, changedEntriesStaged, ChangedEntry, entryPaths } from "./conformScope.js";
import { GitRunner, realGit } from "./diff-inputs.js";
import { loadSystem, readExportDoc } from "./systemInputs.js";
import { STATE_FILE_NAME } from "./stateFile.js";
import { EM_UPGRADE_TRAILER } from "./upgrade.js";

const LABEL = "em system scope";
const posix = (p: string) => p.split("\\").join("/");

/** One model as the scope check sees it at HEAD (or at the commit being measured). */
export interface HeadModel {
  key: string;
  /** Repo-root-relative model file. */
  rel: string;
  doc: ExportDoc;
}

export interface ChangeSetFacts {
  /** Every raw changed path (both sides of a rename), before the exemption. */
  raw: Set<string>;
  /** Raw minus the `Em-Upgrade:`-only files. */
  changed: Set<string>;
  /** new path -> old path for renames. */
  renames: Map<string, string>;
}

function collectConsumes(doc: ExportDoc): string[] {
  const out: string[] = [];
  for (const s of doc.model.slices) for (const e of s.elements) for (const c of (e as { consumes?: string[] | null }).consumes ?? []) out.push(c);
  return out;
}

/** A model file's text as an export document: `.em` is compiled (validation errors tolerated -
 *  this reads shapes, not strictness), anything else is read as an `em export --json` document.
 *  `null` when it cannot be read at all. */
export function docFromText(text: string, rel: string): ExportDoc | null {
  if (rel.toLowerCase().endsWith(".em")) {
    try {
      const c = compile(text);
      return buildExportDoc(c.model, c.refs, c.diagnostics, text, rel).doc;
    } catch (e) {
      if (e instanceof ParseError) return null;
      throw e;
    }
  }
  const r = readExportDoc(text, rel);
  return "error" in r ? null : (r.doc as unknown as ExportDoc);
}

/**
 * Build the pure evaluator's per-model input. `readBase(relPath)` returns the file text at the
 * base revision (`null` when absent there); `readState(dirRel)` returns a model dir's
 * `.event-modeling.md` text (`null` when none).
 */
export function buildScopeModels(
  heads: HeadModel[],
  change: ChangeSetFacts,
  readBase: (rel: string) => string | null,
  readState: (dirRel: string) => string | null,
): ScopeModel[] {
  return heads.map((h) => {
    const dirRaw = posix(dirname(h.rel));
    const dir = dirRaw === "." ? "" : dirRaw;
    const headConsumes = collectConsumes(h.doc);
    const touchedRaw = change.raw.has(h.rel);
    let baseConsumes = headConsumes;
    let surfaceChanges: ApiCheckChange[] | null = null;
    if (touchedRaw) {
      const baseRel = change.renames.get(h.rel) ?? h.rel;
      const text = readBase(baseRel);
      const baseDoc = text === null ? null : docFromText(text, baseRel);
      baseConsumes = baseDoc === null ? [] : collectConsumes(baseDoc);
      if (change.changed.has(h.rel) || change.changed.has(baseRel)) {
        const headSurface = surfaceOf(h.doc.model.slices, h.doc.model.types);
        const baseSurface = baseDoc === null ? null : surfaceOf(baseDoc.model.slices, baseDoc.model.types);
        surfaceChanges = diffSurfaces(baseSurface, headSurface);
      }
    }
    const stateText = readState(dir);
    return {
      key: h.key,
      file: h.rel,
      dir,
      contract: dir === "" ? `contracts/${h.key}.tsp` : `${dir}/contracts/${h.key}.tsp`,
      codeRoots: stateText === null ? [] : parseCodeRoots(stateText),
      surfaceChanges,
      headConsumes,
      baseConsumes,
    };
  });
}

/** Paths in `paths` whose every commit in `<since>..HEAD` carries an `Em-Upgrade:` trailer (R2).
 *  A path with no commit in the range (nothing to vouch for it) is never exempt. */
export function emUpgradeOnlyPaths(repoRoot: string, since: string, paths: string[], runGit: GitRunner = realGit): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    const log = runGit([
      "-C",
      repoRoot,
      "log",
      `--format=%x02%H%x00%(trailers:key=${EM_UPGRADE_TRAILER},valueonly)`,
      `${since}..HEAD`,
      "--",
      p,
    ]);
    if (log.status !== 0) continue;
    const records = log.stdout.split("\x02").filter((r) => r.trim() !== "");
    if (records.length > 0 && records.every((r) => (r.split("\0")[1] ?? "").trim() !== "")) out.add(p);
  }
  return out;
}

export interface ScopeOptions {
  base?: string;
  staged?: boolean;
}

export type ScopeRun =
  | { ok: true; facts: ScopeJsonFacts; report: ScopeReport }
  | { ok: false; message: string; diagnostics: SystemDiagnostic[] };

/** `em system scope [<target>] [--base <rev>] [--staged]`: shared by the CLI and the MCP tool. */
export function runSystemScope(target: string, opts: ScopeOptions, runGit: GitRunner = realGit): ScopeRun {
  const staged = opts.staged === true;
  if (opts.base === undefined && !staged) {
    return { ok: false, message: `${LABEL}: pass --base <rev> (the change set since that revision), --staged (what is staged now), or both`, diagnostics: [] };
  }
  const loaded = loadSystem(target, runGit);
  if (!loaded.ok) {
    return { ok: false, message: `${LABEL}: not checking - ${target} could not be loaded; fix the above first`, diagnostics: loaded.diagnostics };
  }
  const anchor = dirname(resolve(loaded.models[0].file));
  const top = runGit(["-C", anchor, "rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return { ok: false, message: `${LABEL}: ${target} is not inside a git repository`, diagnostics: [] };
  const repoRoot = top.stdout.trim();

  const baseRev = opts.base ?? "HEAD";
  const verify = runGit(["-C", repoRoot, "rev-parse", "--verify", "--quiet", `${baseRev}^{commit}`]);
  if (verify.status !== 0) return { ok: false, message: `${LABEL}: unknown revision "${baseRev}"`, diagnostics: [] };
  const mb = runGit(["-C", repoRoot, "merge-base", baseRev, "HEAD"]);
  const mergeBase = mb.status === 0 && mb.stdout.trim() !== "" ? mb.stdout.trim() : baseRev;

  let committed: ChangedEntry[] = [];
  if (opts.base !== undefined) {
    const r = changedEntriesSince(repoRoot, opts.base, runGit, LABEL);
    if (!r.ok) return { ok: false, message: r.message, diagnostics: [] };
    committed = r.entries;
  }
  let stagedEntries: ChangedEntry[] = [];
  if (staged) {
    const r = changedEntriesStaged(repoRoot, runGit, LABEL);
    if (!r.ok) return { ok: false, message: r.message, diagnostics: [] };
    stagedEntries = r.entries;
  }

  const raw = new Set([...entryPaths(committed), ...entryPaths(stagedEntries)]);
  const stagedPaths = new Set(entryPaths(stagedEntries));
  const renames = new Map<string, string>();
  for (const e of [...stagedEntries, ...committed]) if (e.oldPath !== null) renames.set(e.path, e.oldPath);
  // Staged changes have no commit yet, so they are never exempt.
  const candidates = [...raw].filter((p) => !stagedPaths.has(p));
  const exempt = opts.base === undefined ? new Set<string>() : emUpgradeOnlyPaths(repoRoot, mergeBase, candidates, runGit);
  const changed = new Set([...raw].filter((p) => !exempt.has(p)));

  const topReal = realpathSync(repoRoot);
  const heads: HeadModel[] = [];
  for (const m of loaded.models) {
    const rel = posix(relative(topReal, realpathSync(resolve(m.file))));
    if (rel.startsWith("..")) continue;
    heads.push({ key: m.key, rel, doc: m.doc as unknown as ExportDoc });
  }
  const models = buildScopeModels(
    heads,
    { raw, changed, renames },
    (rel) => {
      const show = runGit(["-C", repoRoot, "show", `${mergeBase}:${rel}`]);
      return show.status === 0 ? show.stdout : null;
    },
    (dirRel) => {
      const f = resolve(repoRoot, dirRel, STATE_FILE_NAME);
      return existsSync(f) ? readFileSync(f, "utf8") : null;
    },
  );
  const report = evaluateScope({ models, changed: [...changed] });
  return {
    ok: true,
    facts: { base: opts.base ?? null, staged, changedPaths: [...changed].sort(), exemptPaths: [...exempt].sort() },
    report,
  };
}
