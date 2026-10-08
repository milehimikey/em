// SPDX-License-Identifier: MIT
// `em upgrade` (MIL-219): bring a model repo authored under an older em (1.6 forward) up to the
// installed version. Nothing here is new machinery — every mechanical step DELEGATES to an
// existing command's own plan/apply (`em skill sync`, `em migrate`, `em ci init`) or an existing
// stateFile.ts primitive; this module is the orchestration: fixed step order, detect-then-apply,
// one git commit per applied step, and the human list of things no command can safely decide by
// itself.
//
// Two disjoint lists, always both computed together (dry-run, `--apply`, and `--check` alike):
//  - **steps** — mechanical, idempotent, each `{ id, sinceVersion, detect, apply }`. `detect`
//    is pure-ish (reads fs, never writes); `apply` performs the actual write and is only ever
//    called when `detect` said `applicable`. A step never partially writes on failure — the
//    same "verify before write" discipline `em migrate` itself holds (migrateReactionShape.ts).
//  - **human** — detect-only, by construction never applied by this command. One of these
//    (`predates-1.6`) is also the one thing that makes `--check` exit 1 — see `checkUpgrade`.
//
// `UpgradeContext` batches everything a step/human-detector needs: the already-compiled model
// (steps never re-compile — the ONE exception, `reaction-shape`, re-reads `modelFile`'s raw text
// itself before applying, precisely because a prior step in the same run could have touched it,
// though in practice no other step ever does) plus the resolved repo root every skill-bundle/
// ci-block/constitution check needs. Requires the model directory to be inside a git
// repository — same requirement `em conform-scope` holds, for the same reason (there is no
// "changed since when" or "commit per step" without one).

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { NormalizedModel, PUBLIC_SCALAR_TYPE_NAMES } from "../model/model.js";
import { findUnresolvedPublicFieldTypes } from "../model/validate.js";
import { RefsResult } from "../model/refs.js";
import { GitRunner, realGit } from "./diff-inputs.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { validateOrphanedSliceDocs } from "../catalog/orphanedSliceDocValidate.js";
import { planMigration, verifyMigration, MigrationPlan } from "./migrateReactionShape.js";
import { planSkillSyncBundle, applySkillSyncBundle } from "./skillSync.js";
import { EM_ALL_SKILL_BUNDLE_DIRS, EM_SKILL_ANCHOR_DIR } from "./skillDirs.js";
import { detectPlugin } from "./pluginPin.js";
import {
  ciWorkflowPath,
  conformWorkflowPath,
  buildCiWorkflowFile,
  buildConformWorkflowFile,
  buildCiWorkflowFileMulti,
  buildConformWorkflowFileMulti,
  ciManagedBody,
  ciManagedBodyMulti,
  conformManagedBody,
  conformManagedBodyMulti,
  ciModelsFromManifest,
  CiModel,
  planCiFile,
  applyCiFile,
  CI_WORKFLOW_MARKER,
  CONFORM_WORKFLOW_MARKER,
} from "./ciInit.js";
import { findSpecifyRoot } from "./status.js";
import { scaffoldConstitution, scaffoldStateFile } from "../templates.js";
import { loadStateFile, parseState, setEmVersion, ensureOptionalBullets, resolveStateFilePath } from "./stateFile.js";
import { fieldLineRegex, normalizeFieldValue, locateFrontmatterInner } from "./frontmatterSurgery.js";
import { localIsoDate } from "../util/localDate.js";
import { compile } from "../pipeline.js";
import { hasErrors } from "../model/validate.js";
import { LEGACY_SYSTEM_MANIFEST_SCHEMA_VERSION, parseManifest, SystemManifest } from "../system/manifest.js";
import { MigrationMember, planManifestMigration } from "../system/migrateManifest.js";
import { loadSource, SYSTEM_MANIFEST_FILE } from "./systemInputs.js";

export const UPGRADE_MIN_SUPPORTED_VERSION = "1.6.0";

export interface UpgradeContext {
  modelFile: string;
  baseDir: string;
  repoRoot: string;
  installedVersion: string;
  packagedSkillsRoot: string;
  model: NormalizedModel;
  refs: RefsResult;
}

export interface StepDetection {
  applicable: boolean;
  reason: string;
  /** True when this step's condition was found but can't be applied mechanically — surfaces as
   *  a human-list item instead (currently only `constitution`, when `.specify/` already owns the
   *  slot). `applicable` is always false alongside `human: true` — the two are never both true. */
  human?: boolean;
}

export type StepApplyOutcome = { ok: true; changedFiles: string[] } | { ok: false; message: string };

export type UpgradeStepId = "skill-bundle" | "reaction-shape" | "state-file" | "ci-block" | "constitution" | "ratified-signoff" | "system-manifest";

export interface UpgradeStepDef {
  id: UpgradeStepId;
  /** The em release that introduced the feature this step brings a repo up to date with —
   *  informational only (printed alongside the step's own reason), sourced from the actual
   *  release that shipped it, never guessed. */
  sinceVersion: string;
  detect(ctx: UpgradeContext): StepDetection;
  apply(ctx: UpgradeContext): StepApplyOutcome;
}

// ---- Step 1: skill-bundle — delegates to `em skill sync`'s own plan/apply. ----

function vendoredSkillsRootOf(repoRoot: string): string {
  return join(repoRoot, ".claude", "skills");
}

function detectSkillBundle(ctx: UpgradeContext): StepDetection {
  const vendoredRoot = vendoredSkillsRootOf(ctx.repoRoot);
  if (!existsSync(join(vendoredRoot, EM_SKILL_ANCHOR_DIR))) {
    // MIL-231: the plugin signal beside the vendored one.
    if (detectPlugin(ctx.repoRoot)) return { applicable: false, reason: "plugin repo — nothing to sync" };
    return { applicable: false, reason: "no vendored skill bundle installed at .claude/skills/ — run `em skill install` first if you want one" };
  }
  const bundlePlan = planSkillSyncBundle(ctx.packagedSkillsRoot, vendoredRoot, EM_ALL_SKILL_BUNDLE_DIRS);
  const totalChanges = bundlePlan.reduce((n, { plan }) => n + plan.changes.length, 0);
  if (totalChanges === 0) return { applicable: false, reason: "vendored skill bundle already matches the installed em" };
  return { applicable: true, reason: `vendored skill bundle differs from the installed em in ${totalChanges} file(s)` };
}

