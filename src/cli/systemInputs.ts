// SPDX-License-Identifier: MIT
// The filesystem half of `em system` (MIL-194): read the manifest, resolve each model's
// `source` relative to the manifest's directory, and turn every source — a `.em` file compiled
// in-process, or an `em export --json` document read as-is — into the ONE input shape the
// verifier (src/system/verify.ts) accepts: an export document. That is how "verification reads
// export JSON only" stays true while a co-located repo still gets to point at its `.em` files
// directly: a `.em` source is compiled with the same `compile()` + `buildExportDoc()` `em export`
// itself runs, never through a second model reader, so the verifier can't tell the two apart.
//
// Shared by the CLI action (src/cli.ts) and the MCP `system` tool (src/mcp/server.ts) so the two
// surfaces load a system identically — the parity requirement. Every failure is a returned
// diagnostic, never a throw or a process exit: the CLI prints and exits, MCP returns a tool error.
//
// Discovery (MIL-235, ruling R4): with no manifest, the system is every `*.em` file in the
// repository — `git ls-files -z -- '*.em'` from the repo root (honours `.gitignore` and matches
// what the generated CI lints), or, outside git, a walk of the start directory pruning
// `node_modules`/`.git`. `*-asis.em` (em conform-scope's seeded as-is models) is always skipped.
// Model keys are `computeModelKeys`'s (first file wins the bare key, later ones get `~2` …).

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { compile } from "../pipeline.js";
import { ParseError } from "../parser/parser.js";
import { hasErrors } from "../model/validate.js";
import { buildExportDoc } from "../emit/json.js";
import { makeDiag } from "../model/rules.js";
import { computeModelKeys } from "../model/qualifiedRef.js";
import type { NormalizedModel } from "../model/model.js";
import { walkDir } from "../util/walkDir.js";
import { GitRunner, realGit } from "./diff-inputs.js";
import { parseManifest, SystemManifest } from "../system/manifest.js";
import { SystemDiagnostic, SystemDiscovery, SystemExportDoc, SystemModelInput, verifySystem } from "../system/verify.js";

export type { SystemDiscovery };

/** The manifest file name `em system` looks for in a directory before falling back to discovery. */
export const SYSTEM_MANIFEST_FILE = "system.yaml";

/** The oldest `em export` schema whose document carries what the verifier reads (`model.key`
 *  from MIL-193, `model.edges` from MIL-191 — both schema 1.10). */
export const MIN_EXPORT_SCHEMA = { major: 1, minor: 10 };

export type LoadSystemResult =
  | {
      ok: true;
      /** `null` in discovery mode. */
      manifest: SystemManifest | null;
      /** The manifest path as given (or found in the given directory); `null` in discovery mode. */
      manifestPath: string | null;
      manifestText: string | null;
      /** Non-null exactly when `manifest` is null. */
      discovery: SystemDiscovery | null;
      models: SystemModelInput[];
      /** Load-time findings that are not refusals (discovery's `duplicate-model-key` warnings);
       *  hand them to `verifySystem` as `preDiagnostics`. */
      diagnostics: SystemDiagnostic[];
    }
  | { ok: false; diagnostics: SystemDiagnostic[] };

/** `em system [<target>]`'s loader. `target` is a manifest file (loaded as before), a directory
 *  (its `system.yaml` if it has one, else discovery from it), or omitted (= `"."`, the working
 *  directory). `ok: false` means the system can't be verified at all (unreadable/invalid
 *  manifest, or a source that can't be read, parsed, or has compile errors) — the caller
 *  refuses, the same way `em export` refuses a model with errors, rather than verifying a
 *  partial system. */
