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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { GitRunner, realGit } from "./diff-inputs.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { validateOrphanedSliceDocs } from "../catalog/orphanedSliceDocValidate.js";
import { planMigration, verifyMigration, MigrationPlan } from "./migrateReactionShape.js";
import { planSkillSyncBundle, applySkillSyncBundle } from "./skillSync.js";
import { EM_ALL_SKILL_BUNDLE_DIRS, EM_SKILL_ANCHOR_DIR } from "./skillDirs.js";
import {
  ciWorkflowPath,
  conformWorkflowPath,
  buildCiWorkflowFile,
  buildConformWorkflowFile,
  ciManagedBody,
  conformManagedBody,
  planCiFile,
  applyCiFile,
  CI_WORKFLOW_MARKER,
  CONFORM_WORKFLOW_MARKER,
} from "./ciInit.js";
import { findSpecifyRoot } from "./status.js";
import { scaffoldConstitution } from "../templates.js";
import { loadStateFile, parseState, setEmVersion, ensureOptionalBullets } from "./stateFile.js";
import { fieldLineRegex, normalizeFieldValue, locateFrontmatterInner } from "./frontmatterSurgery.js";
import { localIsoDate } from "../util/localDate.js";

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

export type UpgradeStepId = "skill-bundle" | "reaction-shape" | "state-file" | "ci-block" | "constitution";

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

// ---- Step 3: state-file — ensure Model version:/Certified: are present (MIL-218 defaults). ----
// `Em version:` itself is deliberately NOT this step's job — `runUpgradeApply` always writes it
// as its own dedicated final commit, whether or not this step ran (module header).

function detectStateFile(ctx: UpgradeContext): StepDetection {
  const loaded = loadStateFile(ctx.baseDir);
  if (!loaded.ok) return { applicable: false, reason: loaded.message };
  const patched = ensureOptionalBullets(loaded.text, "1970-01-01");
  if (!patched.ok) return { applicable: false, reason: patched.message };
  if (patched.text === loaded.text) return { applicable: false, reason: "Model version:/Certified: bullets already present" };
  return { applicable: true, reason: "state file is missing Model version:/Certified: bullet(s)" };
}