function applySkillBundle(ctx: UpgradeContext): StepApplyOutcome {
  const vendoredRoot = vendoredSkillsRootOf(ctx.repoRoot);
  const bundlePlan = planSkillSyncBundle(ctx.packagedSkillsRoot, vendoredRoot, EM_ALL_SKILL_BUNDLE_DIRS);
  const totalChanges = bundlePlan.reduce((n, { plan }) => n + plan.changes.length, 0);
  if (totalChanges === 0) return { ok: false, message: "nothing to sync" };
  applySkillSyncBundle(bundlePlan, ctx.packagedSkillsRoot, vendoredRoot);
  const changedFiles = bundlePlan.flatMap(({ dirName, plan }) => plan.changes.map((c) => join(".claude", "skills", dirName, c.relPath)));
  return { ok: true, changedFiles };
}

// ---- Step 2: reaction-shape — delegates to `em migrate`'s own plan/verify/apply. ----

function readMigrationPlan(ctx: UpgradeContext): MigrationPlan | null {
  const source = readFileSync(ctx.modelFile, "utf8");
  try {
    return planMigration(source);
  } catch {
    return null; // parse error — surfaced by the normal compile path before upgrade ever runs
  }
}

function detectReactionShape(ctx: UpgradeContext): StepDetection {
  const plan = readMigrationPlan(ctx);
  if (!plan) return { applicable: false, reason: "model file has a parse error — fix it before running em upgrade" };
  if (plan.changes.length === 0) return { applicable: false, reason: "no old two-slice Automation/Translation shape found" };
  return { applicable: true, reason: `${plan.changes.length} old two-slice reaction site(s) found` };
}

function applyReactionShape(ctx: UpgradeContext): StepApplyOutcome {
  const source = readFileSync(ctx.modelFile, "utf8");
  const plan = readMigrationPlan(ctx);
  if (!plan || plan.changes.length === 0) return { ok: false, message: "nothing to migrate" };
  const verify = verifyMigration(source, plan.rewritten!);
  if (!verify.ok) {
    return { ok: false, message: `the rewrite would introduce ${verify.newErrors.length} new error(s) — aborting, ${ctx.modelFile} left untouched` };
  }
  writeFileSync(ctx.modelFile, plan.rewritten!);
  return { ok: true, changedFiles: [ctx.modelFile] };
}

// ---- Step 3: state-file — scaffold when absent (MIL-257); else ensure Model version:/Certified:
// are present (MIL-218 defaults). ----
// `Em version:` itself is deliberately NOT this step's job when the file already exists —
// `runUpgradeApply` always writes it as its own dedicated final commit, whether or not this step
// ran (module header). A freshly scaffolded file is written already carrying the installed
// version (scaffoldStateFile's own `Em version:` fill), so that final commit is then a no-op.

/** MIL-257: the one human-readable sentence for "the state file exists but `parseState` rejected
 *  it", naming the file so the `--check` final line / `--apply` refusal is self-explanatory.
 *  `parseState`'s "missing bullet line(s): ..." reads as `is missing ...`; its format-mismatch
 *  messages (`"- **X:**" doesn't match ...`) follow a colon instead. */
export function describeStateFileFailure(path: string, parseMessage: string): string {
  return parseMessage.startsWith("missing ") ? `state file ${path} is ${parseMessage}` : `state file ${path}: ${parseMessage}`;
}

/** MIL-257: non-null when the state file exists but isn't parseable — shared by `detectStateFile`
 *  (so the checklist line shows the real cause rather than the migration-tolerant
 *  `Model version:`/`Certified:` item) and `applyStateFile`. */
function stateFileParseFailure(ctx: UpgradeContext): string | null {
  const loaded = loadStateFile(ctx.baseDir);
  if (!loaded.ok) return null; // absent — scaffolded, not an error (MIL-257)
  const parsed = parseState(loaded.text);
  return parsed.ok ? null : describeStateFileFailure(loaded.path, parsed.message);
}

function detectStateFile(ctx: UpgradeContext): StepDetection {
  const loaded = loadStateFile(ctx.baseDir);
  if (!loaded.ok) {
    return {
      applicable: true,
      reason: `no state file at ${resolveStateFilePath(ctx.baseDir)} — em upgrade will scaffold one (Current phase: discover, Current step: 1, Last conformance/Last stakeholder review: never)`,
    };
  }
  const failure = stateFileParseFailure(ctx);
  if (failure !== null) return { applicable: false, reason: failure };
  const patched = ensureOptionalBullets(loaded.text, "1970-01-01");
  if (!patched.ok) return { applicable: false, reason: patched.message };
  if (patched.text === loaded.text) return { applicable: false, reason: "Model version:/Certified: bullets already present" };
  return { applicable: true, reason: "state file is missing Model version:/Certified: bullet(s)" };
}

function applyStateFile(ctx: UpgradeContext): StepApplyOutcome {
  const loaded = loadStateFile(ctx.baseDir);
  const today = localIsoDate();
  if (!loaded.ok) {
    // MIL-257: reuse `em scaffold`'s own generator (templates.ts scaffoldStateFile) rather than a
    // second one. `Model file:` names the model actually being upgraded (its own basename).
    const path = resolveStateFilePath(ctx.baseDir);
    const slug = basename(ctx.modelFile, extname(ctx.modelFile));
    writeFileSync(path, scaffoldStateFile(ctx.model.name, slug, today, ctx.installedVersion));
    return { ok: true, changedFiles: [path] };
  }
  const failure = stateFileParseFailure(ctx);
  if (failure !== null) return { ok: false, message: failure };
  const patched = ensureOptionalBullets(loaded.text, today);
  if (!patched.ok) return { ok: false, message: patched.message };
  if (patched.text === loaded.text) return { ok: false, message: "nothing to change" };
  writeFileSync(loaded.path, patched.text);
  return { ok: true, changedFiles: [loaded.path] };
}