export function loadSystem(target: string = ".", runGit: GitRunner = realGit): LoadSystemResult {
  let isDir = false;
  try {
    isDir = statSync(target).isDirectory();
  } catch {
    // missing path: fall through to the manifest reader, which reports "cannot read"
  }
  if (!isDir) return loadManifestSystem(target);
  const candidate = target === "." ? SYSTEM_MANIFEST_FILE : join(target, SYSTEM_MANIFEST_FILE);
  if (existsSync(candidate)) return loadManifestSystem(candidate);
  return loadDiscoveredSystem(target, runGit);
}

/** Read + parse the manifest at `manifestPath` and load every model it declares. */
function loadManifestSystem(manifestPath: string): LoadSystemResult {
  let manifestText: string;
  try {
    manifestText = readFileSync(manifestPath, "utf8");
  } catch {
    return { ok: false, diagnostics: [{ file: manifestPath, ...makeDiag("system-manifest-invalid", { message: `cannot read ${manifestPath}` }) }] };
  }
  const parsed = parseManifest(manifestText);
  if (!parsed.ok) {
    return { ok: false, diagnostics: parsed.diagnostics.map((d) => ({ file: manifestPath, ...d })) };
  }

  const baseDir = dirname(manifestPath);
  const diagnostics: SystemDiagnostic[] = [];
  const models: SystemModelInput[] = [];
  for (const entry of parsed.manifest.models) {
    // Joined, not resolved: diagnostics and `--json` echo this path, and a document a CI job
    // commits must not embed one machine's absolute checkout path — `em export`'s `source.path`
    // keeps the same "as given" posture.
    const file = isAbsolute(entry.source) ? entry.source : join(baseDir, entry.source);
    const loaded = loadSource(file);
    if ("error" in loaded) {
      diagnostics.push({
        file: manifestPath,
        ...makeDiag("system-manifest-invalid", { message: `model "${entry.key}": ${loaded.error}`, line: entry.line }),
      });
      continue;
    }
    models.push({
      key: entry.key,
      source: entry.source,
      sourceKind: loaded.sourceKind,
      owner: ownerOf(loaded.doc, entry.owner),
      file,
      doc: loaded.doc,
    });
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  return { ok: true, manifest: parsed.manifest, manifestPath, manifestText, discovery: null, models, diagnostics: [] };
}

/** The header's owners (export schema >= 1.15); a legacy 1.0 manifest's `owner:` only fills in
 *  when the header names none — so a half-migrated estate still shows who owns what. */
function ownerOf(doc: SystemExportDoc, manifestOwner: string | null): string[] {
  const header = Array.isArray(doc.model.owner) ? doc.model.owner : [];
  if (header.length > 0) return [...header];
  return manifestOwner === null ? [] : [manifestOwner];
}

/** Discovery (R4): find every model, compile each, key them with `computeModelKeys`. */
function loadDiscoveredSystem(startDir: string, runGit: GitRunner): LoadSystemResult {
  const found = discoverModelFiles(startDir, runGit);
  const diagnostics: SystemDiagnostic[] = [];
  const loaded: Array<{ source: string; file: string; model: NormalizedModel; doc: SystemExportDoc }> = [];
  for (const source of found.files) {
    const file = join(found.root, source);
    const result = loadSource(file);
    if ("error" in result) {
      diagnostics.push({ file, ...makeDiag("system-manifest-invalid", { message: `discovered model ${source}: ${result.error}` }) });
      continue;
    }
    loaded.push({ source, file, model: result.model!, doc: result.doc });
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  if (loaded.length === 0) {
    return {
      ok: false,
      diagnostics: [
        {
          file: found.root,
          ...makeDiag("system-manifest-invalid", {
            message: `no ${SYSTEM_MANIFEST_FILE} and no .em models found under ${found.root} — pass a manifest, or run from the repository that holds the models`,
          }),
        },
      ],
    };
  }
  const keyed = computeModelKeys(loaded.map((l) => ({ model: l.model, file: l.source })));
  const pre: SystemDiagnostic[] = keyed.diagnostics.map((d) => ({ file: found.root, ...d }));
  const models: SystemModelInput[] = loaded.map((l, i) => ({
    key: keyed.keys[i],
    source: l.source,
    sourceKind: "em",
    owner: ownerOf(l.doc, null),
    file: l.file,
    doc: l.doc,
  }));
  return { ok: true, manifest: null, manifestPath: null, manifestText: null, discovery: found, models, diagnostics: pre };
}

/** The discovery file list (R4). Inside a git work tree: `git ls-files -z -- '*.em'` run at the
 *  repo root (tracked files only — what CI sees), skipping any listed file missing from the
 *  working tree. Outside git: a sorted walk of `startDir` pruning `node_modules` and `.git`.
 *  Either way `*-asis.em` is dropped. `root` is the repo root as reached from `startDir`
 *  (`startDir` itself, or e.g. `../..` joined onto it), never an absolute path the caller
 *  didn't give. Exported for tests. */
export function discoverModelFiles(startDir: string, runGit: GitRunner = realGit): SystemDiscovery {
  const keep = (f: string) => f.endsWith(".em") && !f.endsWith("-asis.em");
  const top = runGit(["-C", startDir, "rev-parse", "--show-toplevel"]);
  if (top.status === 0 && top.stdout.trim() !== "") {
    const topDir = top.stdout.trim();
    let up = "";
    try {
      up = relative(realpathSync(startDir), realpathSync(topDir));
    } catch {
      up = "";
    }
    const root = up === "" ? startDir : join(startDir, up);
    const listed = runGit(["-C", topDir, "ls-files", "-z", "--", "*.em"]);
    if (listed.status === 0) {
      const files = listed.stdout
        .split("\0")
        .filter((f) => f !== "" && keep(f) && existsSync(join(topDir, f)))
        .sort();
      return { root, files };
    }
  }
  const files = walkDir(startDir, { skipDir: (name) => name === "node_modules" || name === ".git" })
    .filter(keep)
    .map((f) => f.split(sep).join("/"));
  return { root: startDir, files };
}

export type LoadedSource = { sourceKind: "em" | "export"; doc: SystemExportDoc; model?: NormalizedModel } | { error: string };

/** One source path to an export document. `.em` compiles (refusing on parse/validation
 *  errors, same gate as `em export`); anything else is read as an `em export --json` document
 *  and shape-checked for the fields the verifier needs. */
export function loadSource(file: string): LoadedSource {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { error: `cannot read ${file}` };
  }
  if (extname(file).toLowerCase() === ".em") {
    try {
      const { model, refs, diagnostics } = compile(text);
      if (hasErrors(diagnostics)) {
        return { error: `${file} has validation errors — run \`em validate ${file}\` and fix them first` };
      }
      // The document's own `model.key` (MIL-193, schema 1.10) is the key the manifest must match —
      // never recomputed here, so `em system` and `em export` can't disagree about it.
      const { doc } = buildExportDoc(model, refs, diagnostics, text, file);
      return { sourceKind: "em", doc, model };
    } catch (e) {
      if (e instanceof ParseError) return { error: `parse error in ${file} ${e.message}` };
      throw e;
    }
  }
  return readExportDoc(text, file);
}

/** Shape-check an `em export --json` document: `schemaVersion` >= 1.10 and the `model.key`/
 *  `model.slices`/`model.edges` fields present. Deliberately shallow — this is a guard against
 *  handing the verifier a file that isn't an export at all (or one from an older em), not a
 *  full schema validation; an export em itself wrote is trusted past this point. */
export function readExportDoc(text: string, file: string): LoadedSource {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: `${file} is not valid JSON (expected an \`em export --json\` document)` };
  }
  if (typeof raw !== "object" || raw === null || typeof (raw as { schemaVersion?: unknown }).schemaVersion !== "string") {
    return { error: `${file} is not an \`em export --json\` document (no schemaVersion)` };
  }
  const doc = raw as { schemaVersion: string; model?: Record<string, unknown> };
  const [majorStr, minorStr] = doc.schemaVersion.split(".");
  const major = Number(majorStr);
  const minor = Number(minorStr);
  const tooOld = !Number.isInteger(major) || !Number.isInteger(minor) || major < MIN_EXPORT_SCHEMA.major || (major === MIN_EXPORT_SCHEMA.major && minor < MIN_EXPORT_SCHEMA.minor);
  if (tooOld) {
    return {
      error:
        `${file} has export schemaVersion "${doc.schemaVersion}" — \`em system\` needs >= ${MIN_EXPORT_SCHEMA.major}.${MIN_EXPORT_SCHEMA.minor} ` +
        `(model.key and model.edges); regenerate it with a current \`em export --json\``,
    };
  }
  const model = doc.model;
  if (typeof model !== "object" || model === null) return { error: `${file}: export document has no \`model\`` };
  if (typeof model.key !== "string") return { error: `${file}: export document has no \`model.key\` — regenerate it with a current \`em export --json\`` };
  if (!Array.isArray(model.slices)) return { error: `${file}: export document has no \`model.slices\`` };
  if (!Array.isArray(model.edges)) return { error: `${file}: export document has no \`model.edges\` — regenerate it with a current \`em export --json\`` };
  return { sourceKind: "export", doc: raw as SystemExportDoc };
}