function applyStateFile(ctx: UpgradeContext): StepApplyOutcome {
  const loaded = loadStateFile(ctx.baseDir);
  if (!loaded.ok) return { ok: false, message: loaded.message };
  const today = localIsoDate();
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
const CI_INIT_ARGS_RE = /\bcoverage "([^"]*)" --tests "([^"]*)" --strict\b/;

function extractCiInitArgs(emCiContent: string): { model: string; testsDir: string } | null {
  const m = CI_INIT_ARGS_RE.exec(emCiContent);
  return m ? { model: m[1], testsDir: m[2] } : null;
}

function ciBlockPlans(ctx: UpgradeContext): { ciPath: string; ciStale: boolean; conformPath: string; conformStale: boolean; args: { model: string; testsDir: string } | null } {
  const ciPath = ciWorkflowPath(ctx.repoRoot);
  const conformPath = conformWorkflowPath(ctx.repoRoot);
  if (!existsSync(ciPath)) return { ciPath, ciStale: false, conformPath, conformStale: false, args: null };
  const args = extractCiInitArgs(readFileSync(ciPath, "utf8"));
  if (!args) return { ciPath, ciStale: false, conformPath, conformStale: false, args: null };

  const ciStatus = planCiFile(ciPath, buildCiWorkflowFile(args.model, args.testsDir, ctx.installedVersion), ciManagedBody(args.model, args.testsDir, ctx.installedVersion), CI_WORKFLOW_MARKER, false);
  const ciStale = ciStatus.kind === "stale";

  let conformStale = false;
  if (existsSync(conformPath)) {
    const conformStatus = planCiFile(conformPath, buildConformWorkflowFile(args.model, ctx.installedVersion), conformManagedBody(args.model, ctx.installedVersion), CONFORM_WORKFLOW_MARKER, false);
    conformStale = conformStatus.kind === "stale";
  }
  return { ciPath, ciStale, conformPath, conformStale, args };
}

function detectCiBlock(ctx: UpgradeContext): StepDetection {
  const { ciPath, ciStale, conformStale, args } = ciBlockPlans(ctx);
  if (!existsSync(ciPath)) return { applicable: false, reason: "no .github/workflows/em-ci.yml — em upgrade never creates one" };
  if (!args) return { applicable: false, reason: "can't determine the <model>/--tests arguments em-ci.yml was generated with — run `em ci init <model>` by hand if it needs refreshing" };
  if (!ciStale && !conformStale) return { applicable: false, reason: "generated CI block(s) already match the installed em" };
  return { applicable: true, reason: "generated CI block(s) are stale" };
}

function applyCiBlock(ctx: UpgradeContext): StepApplyOutcome {
  const { ciPath, ciStale, conformPath, conformStale, args } = ciBlockPlans(ctx);
  if (!args || (!ciStale && !conformStale)) return { ok: false, message: "nothing to refresh" };
  const changedFiles: string[] = [];
  if (ciStale) {
    const status = planCiFile(ciPath, buildCiWorkflowFile(args.model, args.testsDir, ctx.installedVersion), ciManagedBody(args.model, args.testsDir, ctx.installedVersion), CI_WORKFLOW_MARKER, false);
    applyCiFile(ciPath, status);
    changedFiles.push(ciPath);
  }
  if (conformStale) {
    const status = planCiFile(conformPath, buildConformWorkflowFile(args.model, ctx.installedVersion), conformManagedBody(args.model, ctx.installedVersion), CONFORM_WORKFLOW_MARKER, false);
    applyCiFile(conformPath, status);
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

export const UPGRADE_STEPS: readonly UpgradeStepDef[] = [
  { id: "skill-bundle", sinceVersion: "1.7.0", detect: detectSkillBundle, apply: applySkillBundle },
  { id: "reaction-shape", sinceVersion: "1.8.0", detect: detectReactionShape, apply: applyReactionShape },
  { id: "state-file", sinceVersion: "1.13.0", detect: detectStateFile, apply: applyStateFile },
  { id: "ci-block", sinceVersion: "1.9.0", detect: detectCiBlock, apply: applyCiBlock },
  { id: "constitution", sinceVersion: "1.11.0", detect: detectConstitution, apply: applyConstitution },
];

// ---- Human list — detect-only, never applied. ----

export type HumanItemId =
  | "no-model-version"
  | "continuation-has-own-doc"
  | "ready-to-implement-no-ratifiedby"
  | "coverage-scope-default"
  | "unratified-constitution"
  | "predates-1.6";

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
  const results: Array<{ key: string; status: string | null; ratifiedBy: string | null }> = [];
  ctx.model.slices.forEach((slice, i) => {
    const key = ctx.refs.sliceKeys[i];
    const { doc, continuationOf } = resolveSliceDocJoin(ctx.model, ctx.refs, slice, key, ctx.baseDir, elementRefOf(ctx));
    if (continuationOf !== null) return;
    results.push({ key, status: doc.status, ratifiedBy: doc.ratifiedBy });
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
    .filter((d) => d.status === "ready-to-implement" && !d.ratifiedBy)
    .map((d) => d.key)
    .sort();
  if (keys.length === 0) return null;
  return {
    id: "ready-to-implement-no-ratifiedby",
    reason: `${keys.length} ready-to-implement doc(s) with no ratifiedBy: ${keys.join(", ")} — run \`em slice ratify --by <name>\` on each`,
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

const HUMAN_DETECTORS: ReadonlyArray<(ctx: UpgradeContext) => HumanItem | null> = [
  detectNoModelVersion,
  detectContinuationHasOwnDoc,
  detectReadyNoRatifiedBy,
  detectCoverageScopeDefault,
  detectUnratifiedConstitution,
  detectPredates16,
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

function gitCommitAll(repoRoot: string, message: string, runGit: GitRunner): { ok: true } | { ok: false; message: string } {
  const add = runGit(["-C", repoRoot, "add", "-A"]);
  if (add.status !== 0) return { ok: false, message: `git add failed: ${(add.stderr || "").trim() || "unknown error"}` };
  const commit = runGit(["-C", repoRoot, "commit", "-m", message]);
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
  let stateFileError: string | null = null;
  if (!loaded.ok) {
    stateFileError = loaded.message;
  } else {
    const parsed = parseState(loaded.text);
    if (!parsed.ok) stateFileError = parsed.message;
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
 * each (`em upgrade: <step-id> (<from> → <to>)`), stopping at the first failure with every
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
    const commitResult = gitCommitAll(ctx.repoRoot, message, runGit);
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
      const commitResult = gitCommitAll(ctx.repoRoot, message, runGit);
      if (!commitResult.ok) {
        return { ok: false, message: `em upgrade: writing Em version: failed to commit — ${commitResult.message}`, report, applied };
      }
      emVersionCommit = message;
    }
  }

  return { ok: true, report, applied, emVersionCommit };
}

/** `--check` (what CI runs): exit-worthiness only — no writes. Hard incompatibilities are the
 *  ONLY thing that makes this fail: an unparseable/missing state file, or a `predates-1.6` human
 *  item (an old reaction shape `em migrate` itself refuses to touch). Every other human item —
 *  including the ordinary "some steps are applicable" case — is advisory, same as running
 *  `em upgrade` without `--apply` at all. */
export function checkUpgrade(ctx: UpgradeContext): { ok: boolean; report: UpgradeReport } {
  const report = detectUpgrade(ctx);
  const hardIncompatibility = report.stateFileError !== null || report.human.some((h) => h.id === "predates-1.6");
  return { ok: !hardIncompatibility, report };
}