// ---- Step 4: ci-block — refreshes both generated workflow files via `em ci init`'s own
// plan/apply, reusing whatever <model>/--tests arguments the existing em-ci.yml was already
// generated with (extracted from its own coverage step — never guessed, never re-prompted).
// Only touches a file that already carries the GENERATED markers; never creates one from
// scratch (module header / ticket: "never creates a workflow the repo didn't ask for"). ----

// Not anchored on a literal "em coverage" — the generated line pins an exact version
// (`npx @milehimikey/em@1.9.0 coverage "..."`, ciInit.ts's own `em` template variable), so
// "em" and "coverage" are never adjacent in the real file.
const CI_INIT_ARGS_RE = /\bcoverage "([^"]*)" --tests "([^"]*)" --strict\b/g;

interface CiInitArgs {
  model: string;
  testsDir: string;
  /** MIL-233: set when the existing block names two or more models - the models re-derived from
   *  the system manifest beside the repo root (the manifest, not the old block, is authoritative
   *  for the set). */
  models: CiModel[] | null;
}

type CiInitArgsResult = { args: CiInitArgs } | { args: null; blocked?: string };

function extractCiInitArgs(emCiContent: string, repoRoot: string): CiInitArgsResult {
  const all = [...emCiContent.matchAll(CI_INIT_ARGS_RE)];
  if (all.length === 0) return { args: null };
  const named = [...new Set(all.map((m) => m[1]))];
  const base = { model: all[0][1], testsDir: all[0][2] };
  if (named.length < 2) return { args: { ...base, models: null } };
  // A multi-model block: regenerate it from the manifest, never from a single model.
  const loaded = ciModelsFromManifest(repoRoot, repoRoot);
  if (!loaded.ok) {
    return {
      args: null,
      blocked: `em-ci.yml covers ${named.length} models (${named.join(", ")}) but no readable system.yaml sits at the repo root (${loaded.message}) - run \`em ci init <system.yaml>\` by hand if it needs refreshing`,
    };
  }
  return { args: { ...base, models: loaded.models } };
}

function ciBlockFiles(args: CiInitArgs, ctx: UpgradeContext): { ci: [string, string]; conform: [string, string] } {
  // MIL-231: same plugin signal `em ci init` uses, so the two never disagree about the conform lines.
  const usePlugin = detectPlugin(ctx.repoRoot) !== null;
  if (args.models) {
    return {
      ci: [buildCiWorkflowFileMulti(SYSTEM_MANIFEST_ARG, args.models, args.testsDir, ctx.installedVersion), ciManagedBodyMulti(args.models, args.testsDir, ctx.installedVersion)],
      conform: [buildConformWorkflowFileMulti(SYSTEM_MANIFEST_ARG, args.models, ctx.installedVersion, usePlugin), conformManagedBodyMulti(args.models, ctx.installedVersion, usePlugin)],
    };
  }
  return {
    ci: [buildCiWorkflowFile(args.model, args.testsDir, ctx.installedVersion), ciManagedBody(args.model, args.testsDir, ctx.installedVersion)],
    conform: [buildConformWorkflowFile(args.model, ctx.installedVersion, usePlugin), conformManagedBody(args.model, ctx.installedVersion, usePlugin)],
  };
}

/** Only used for the generated header's wording on a from-scratch file; `ci-block` only ever
 *  patches the managed block of a file that already exists, so this never reaches disk there. */
const SYSTEM_MANIFEST_ARG = "system.yaml";

function ciBlockPlans(ctx: UpgradeContext): { ciPath: string; ciStale: boolean; conformPath: string; conformStale: boolean; args: CiInitArgs | null; blocked?: string } {
  const ciPath = ciWorkflowPath(ctx.repoRoot);
  const conformPath = conformWorkflowPath(ctx.repoRoot);
  if (!existsSync(ciPath)) return { ciPath, ciStale: false, conformPath, conformStale: false, args: null };
  const extracted = extractCiInitArgs(readFileSync(ciPath, "utf8"), ctx.repoRoot);
  if (!extracted.args) return { ciPath, ciStale: false, conformPath, conformStale: false, args: null, blocked: "blocked" in extracted ? extracted.blocked : undefined };
  const args = extracted.args;
  const multi = args.models !== null;
  const files = ciBlockFiles(args, ctx);

  const ciStatus = planCiFile(ciPath, files.ci[0], files.ci[1], CI_WORKFLOW_MARKER, false, multi);
  const ciStale = ciStatus.kind === "stale";

  let conformStale = false;
  if (existsSync(conformPath)) {
    const conformStatus = planCiFile(conformPath, files.conform[0], files.conform[1], CONFORM_WORKFLOW_MARKER, false, multi);
    conformStale = conformStatus.kind === "stale";
  }
  return { ciPath, ciStale, conformPath, conformStale, args };
}

function detectCiBlock(ctx: UpgradeContext): StepDetection {
  const { ciPath, ciStale, conformStale, args, blocked } = ciBlockPlans(ctx);
  if (!existsSync(ciPath)) return { applicable: false, reason: "no .github/workflows/em-ci.yml — em upgrade never creates one" };
  if (!args && blocked) return { applicable: false, reason: blocked };
  if (!args) return { applicable: false, reason: "can't determine the <model>/--tests arguments em-ci.yml was generated with — run `em ci init <model>` by hand if it needs refreshing" };
  if (!ciStale && !conformStale) return { applicable: false, reason: "generated CI block(s) already match the installed em" };
  return { applicable: true, reason: "generated CI block(s) are stale" };
}

function applyCiBlock(ctx: UpgradeContext): StepApplyOutcome {
  const { ciPath, ciStale, conformPath, conformStale, args } = ciBlockPlans(ctx);
  if (!args || (!ciStale && !conformStale)) return { ok: false, message: "nothing to refresh" };
  const multi = args.models !== null;
  const files = ciBlockFiles(args, ctx);
  const changedFiles: string[] = [];
  if (ciStale) {
    applyCiFile(ciPath, planCiFile(ciPath, files.ci[0], files.ci[1], CI_WORKFLOW_MARKER, false, multi));
    changedFiles.push(ciPath);
  }
  if (conformStale) {
    applyCiFile(conformPath, planCiFile(conformPath, files.conform[0], files.conform[1], CONFORM_WORKFLOW_MARKER, false, multi));
    changedFiles.push(conformPath);
  }
  return { ok: true, changedFiles };
}

// ---- Step 5: constitution — scaffold a draft when absent and no .specify/ owns the slot. ----

function detectConstitution(ctx: UpgradeContext): StepDetection {
  const path = join(ctx.baseDir, "constitution.md");
  if (existsSync(path)) return { applicable: false, reason: "constitution.md already exists" };
  const specifyRoot = findSpecifyRoot(ctx.baseDir);
  if (specifyRoot) {
    return {
      applicable: false,
      human: true,
      reason: `no constitution.md, but ${join(specifyRoot, ".specify")} exists — spec-kit owns the constitution slot (.specify/memory/constitution.md); decide by hand whether it needs writing`,
    };
  }
  return { applicable: true, reason: "no constitution.md and no .specify/ — em upgrade will scaffold a draft" };
}

function applyConstitution(ctx: UpgradeContext): StepApplyOutcome {
  const path = join(ctx.baseDir, "constitution.md");
  if (existsSync(path)) return { ok: false, message: "constitution.md already exists" };
  if (findSpecifyRoot(ctx.baseDir)) return { ok: false, message: ".specify/ exists — not scaffolding a second constitution" };
  writeFileSync(path, scaffoldConstitution(ctx.model.name));
  return { ok: true, changedFiles: [path] };
}

// ---- Step 6: ratified-signoff (MIL-259) — `--slice-ready` now requires a recorded `ratifiedBy`,
// so a doc that reached `ready-to-implement` before sign-offs were recorded (pre-1.8) would
// suddenly read not-ready. Grandfather exactly those: `version: 1` (never reratified — a
// reratified doc has `version > 1` and is mid-sign-off, which only a human can resolve; see the
// `ready-to-implement-no-ratifiedby` human item) with no `ratifiedBy`. A doc with no `version:`
// at all is treated as version 1 (the schema's default). ----

export const GRANDFATHERED_RATIFIER = "grandfathered (unsigned before em 1.14)";

/** Pure text transform: inserts the grandfather sign-off after the `status:` line, using only
 *  the key lines that are missing (a stray `ratifiedOn:` is kept as-is), in the file's own EOL.
 *  `null` when the doc isn't a candidate (no frontmatter/status, or `ratifiedBy` already set). */
export function applyGrandfatherSignoff(raw: string, ratifiedOn: string): string | null {
  const range = locateFrontmatterInner(raw);
  if (!range) return null;
  const inner = raw.slice(range.innerStart, range.innerEnd);
  const statusMatch = fieldLineRegex("status").exec(inner);
  if (!statusMatch) return null;
  const byMatch = fieldLineRegex("ratifiedBy").exec(inner);
  if (byMatch && normalizeFieldValue(byMatch[2]) !== null) return null;
  const onMatch = fieldLineRegex("ratifiedOn").exec(inner);
  const statusEnd = statusMatch.index + statusMatch[0].length;
  const eol = inner.slice(statusEnd).startsWith("\r\n") ? "\r\n" : "\n";
  const value = `"${GRANDFATHERED_RATIFIER}"`;

  // Edits against `inner`, applied highest index first so earlier offsets stay valid. A blank
  // `ratifiedBy:` line is filled in place; missing lines are inserted right after `status:`.
  const missing: string[] = [];
  if (!byMatch) missing.push(`ratifiedBy: ${value}`);
  if (!onMatch) missing.push(`ratifiedOn: ${ratifiedOn}`);
  const edits: { index: number; oldLen: number; next: string }[] = [];
  if (missing.length > 0) edits.push({ index: statusEnd, oldLen: 0, next: eol + missing.join(eol) });
  if (byMatch) edits.push({ index: byMatch.index, oldLen: byMatch[0].length, next: `${byMatch[1]}${value}` });
  edits.sort((a, b) => b.index - a.index);
  let updated = inner;
  for (const e of edits) updated = updated.slice(0, e.index) + e.next + updated.slice(e.index + e.oldLen);
  return raw.slice(0, range.innerStart) + updated + raw.slice(range.innerEnd);
}

function grandfatherCandidates(ctx: UpgradeContext): Array<{ key: string; path: string }> {
  const seen = new Set<string>();
  const out: Array<{ key: string; path: string }> = [];
  for (const d of nonContinuationDocs(ctx)) {
    if (d.status !== "ready-to-implement" || d.ratifiedBy) continue;
    if ((d.version ?? 1) !== 1) continue;
    if (seen.has(d.path)) continue;
    seen.add(d.path);
    out.push({ key: d.key, path: d.path });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function detectRatifiedSignoff(ctx: UpgradeContext): StepDetection {
  const keys = grandfatherCandidates(ctx).map((c) => c.key);
  if (keys.length === 0) return { applicable: false, reason: "no version-1 ready-to-implement doc is missing a ratifiedBy" };
  return {
    applicable: true,
    reason: `${keys.length} ready-to-implement doc(s) with no recorded sign-off (--slice-ready now requires one): ${keys.join(", ")} — em upgrade will record ratifiedBy: "${GRANDFATHERED_RATIFIER}"`,
  };
}

function applyRatifiedSignoff(ctx: UpgradeContext): StepApplyOutcome {
  const candidates = grandfatherCandidates(ctx);
  if (candidates.length === 0) return { ok: false, message: "nothing to grandfather" };
  const today = localIsoDate();
  const writes: Array<{ file: string; text: string }> = [];
  for (const c of candidates) {
    const file = join(ctx.baseDir, c.path);
    const next = applyGrandfatherSignoff(readFileSync(file, "utf8"), today);
    if (next === null) return { ok: false, message: `${c.path}: could not locate status: in the frontmatter` };
    writes.push({ file, text: next });
  }
  for (const w of writes) writeFileSync(w.file, w.text);
  return { ok: true, changedFiles: writes.map((w) => w.file) };
}

// ---- Step 7: system-manifest (MIL-235, R3) — system.yaml 1.0 -> 2.0. ----
// The one mechanical step that writes OTHER models' files: the legacy manifest's seams become
// `consumes` clauses on each consuming translation and its owners become `owner "…"` on each
// member model's header, in the same single commit as the manifest rewrite (its `Em-Upgrade:`
// trailer is what lets MIL-240's scope gate exempt that cross-model change set). Planned by
// src/system/migrateManifest.ts over export documents; this half finds the manifest, loads the
// members, verifies every rewritten model still compiles clean, and only then writes anything.

/** The nearest `system.yaml` from `baseDir` upward, stopping at (and including) `repoRoot`. */
function findSystemManifest(ctx: UpgradeContext): string | null {
  // Real paths on both sides: git reports the repo root symlink-resolved (macOS /var -> /private/var).
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const root = real(ctx.repoRoot);
  let dir = real(ctx.baseDir);
  for (;;) {
    const candidate = join(dir, SYSTEM_MANIFEST_FILE);
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    const parent = dirname(dir);
    const rel = relative(root, parent);
    if (parent === dir || rel.startsWith("..") || isAbsolute(rel)) return null;
    dir = parent;
  }
}

type LoadedLegacyManifest = { path: string; text: string; manifest: SystemManifest } | { path: string | null; reason: string };

function loadLegacyManifest(ctx: UpgradeContext): LoadedLegacyManifest {
  const path = findSystemManifest(ctx);
  if (path === null) return { path: null, reason: `no ${SYSTEM_MANIFEST_FILE} between the model and the repository root` };
  const text = readFileSync(path, "utf8");
  const parsed = parseManifest(text);
  if (!parsed.ok) return { path, reason: `${path} does not parse — run \`em system ${path}\` to see why` };
  if (parsed.manifest.systemSchemaVersion !== LEGACY_SYSTEM_MANIFEST_SCHEMA_VERSION) {
    return { path, reason: `${path} is already systemSchemaVersion "${parsed.manifest.systemSchemaVersion}"` };
  }
  return { path, text, manifest: parsed.manifest };
}

function detectSystemManifest(ctx: UpgradeContext): StepDetection {
  const loaded = loadLegacyManifest(ctx);
  if (!("manifest" in loaded)) return { applicable: false, reason: loaded.reason };
  const m = loaded.manifest;
  return {
    applicable: true,
    reason:
      `${loaded.path} is systemSchemaVersion "1.0" — em upgrade will move its ${m.seams.length} seam(s) into \`consumes\` clauses, ` +
      `its owner(s) onto the ${m.models.length} model header(s), and rewrite it to "2.0"`,
  };
}

function applySystemManifest(ctx: UpgradeContext): StepApplyOutcome {
  const loaded = loadLegacyManifest(ctx);
  if (!("manifest" in loaded)) return { ok: false, message: loaded.reason };
  const baseDir = dirname(loaded.path);
  const members: MigrationMember[] = [];
  for (const entry of loaded.manifest.models) {
    const file = isAbsolute(entry.source) ? entry.source : join(baseDir, entry.source);
    const source = loadSource(file);
    if ("error" in source) return { ok: false, message: `model "${entry.key}": ${source.error}` };
    members.push({ key: entry.key, file, text: source.sourceKind === "em" ? readFileSync(file, "utf8") : null, doc: source.doc });
  }
  const plan = planManifestMigration(loaded.text, loaded.manifest, members);
  if (!plan.ok) return { ok: false, message: plan.message };
  // Verify before write: every rewritten model must still compile with no errors.
  for (const f of plan.files) {
    try {
      const { diagnostics } = compile(f.text);
      if (hasErrors(diagnostics)) return { ok: false, message: `the rewrite of ${f.file} would introduce validation errors — aborting, nothing written` };
    } catch (e) {
      return { ok: false, message: `the rewrite of ${f.file} does not parse (${(e as Error).message}) — aborting, nothing written` };
    }
  }
  const reparsed = parseManifest(plan.manifestText);
  if (!reparsed.ok) return { ok: false, message: `the rewritten ${loaded.path} does not parse as 2.0 — aborting, nothing written` };
  for (const f of plan.files) writeFileSync(f.file, f.text);
  writeFileSync(loaded.path, plan.manifestText);
  return { ok: true, changedFiles: [...plan.files.map((f) => f.file), loaded.path] };
}

export const UPGRADE_STEPS: readonly UpgradeStepDef[] = [
  { id: "skill-bundle", sinceVersion: "1.7.0", detect: detectSkillBundle, apply: applySkillBundle },
  { id: "reaction-shape", sinceVersion: "1.8.0", detect: detectReactionShape, apply: applyReactionShape },
  { id: "state-file", sinceVersion: "1.13.0", detect: detectStateFile, apply: applyStateFile },
  { id: "ci-block", sinceVersion: "1.9.0", detect: detectCiBlock, apply: applyCiBlock },
  { id: "constitution", sinceVersion: "1.11.0", detect: detectConstitution, apply: applyConstitution },
  { id: "ratified-signoff", sinceVersion: "1.14.0", detect: detectRatifiedSignoff, apply: applyRatifiedSignoff },
  { id: "system-manifest", sinceVersion: "1.14.0", detect: detectSystemManifest, apply: applySystemManifest },
];

// ---- Human list — detect-only, never applied. ----

export type HumanItemId =
  | "no-model-version"
  | "continuation-has-own-doc"
  | "ready-to-implement-no-ratifiedby"
  | "coverage-scope-default"
  | "unratified-constitution"
  | "predates-1.6"
  | "public-field-types-unresolved";

export interface HumanItem {
  id: HumanItemId;
  reason: string;
}

function elementRefOf(ctx: UpgradeContext): (id: string) => string {
  return (id: string) => ctx.refs.refById.get(id)!;
}

/** Every non-continuation slice's doc join — computed once, shared by every human detector below
 *  that needs a doc's `status`/`ratifiedBy` (mirrors `modelVersion.ts`'s `computeSlicesVector`
 *  exclusion of continuation slices, MIL-208: a continuation's own join already resolves to its
 *  originating slice's doc, so counting it again here would double-count). */
function nonContinuationDocs(ctx: UpgradeContext) {
  const results: Array<{ key: string; status: string | null; ratifiedBy: string | null; version: number | null; path: string }> = [];
  ctx.model.slices.forEach((slice, i) => {
    const key = ctx.refs.sliceKeys[i];
    const { doc, continuationOf } = resolveSliceDocJoin(ctx.model, ctx.refs, slice, key, ctx.baseDir, elementRefOf(ctx));
    if (continuationOf !== null) return;
    results.push({ key, status: doc.status, ratifiedBy: doc.ratifiedBy, version: doc.version, path: doc.path });
  });
  return results;
}

function detectNoModelVersion(ctx: UpgradeContext): HumanItem | null {
  const loaded = loadStateFile(ctx.baseDir);
  if (!loaded.ok) return null;
  const parsed = parseState(loaded.text);
  if (!parsed.ok || parsed.state.modelVersion !== null) return null;
  const hasImplemented = nonContinuationDocs(ctx).some((d) => d.status === "implemented");
  if (!hasImplemented) return null;
  return {
    id: "no-model-version",
    reason: "Model version: none, but at least one slice is implemented — run `em model version bump --by <name>` to start tracking design versions",
  };
}

function detectContinuationHasOwnDoc(ctx: UpgradeContext): HumanItem | null {
  const diags = validateOrphanedSliceDocs(ctx.model, ctx.refs, ctx.baseDir);
  const count = diags.filter((d) => d.code === "continuation-has-own-doc").length;
  if (count === 0) return null;
  return {
    id: "continuation-has-own-doc",
    reason: `${count} continuation slice(s) still carry their own doc file instead of sharing their originating slice's — see \`em validate\`'s continuation-has-own-doc warning(s)`,
  };
}

function detectReadyNoRatifiedBy(ctx: UpgradeContext): HumanItem | null {
  const keys = nonContinuationDocs(ctx)
    .filter((d) => d.status === "ready-to-implement" && !d.ratifiedBy && (d.version ?? 1) > 1)
    .map((d) => d.key)
    .sort();
  if (keys.length === 0) return null;
  return {
    id: "ready-to-implement-no-ratifiedby",
    reason: `${keys.length} ready-to-implement doc(s) with no ratifiedBy (version > 1, reratified and awaiting a fresh sign-off): ${keys.join(", ")} — run \`em slice ratify --by <name>\` on each`,
  };
}

function detectCoverageScopeDefault(ctx: UpgradeContext): HumanItem | null {
  const ciPath = ciWorkflowPath(ctx.repoRoot);
  if (!existsSync(ciPath)) return null;
  const content = readFileSync(ciPath, "utf8");
  if (!/\bcoverage\b[^\n]*--strict\b/.test(content)) return null;
  const anyImplemented = nonContinuationDocs(ctx).some((d) => d.status === "implemented");
  if (anyImplemented) return null;
  return {
    id: "coverage-scope-default",
    reason: "em-ci.yml runs `em coverage --strict`, but no slice doc is status: implemented yet (MIL-207 scopes --strict to implemented docs only) — the gate is trivially green until the first slice is marked implemented",
  };
}

function detectUnratifiedConstitution(ctx: UpgradeContext): HumanItem | null {
  const specifyRoot = findSpecifyRoot(ctx.baseDir);
  const path = specifyRoot ? join(specifyRoot, ".specify", "memory", "constitution.md") : join(ctx.baseDir, "constitution.md");
  if (!existsSync(path)) return null;
  const content = readFileSync(path, "utf8");
  const inner = locateFrontmatterInner(content);
  if (!inner) return null;
  const innerText = content.slice(inner.innerStart, inner.innerEnd);
  const m = fieldLineRegex("ratifiedBy").exec(innerText);
  const value = m ? normalizeFieldValue(m[2]) : null;
  if (value !== null) return null;
  return { id: "unratified-constitution", reason: `${path} has no ratifiedBy: — it's still a draft` };
}

function detectPredates16(ctx: UpgradeContext): HumanItem | null {
  const plan = readMigrationPlan(ctx);
  if (!plan || plan.refusals.length === 0) return null;
  return {
    id: "predates-1.6",
    reason: `${plan.refusals.length} old-shape reaction site(s) can't be auto-migrated — run \`em migrate\` by hand, resolve the refusal(s), then re-run \`em upgrade\``,
  };
}

/** MIL-237: strict public types (briefing R7). Lists every field of a `public` element (or of a
 *  declared type reachable from one) whose type is not in the fixed public type table and names
 *  no declared type — the same set `em validate`'s `public-field-type-unresolved` errors on.
 *  Detect-only: choosing the right type (or dropping `public`) is a modeling decision. */
function detectPublicFieldTypesUnresolved(ctx: UpgradeContext): HumanItem | null {
  const found = findUnresolvedPublicFieldTypes(ctx.model);
  if (found.length === 0) return null;
  const items = found.map((f) => `${f.owner.name}.${f.field}: ${f.type ?? "(no type)"}`);
  return {
    id: "public-field-types-unresolved",
    reason:
      `${found.length} public field(s) without a public type: ${items.join(", ")} — give each a type from ` +
      `${PUBLIC_SCALAR_TYPE_NAMES.join(", ")}, \`X[]\`, or a declared \`type\` (em 1.14 strict public types), or drop \`public\``,
  };
}

const HUMAN_DETECTORS: ReadonlyArray<(ctx: UpgradeContext) => HumanItem | null> = [
  detectNoModelVersion,
  detectContinuationHasOwnDoc,
  detectReadyNoRatifiedBy,
  detectCoverageScopeDefault,
  detectUnratifiedConstitution,
  detectPredates16,
  detectPublicFieldTypesUnresolved,
];

export function detectHumanItems(ctx: UpgradeContext): HumanItem[] {
  return HUMAN_DETECTORS.map((d) => d(ctx)).filter((x): x is HumanItem => x !== null);
}

// ---- `from`/`to` version resolution ----

export interface FromVersion {
  version: string;
  inferred: boolean;
  basis: string;
}

const EM_VERSION_STAMP_RE = /^em-version:\s*(.+)$/m;

/** `Em version:` if recorded; else a best-effort inference from artifacts already on disk, with
 *  the basis always stated so the output never claims false precision. Never throws — a repo
 *  with no evidence at all reads as "unknown", same sentinel the bullet itself uses. */
export function resolveFromVersion(ctx: UpgradeContext, recorded: string | null): FromVersion {
  if (recorded !== null) return { version: recorded, inferred: false, basis: "recorded `Em version:` bullet" };

  const reactionPlan = readMigrationPlan(ctx);
  if (reactionPlan && (reactionPlan.changes.length > 0 || reactionPlan.refusals.length > 0)) {
    return { version: UPGRADE_MIN_SUPPORTED_VERSION, inferred: true, basis: "old two-slice Automation/Translation reaction shape (pre-1.7.1) found in the model" };
  }

  const skillMdPath = join(vendoredSkillsRootOf(ctx.repoRoot), EM_SKILL_ANCHOR_DIR, "SKILL.md");
  if (existsSync(skillMdPath)) {
    const m = EM_VERSION_STAMP_RE.exec(readFileSync(skillMdPath, "utf8"));
    if (m) return { version: m[1].trim(), inferred: true, basis: "vendored skill bundle's em-version: stamp" };
  }

  const loaded = loadStateFile(ctx.baseDir);
  if (loaded.ok) {
    const hasMil218Bullets = /^-\s+\*\*Model version:\*\*/m.test(loaded.text) || /^-\s+\*\*Certified:\*\*/m.test(loaded.text);
    if (hasMil218Bullets) return { version: "1.13.0", inferred: true, basis: "state file already carries Model version:/Certified: bullets (MIL-218)" };
  }

  return { version: "unknown", inferred: true, basis: "no version evidence found (no Em version: bullet, no skill stamp, no MIL-218 bullets, no old reaction shape)" };
}

// ---- git plumbing for `--apply` ----

export function resolveRepoRoot(anchorDir: string, runGit: GitRunner = realGit): { ok: true; repoRoot: string } | { ok: false; message: string } {
  const r = runGit(["-C", anchorDir, "rev-parse", "--show-toplevel"]);
  if (r.status !== 0) return { ok: false, message: `em upgrade: ${anchorDir} is not inside a git repository — em upgrade --apply needs one commit per step` };
  return { ok: true, repoRoot: r.stdout.trim() };
}

export function isWorkingTreeClean(repoRoot: string, runGit: GitRunner = realGit): boolean {
  const r = runGit(["-C", repoRoot, "status", "--porcelain"]);
  return r.status === 0 && r.stdout.trim().length === 0;
}

/** `true` when `git commit` in `repoRoot` would actually succeed identity-wise — `git config
 *  user.name`/`user.email` (the merged local+global+system view, same one `git commit` itself
 *  consults) both resolve to something non-empty. Checked once, up front, alongside the
 *  dirty-tree refusal: failing here with a clear, single message beats discovering it deep into
 *  step 1's own `git commit` with a confusing passthrough error, and it's a real gap to check —
 *  a CI runner (unlike a developer's own machine) routinely has no git identity configured at
 *  all. */
export function hasGitIdentity(repoRoot: string, runGit: GitRunner = realGit): boolean {
  const name = runGit(["-C", repoRoot, "config", "user.name"]);
  const email = runGit(["-C", repoRoot, "config", "user.email"]);
  return name.status === 0 && name.stdout.trim().length > 0 && email.status === 0 && email.stdout.trim().length > 0;
}

/** The commit trailer key every `em upgrade --apply` commit carries (MIL-235, R2):
 *  `Em-Upgrade: <step-id>` (or `em-version` for the final stamp commit). Readers use
 *  `git log --format=%(trailers:key=Em-Upgrade,valueonly)` — MIL-240's scope gate exempts files
 *  changed only by such commits, since a mechanical migration may legitimately span models. */
export const EM_UPGRADE_TRAILER = "Em-Upgrade";

function gitCommitAll(repoRoot: string, message: string, trailerValue: string, runGit: GitRunner): { ok: true } | { ok: false; message: string } {
  const add = runGit(["-C", repoRoot, "add", "-A"]);
  if (add.status !== 0) return { ok: false, message: `git add failed: ${(add.stderr || "").trim() || "unknown error"}` };
  // Second `-m` = its own paragraph, which git reads as the trailer block.
  const commit = runGit(["-C", repoRoot, "commit", "-m", message, "-m", `${EM_UPGRADE_TRAILER}: ${trailerValue}`]);
  if (commit.status !== 0) return { ok: false, message: `git commit failed: ${(commit.stderr || "").trim() || "unknown error"}` };
  return { ok: true };
}

/** Discards every uncommitted change in `repoRoot` — tracked and untracked alike. Only ever
 *  called right after a step's `apply` reports failure, to restore the "clean before the next
 *  step" invariant `isWorkingTreeClean`'s pre-flight check depends on; safe precisely because
 *  that pre-flight check already proved the tree was clean before this run started, so anything
 *  dirty now was written by the step that just failed. */
function gitDiscardAll(repoRoot: string, runGit: GitRunner): void {
  runGit(["-C", repoRoot, "checkout", "--", "."]);
  runGit(["-C", repoRoot, "clean", "-fd", "."]);
}

// ---- Orchestration ----

export interface StepReport {
  id: UpgradeStepId;
  sinceVersion: string;
  applicable: boolean;
  human: boolean;
  reason: string;
}

export interface UpgradeReport {
  from: FromVersion;
  to: string;
  steps: StepReport[];
  human: HumanItem[];
  stateFileError: string | null;
}

/** Dry-run: detect every step and every human item, apply nothing. Shared by `--json`, plain
 *  text output, `--check`, and the first phase of `--apply`. */
export function detectUpgrade(ctx: UpgradeContext): UpgradeReport {
  const loaded = loadStateFile(ctx.baseDir);
  let recorded: string | null = null;
  // MIL-257: an ABSENT state file is no longer an error — the `state-file` step scaffolds it — so
  // `stateFileError` is `null` for it (the pending step's own reason carries the detail). It is
  // set only for a file that exists but doesn't parse, and now names the file.
  let stateFileError: string | null = null;
  if (loaded.ok) {
    const parsed = parseState(loaded.text);
    if (!parsed.ok) stateFileError = describeStateFileFailure(loaded.path, parsed.message);
    else recorded = parsed.state.emVersion;
  }

  const from = resolveFromVersion(ctx, recorded);
  const steps: StepReport[] = UPGRADE_STEPS.map((s) => {
    const d = s.detect(ctx);
    return { id: s.id, sinceVersion: s.sinceVersion, applicable: d.applicable, human: d.human === true, reason: d.reason };
  });
  const human = detectHumanItems(ctx);

  return { from, to: ctx.installedVersion, steps, human, stateFileError };
}

export interface ApplyStepResult {
  id: UpgradeStepId;
  applied: boolean;
  changedFiles: string[];
  commit: string | null;
}

export type ApplyUpgradeResult =
  | { ok: true; report: UpgradeReport; applied: ApplyStepResult[]; emVersionCommit: string | null }
  | { ok: false; message: string; report: UpgradeReport; applied: ApplyStepResult[] };

/**
 * `--apply`: detect, then apply every applicable mechanical step in fixed order, one commit
 * each (`em upgrade: <step-id> (<from> → <to>)`, trailer `Em-Upgrade: <step-id>`), stopping at the first failure with every
 * prior commit intact and the failed step's own partial writes discarded. On full success,
 * writes `Em version: <to>` as one final commit — always, even when every step above was a
 * no-op, UNLESS the bullet already reads `<to>` (idempotent second run makes zero commits).
 * Refuses outright on a dirty starting working tree.
 */
export function applyUpgrade(ctx: UpgradeContext, runGit: GitRunner = realGit): ApplyUpgradeResult {
  const report = detectUpgrade(ctx);
  if (report.stateFileError) {
    return { ok: false, message: `em upgrade: unparseable state file — ${report.stateFileError}`, report, applied: [] };
  }
  if (!isWorkingTreeClean(ctx.repoRoot, runGit)) {
    return { ok: false, message: "em upgrade --apply: working tree is not clean — commit or stash first", report, applied: [] };
  }
  if (!hasGitIdentity(ctx.repoRoot, runGit)) {
    return {
      ok: false,
      message:
        "em upgrade --apply: no git identity configured — run `git config user.name <name>` and " +
        "`git config user.email <email>` first (add --global to set it once for every repo)",
      report,
      applied: [],
    };
  }

  const applied: ApplyStepResult[] = [];
  for (const step of UPGRADE_STEPS) {
    const detection = step.detect(ctx);
    if (!detection.applicable) {
      applied.push({ id: step.id, applied: false, changedFiles: [], commit: null });
      continue;
    }
    const result = step.apply(ctx);
    if (!result.ok) {
      gitDiscardAll(ctx.repoRoot, runGit);
      return { ok: false, message: `em upgrade: step "${step.id}" failed — ${result.message}`, report, applied };
    }
    const message = `em upgrade: ${step.id} (${report.from.version} → ${report.to})`;
    const commitResult = gitCommitAll(ctx.repoRoot, message, step.id, runGit);
    if (!commitResult.ok) {
      return { ok: false, message: `em upgrade: step "${step.id}" applied but failed to commit — ${commitResult.message}`, report, applied };
    }
    applied.push({ id: step.id, applied: true, changedFiles: result.changedFiles, commit: message });
  }

  const loaded = loadStateFile(ctx.baseDir);
  let emVersionCommit: string | null = null;
  if (loaded.ok) {
    const today = localIsoDate();
    const stamped = setEmVersion(loaded.text, ctx.installedVersion, today);
    if (stamped.ok && stamped.text !== loaded.text) {
      writeFileSync(loaded.path, stamped.text);
      const message = `em upgrade: em-version (${report.from.version} → ${report.to})`;
      const commitResult = gitCommitAll(ctx.repoRoot, message, "em-version", runGit);
      if (!commitResult.ok) {
        return { ok: false, message: `em upgrade: writing Em version: failed to commit — ${commitResult.message}`, report, applied };
      }
      emVersionCommit = message;
    }
  }

  return { ok: true, report, applied, emVersionCommit };
}

/** MIL-257: every cause that makes `--check` exit 1, each as one sentence, so the final line
 *  always says why. Empty when there is no hard incompatibility. */
export function hardIncompatibilityReasons(report: UpgradeReport): string[] {
  const reasons: string[] = [];
  if (report.stateFileError !== null) reasons.push(report.stateFileError);
  for (const h of report.human) if (h.id === "predates-1.6") reasons.push(`predates-1.6: ${h.reason}`);
  return reasons;
}

/** `--check` (what CI runs): exit-worthiness only — no writes. Hard incompatibilities are the
 *  ONLY thing that makes this fail: a state file that exists but is unparseable (a MISSING one is
 *  scaffolded by the `state-file` step, MIL-257, so it is a pending step, not a failure), or a
 *  `predates-1.6` human item (an old reaction shape `em migrate` itself refuses to touch). Every
 *  other human item — including the ordinary "some steps are applicable" case — is advisory, same
 *  as running `em upgrade` without `--apply` at all. `reasons` (MIL-257) is why `ok` is false. */
export function checkUpgrade(ctx: UpgradeContext): { ok: boolean; report: UpgradeReport; reasons: string[] } {
  const report = detectUpgrade(ctx);
  const reasons = hardIncompatibilityReasons(report);
  return { ok: reasons.length === 0, report, reasons };
}