/** The `producerCommit` resolver `verifySystem` takes (MIL-239): the short sha of the last
 *  commit touching the model's `.em` source, via `git log -n1`. `null` — never an error — for an
 *  export-document source, a path outside git, or a file with no history. */
export function gitProducerCommit(runGit: GitRunner = realGit): (model: SystemModelInput) => string | null {
  return (model) => {
    if (model.sourceKind !== "em") return null;
    const log = runGit(["-C", dirname(model.file), "log", "-n1", "--format=%H", "--", basename(model.file)]);
    const sha = log.status === 0 ? log.stdout.trim() : "";
    return sha === "" ? null : sha.slice(0, 12);
  };
}

/** R11: the nearest `system.yaml` walking up from the directory of `file` (the first input of
 *  `em status`), stopping after the repo root (the first directory holding `.git`) or at the
 *  filesystem root. The path is joined from `file`'s own directory ("as given", never absolutized)
 *  and normalized to `/` separators. `null` when none is found. */
export function findSystemManifestAbove(file: string): string | null {
  let dir = dirname(file);
  let abs = realpathOrResolve(dir);
  for (;;) {
    const candidate = join(dir, SYSTEM_MANIFEST_FILE);
    if (existsSync(candidate)) return normalize(candidate).split(sep).join("/");
    if (existsSync(join(abs, ".git"))) return null;
    const parent = dirname(abs);
    if (parent === abs) return null;
    abs = parent;
    dir = join(dir, "..");
  }
}

function realpathOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** `em status`'s `system` block (R11), shared with the MCP `status` tool: auto-discover the
 *  manifest above `firstFile`, run the full system verification, count `consumer-not-adapted`.
 *  `null` when there is no manifest above, or when it cannot be loaded (an invalid manifest is
 *  `em system`'s to report; `warn` receives the reason for the CLI to print). */
export function statusSystemBlock(
  firstFile: string,
  runGit: GitRunner = realGit,
  warn: (message: string) => void = () => {},
): { manifest: string; consumerNotAdapted: number } | null {
  const manifest = findSystemManifestAbove(firstFile);
  if (manifest === null) return null;
  const loaded = loadSystem(manifest, runGit);
  if (!loaded.ok) {
    warn(`system ${manifest} not checked — ${loaded.diagnostics[0]?.message ?? "cannot be loaded"}`);
    return null;
  }
  const report = verifySystem(loaded.manifest, loaded.models, loaded.manifestPath, loaded.diagnostics, { producerCommit: gitProducerCommit(runGit) });
  return { manifest, consumerNotAdapted: report.consumerAdaptation.notAdapted };
}
