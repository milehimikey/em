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

import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { findRosterAbove, GRANDFATHERED_RATIFIER } from "../roster/roster.js";
import { NormalizedModel, PUBLIC_SCALAR_TYPE_NAMES } from "../model/model.js";
import { findUnresolvedPublicFieldTypes } from "../model/validate.js";
import { RefsResult } from "../model/refs.js";
import { GitRunner, realGit } from "./diff-inputs.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { validateOrphanedSliceDocs } from "../catalog/orphanedSliceDocValidate.js";
import { planMigration, verifyMigration, MigrationPlan } from "./migrateReactionShape.js";
import { planSkillSyncBundle, applySkillSyncBundle, planAgentSync, applySkillSync } from "./skillSync.js";
import { EM_ALL_SKILL_BUNDLE_DIRS, EM_SKILL_ANCHOR_DIR, EM_AGENT_FILES } from "./skillDirs.js";
import { detectPlugin, checkPlugin, claudePluginsDir, mergePluginSettings, pluginInstallCommands, pluginSettingsEntries } from "./pluginPin.js";
import { syncAgentsMd } from "./agentsMd.js";
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
  refreshCiPullRequestPaths,
  applyCiPullRequestPathsRefresh,
  missingCiPullRequestPaths,
  CI_WORKFLOW_MARKER,
  CONFORM_WORKFLOW_MARKER,
} from "./ciInit.js";
import { findSpecifyRoot, locateConstitution } from "./status.js";
import { scaffoldConstitution, scaffoldStateFile } from "../templates.js";
import { loadStateFile, parseState, setEmVersion, ensureOptionalBullets, resolveStateFilePath } from "./stateFile.js";
import { fieldLineRegex, normalizeFieldValue, locateFrontmatterInner, replaceFieldValue } from "./frontmatterSurgery.js";
import { isOldHashScope, parseSliceDoc, ratifiedHashScope, RatifiedHashScope, sliceDocBodyHash } from "../catalog/sliceDoc.js";
import { QueuedItem } from "../catalog/deferQueue.js";
import { applyDeferOrAppend, drainQueueInState, finishSignedDocEdit, isSignedDoc, readQueue, rewriteParkingLotFragments } from "./defer.js";
import { runSliceSync } from "./sliceSync.js";
import { runSliceIndex } from "./sliceIndex.js";
import { planCollapseAlternativeEvents, planFoldContinuations, planStackContinuations } from "./upgradeReshape.js";
import { observeSigners } from "../roster/init.js";
import { STATE_FILE_NAME } from "./stateFile.js";
import { localIsoDate } from "../util/localDate.js";
import { compile } from "../pipeline.js";
import { computeModelKey } from "../model/qualifiedRef.js";
import { contractPathFor, generateContract } from "./api.js";
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
  /** MIL-269: the packaged `.claude/agents/` root (only the fixed EM_AGENT_FILES are ever read from
   *  it). Defaults to the sibling of `packagedSkillsRoot` (both live under the package's `.claude/`). */
  packagedAgentsRoot?: string;
  model: NormalizedModel;
  refs: RefsResult;
  /** `--fold-continuations`: apply the opt-in `fold-continuations` step (default form: stack). */
  foldContinuations?: boolean;
  /** `--to-sugar` (implies `--fold-continuations`): fold into the host command slice instead. */
  toSugar?: boolean;
}

export interface StepDetection {
  applicable: boolean;
  reason: string;
  /** True when this step's condition was found but can't be applied mechanically — surfaces as
   *  a human-list item instead (currently only `constitution`, when `.specify/` already owns the
   *  slot). `applicable` is always false alongside `human: true` — the two are never both true. */
  human?: boolean;
}

export type StepApplyOutcome = { ok: true; changedFiles: string[]; notes?: string[] } | { ok: false; message: string };

export type UpgradeStepId = "skill-bundle" | "skill-plugin" | "reaction-shape" | "state-file" | "ci-block" | "api-contract-missing" | "constitution" | "ratified-signoff" | "ratified-hash-scope" | "collapse-alternative-events" | "fold-continuations" | "view-doc-sources-stale" | "slice-index-stale" | "parking-lot-fragments" | "system-manifest";

export interface UpgradeStepDef {
  id: UpgradeStepId;
  /** The em release that introduced the feature this step brings a repo up to date with —
   *  informational only (printed alongside the step's own reason), sourced from the actual
   *  release that shipped it, never guessed. */
  sinceVersion: string;
  detect(ctx: UpgradeContext): StepDetection;
  apply(ctx: UpgradeContext): StepApplyOutcome;
  /** Opt-in steps are detected and listed by every run but applied only when this returns true. */
  optedIn?(ctx: UpgradeContext): boolean;
}

// ---- Step 1: skill-bundle — delegates to `em skill sync`'s own plan/apply. ----

function vendoredSkillsRootOf(repoRoot: string): string {
  return join(repoRoot, ".claude", "skills");
}

function vendoredAgentsRootOf(repoRoot: string): string {
  return join(repoRoot, ".claude", "agents");
}

function packagedAgentsRootOf(ctx: UpgradeContext): string {
  return ctx.packagedAgentsRoot ?? join(ctx.packagedSkillsRoot, "..", "agents");
}

function detectSkillBundle(ctx: UpgradeContext): StepDetection {
  const vendoredRoot = vendoredSkillsRootOf(ctx.repoRoot);
  // MIL-231/232: a repo that declares the plugin has no bundle to sync (any stray vendored copy is
  // the `skill-plugin` step's business, not this one's).
  if (detectPlugin(ctx.repoRoot)) return { applicable: false, reason: "plugin repo — nothing to sync" };
  // MIL-232: the vendored bundle is about to be removed by `skill-plugin` (ordered first) — syncing it would be a throwaway commit.
  if (detectSkillPlugin(ctx).applicable) return { applicable: false, reason: "the vendored bundle is migrated to the plugin by skill-plugin — nothing to sync" };
  if (!existsSync(join(vendoredRoot, EM_SKILL_ANCHOR_DIR))) {
    return { applicable: false, reason: "no vendored skill bundle installed at .claude/skills/ — run `em skill install` first if you want one" };
  }
  const bundlePlan = planSkillSyncBundle(ctx.packagedSkillsRoot, vendoredRoot, EM_ALL_SKILL_BUNDLE_DIRS);
  const agentPlan = planAgentSync(packagedAgentsRootOf(ctx), vendoredAgentsRootOf(ctx.repoRoot), EM_AGENT_FILES);
  const totalChanges = bundlePlan.reduce((n, { plan }) => n + plan.changes.length, 0) + agentPlan.changes.length;
  if (totalChanges === 0) return { applicable: false, reason: "vendored skill bundle already matches the installed em" };
  return { applicable: true, reason: `vendored skill bundle differs from the installed em in ${totalChanges} file(s)` };
}

function applySkillBundle(ctx: UpgradeContext): StepApplyOutcome {
  const vendoredRoot = vendoredSkillsRootOf(ctx.repoRoot);
  const bundlePlan = planSkillSyncBundle(ctx.packagedSkillsRoot, vendoredRoot, EM_ALL_SKILL_BUNDLE_DIRS);
  const vendoredAgents = vendoredAgentsRootOf(ctx.repoRoot);
  const agentPlan = planAgentSync(packagedAgentsRootOf(ctx), vendoredAgents, EM_AGENT_FILES);
  const totalChanges = bundlePlan.reduce((n, { plan }) => n + plan.changes.length, 0) + agentPlan.changes.length;
  if (totalChanges === 0) return { ok: false, message: "nothing to sync" };
  applySkillSyncBundle(bundlePlan, ctx.packagedSkillsRoot, vendoredRoot);
  applySkillSync(agentPlan, packagedAgentsRootOf(ctx), vendoredAgents);
  const changedFiles = [
    ...bundlePlan.flatMap(({ dirName, plan }) => plan.changes.map((c) => join(".claude", "skills", dirName, c.relPath))),
    ...agentPlan.changes.map((c) => join(".claude", "agents", c.relPath)),
  ];
  return { ok: true, changedFiles };
}

// ---- Step 1b: skill-plugin (MIL-232, R14) — vendored bundle -> pinned em plugin, one commit. ----

function detectSkillPlugin(ctx: UpgradeContext): StepDetection {
  const vendoredRoot = vendoredSkillsRootOf(ctx.repoRoot);
  if (!existsSync(join(vendoredRoot, EM_SKILL_ANCHOR_DIR))) {
    return { applicable: false, reason: "no vendored skill bundle installed at .claude/skills/ — nothing to migrate to the plugin" };
  }
  if (detectPlugin(ctx.repoRoot)) return { applicable: false, reason: "plugin already declared in .claude/settings.json" };
  const settingsPath = join(ctx.repoRoot, ".claude", "settings.json");
  if (existsSync(settingsPath) && mergePluginSettings(readFileSync(settingsPath, "utf8"), ctx.installedVersion) === null) {
    return { applicable: false, reason: ".claude/settings.json is not a JSON object — fix it by hand, then re-run em upgrade" };
  }
  const e = pluginSettingsEntries(ctx.installedVersion);
  return {
    applicable: true,
    reason:
      `vendored skill bundle → em plugin: remove ${EM_ALL_SKILL_BUNDLE_DIRS.map((d) => `.claude/skills/${d}`).join(", ")} and any of ${EM_AGENT_FILES.map((f) => `.claude/agents/${f}`).join(", ")}; ` +
      `add extraKnownMarketplaces["${e.name}"] (github ${e.marketplace.source.repo}@${e.marketplace.source.ref}) and enabledPlugins["${e.enabledKey}"] to .claude/settings.json; ` +
      `refresh the AGENTS.md managed section with the /em:* skill names`,
  };
}

function applySkillPlugin(ctx: UpgradeContext): StepApplyOutcome {
  const settingsPath = join(ctx.repoRoot, ".claude", "settings.json");
  const existing = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : null;
  // Verify before any write: an unparseable settings.json must not cost the user their skills.
  const merged = mergePluginSettings(existing, ctx.installedVersion);
  if (merged === null) return { ok: false, message: ".claude/settings.json is not a JSON object — nothing changed" };
  const vendoredRoot = vendoredSkillsRootOf(ctx.repoRoot);
  const changedFiles: string[] = [];
  // Only the bundle's own directories; a sibling skill under .claude/skills/ is never touched.
  for (const d of EM_ALL_SKILL_BUNDLE_DIRS) {
    const target = join(vendoredRoot, d);
    if (!existsSync(target)) continue;
    rmSync(target, { recursive: true, force: true });
    changedFiles.push(join(".claude", "skills", d));
  }
  // MIL-269 (R32): exactly the four em agent files (the plugin ships them as em:em-*); any other
  // agent in the shared directory is never listed or touched.
  for (const f of EM_AGENT_FILES) {
    const target = join(vendoredAgentsRootOf(ctx.repoRoot), f);
    if (!existsSync(target)) continue;
    rmSync(target, { force: true });
    changedFiles.push(join(".claude", "agents", f));
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, merged);
  changedFiles.push(join(".claude", "settings.json"));
  const agents = syncAgentsMd(ctx.repoRoot);
  if (agents.wrote) changedFiles.push("AGENTS.md");
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
    ci: [
      buildCiWorkflowFile(args.model, args.testsDir, ctx.installedVersion, findRosterAbove(dirname(resolve(ctx.repoRoot, args.model))) !== null),
      ciManagedBody(args.model, args.testsDir, ctx.installedVersion, findRosterAbove(dirname(resolve(ctx.repoRoot, args.model))) !== null),
    ],
    conform: [buildConformWorkflowFile(args.model, ctx.installedVersion, usePlugin), conformManagedBody(args.model, ctx.installedVersion, usePlugin)],
  };
}

/** Only used for the generated header's wording on a from-scratch file; `ci-block` only ever
 *  patches the managed block of a file that already exists, so this never reaches disk there. */
const SYSTEM_MANIFEST_ARG = "system.yaml";

function ciBlockPlans(ctx: UpgradeContext): { ciPath: string; ciStale: boolean; pathsOnly?: boolean; conformPath: string; conformStale: boolean; args: CiInitArgs | null; blocked?: string } {
  const ciPath = ciWorkflowPath(ctx.repoRoot);
  const conformPath = conformWorkflowPath(ctx.repoRoot);
  if (!existsSync(ciPath)) return { ciPath, ciStale: false, conformPath, conformStale: false, args: null };
  const extracted = extractCiInitArgs(readFileSync(ciPath, "utf8"), ctx.repoRoot);
  if (!extracted.args) return { ciPath, ciStale: false, conformPath, conformStale: false, args: null, blocked: "blocked" in extracted ? extracted.blocked : undefined };
  const args = extracted.args;
  const multi = args.models !== null;
  const files = ciBlockFiles(args, ctx);

  const ciStatus = planCiFile(ciPath, files.ci[0], files.ci[1], CI_WORKFLOW_MARKER, false, multi);
  // GH #346: the `on:` paths live outside the managed block; refresh them when still the pre-1.19 list.
  // A workflow with its markers removed is the documented opt-out and stays untouched, filter included.
  const pathsStale = (ciStatus.kind === "ok" || ciStatus.kind === "stale") && refreshCiPullRequestPaths(readFileSync(ciPath, "utf8")) !== null;
  const ciStale = ciStatus.kind === "stale" || pathsStale;

  let conformStale = false;
  if (existsSync(conformPath)) {
    const conformStatus = planCiFile(conformPath, files.conform[0], files.conform[1], CONFORM_WORKFLOW_MARKER, false, multi);
    conformStale = conformStatus.kind === "stale";
  }
  return { ciPath, ciStale, pathsOnly: pathsStale && ciStatus.kind === "ok", conformPath, conformStale, args };
}

function detectCiBlock(ctx: UpgradeContext): StepDetection {
  const { ciPath, ciStale, pathsOnly, conformStale, args, blocked } = ciBlockPlans(ctx);
  if (!existsSync(ciPath)) return { applicable: false, reason: "no .github/workflows/em-ci.yml — em upgrade never creates one" };
  if (!args && blocked) return { applicable: false, reason: blocked };
  if (!args) return { applicable: false, reason: "can't determine the <model>/--tests arguments em-ci.yml was generated with — run `em ci init <model>` by hand if it needs refreshing" };
  if (!ciStale && !conformStale) return { applicable: false, reason: "generated CI block(s) already match the installed em" };
  if (pathsOnly && !conformStale) return { applicable: true, reason: "em-ci.yml pull_request paths filter is the pre-1.19.0 list" };
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
    applyCiPullRequestPathsRefresh(ciPath);
    changedFiles.push(ciPath);
  }
  if (conformStale) {
    applyCiFile(conformPath, planCiFile(conformPath, files.conform[0], files.conform[1], CONFORM_WORKFLOW_MARKER, false, multi));
    changedFiles.push(conformPath);
  }
  return { ok: true, changedFiles };
}

// ---- Step 4b: api-contract-missing (GH #331) — ci-block regenerates the `api-check` job, whose
// input is `contracts/<model key>.tsp`; nothing else generates that file, so a repo upgraded from
// before 1.12 would have a CI job that fails on every PR. Same detection shape as the roster
// (a CI job whose required input file is absent), but the contract is mechanical, so it is applied
// with `em api generate`'s own generator (generateContract) rather than listed for a human. ----

interface MissingContract { modelFile: string; contractPath: string; modelKey: string }
interface BlockedContract { model: string; why: string }

/** Every model covered by an `api-check` job whose `contracts/<model key>.tsp` is absent. The job
 *  counts when it is in the on-disk em-ci.yml OR when `ci-block` is pending (a stale block is
 *  rewritten to the current preset, which carries `api-check` - so a pre-1.12 workflow is caught by
 *  the dry run, not only after `--apply`). Models that can't be read or compile cleanly are
 *  returned in `blocked` (never skipped silently). */
function contractPlan(ctx: UpgradeContext): { missing: MissingContract[]; blocked: BlockedContract[] } {
  const none = { missing: [], blocked: [] };
  const ciPath = ciWorkflowPath(ctx.repoRoot);
  if (!existsSync(ciPath)) return none;
  const text = readFileSync(ciPath, "utf8");
  const plans = ciBlockPlans(ctx);
  const hasJob = /^ {2}api-check(-[\w-]+)?:/m.test(text) || plans.ciStale;
  if (!hasJob || !plans.args) return none;
  const paths = plans.args.models ? plans.args.models.map((m) => m.path) : [plans.args.model];
  const missing: MissingContract[] = [];
  const blocked: BlockedContract[] = [];
  for (const rel of paths) {
    const modelFile = resolve(ctx.repoRoot, rel);
    let source: string;
    try {
      source = readFileSync(modelFile, "utf8");
    } catch {
      blocked.push({ model: rel, why: "the model file can't be read" });
      continue;
    }
    try {
      const compiled = compile(source);
      if (hasErrors(compiled.diagnostics)) {
        // Only blocked when the contract is actually absent (a model mid-edit that already has one is fine).
        if (!existsSync(contractPathFor(modelFile, computeModelKey(compiled.model, modelFile)))) blocked.push({ model: rel, why: "it has compile errors" });
        continue;
      }
      const g = generateContract(modelFile, source, compiled);
      if (!existsSync(g.contractPath)) missing.push({ modelFile, contractPath: g.contractPath, modelKey: g.modelKey });
    } catch (e) {
      blocked.push({ model: rel, why: `it does not parse (${(e as Error).message})` });
    }
  }
  return { missing, blocked };
}

function blockedText(blocked: BlockedContract[]): string {
  return blocked.map((b) => `${b.model} (${b.why})`).join("; ");
}

function detectApiContractMissing(ctx: UpgradeContext): StepDetection {
  const { missing, blocked } = contractPlan(ctx);
  if (missing.length === 0) {
    if (blocked.length) return { applicable: false, reason: `the api-check contract could not be generated for ${blockedText(blocked)} - see the api-contract-blocked item` };
    return { applicable: false, reason: "no api-check job lacking its contracts/<model key>.tsp" };
  }
  const skipped = blocked.length ? `; not generated for ${blockedText(blocked)} (see the api-contract-blocked item)` : "";
  return {
    applicable: true,
    reason: `the api-check job needs ${missing.map((m) => relative(ctx.repoRoot, m.contractPath)).join(", ")}, which ${missing.length === 1 ? "is" : "are"} missing - em upgrade will run em api generate${skipped}`,
  };
}

function applyApiContractMissing(ctx: UpgradeContext): StepApplyOutcome {
  const { missing } = contractPlan(ctx);
  if (missing.length === 0) return { ok: false, message: "nothing to generate" };
  const changedFiles: string[] = [];
  for (const m of missing) {
    const source = readFileSync(m.modelFile, "utf8");
    const generated = generateContract(m.modelFile, source, compile(source));
    mkdirSync(dirname(generated.contractPath), { recursive: true });
    writeFileSync(generated.contractPath, generated.text);
    changedFiles.push(generated.contractPath);
  }
  return { ok: true, changedFiles };
}

// ---- Step 5: constitution — scaffold a draft when absent and no .specify/ owns the slot. ----

function detectConstitution(ctx: UpgradeContext): StepDetection {
  const existing = locateConstitution(ctx.baseDir);
  if (existing) return { applicable: false, reason: `${existing} already exists` };
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
  if (locateConstitution(ctx.baseDir)) return { ok: false, message: "constitution.md already exists" };
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

export { GRANDFATHERED_RATIFIER };

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

// ---- Step 7: ratified-hash-scope (GH #253, GH #347) — `ratifiedHash` covers the authored text only. ----
// 1.19.0 computes `ratifiedHash` over `ratifiedBody()` (catalog/sliceDoc.ts): the inside of every
// generated region (GH #347) and the `## Open Questions` heading with its `deferred to v<n>` items
// (GH #253, 1.17.0) are outside it, so `em slice sync` and `em slice defer` can write to a ratified
// or shipped doc. A hash recorded by 1.17.0–1.18.x is in the `v1.17` scope (regions inside); one
// recorded before 1.17.0 is in the whole-body `legacy` scope. Readers accept all three
// (`ratifiedHashScope`), so nothing breaks — but an old-scope hash does not survive a region
// rewrite or a deferral until its stamp moves, and GH #236's 1.16 state-file queue may still hold
// questions that now belong in their docs. This step does both, model-wide: re-stamps every intact
// old-scope hash with the current-scope hash of the SAME body (a renormalisation, not a
// re-signing — `ratifiedRef` is untouched and still holds that body), and appends each queued
// question to its doc as the deferred item `defer` would write today, draining the queue bullet.
// A doc whose body no longer matches its hash in any scope is listed and left alone; so is a
// queued question whose doc has already moved past the version it was queued for.

interface HashScopeCandidate {
  key: string;
  path: string;
  version: number | null;
  scope: RatifiedHashScope;
}

function hashScopeCandidates(ctx: UpgradeContext): HashScopeCandidate[] {
  const seen = new Set<string>();
  const out: HashScopeCandidate[] = [];
  for (const d of nonContinuationDocs(ctx)) {
    if (d.ratifiedHash === null || seen.has(d.path)) continue;
    seen.add(d.path);
    const file = join(ctx.baseDir, d.path);
    if (!existsSync(file)) continue;
    out.push({ key: d.key, path: d.path, version: d.version, scope: ratifiedHashScope(readFileSync(file, "utf8"), d.ratifiedHash) });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/** Leftover 1.16 queue bullets aimed at each doc's v<version+1>, with the doc they belong to. */
function queuedLeftovers(ctx: UpgradeContext): Array<{ key: string; path: string; version: number; items: QueuedItem[] }> {
  const out: Array<{ key: string; path: string; version: number; items: QueuedItem[] }> = [];
  const seen = new Set<string>();
  for (const d of nonContinuationDocs(ctx)) {
    if (d.version === null || seen.has(d.path)) continue;
    seen.add(d.path);
    const items = readQueue(ctx.baseDir, d.key, d.version + 1).items;
    if (items.length > 0) out.push({ key: d.key, path: d.path, version: d.version, items });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function detectRatifiedHashScope(ctx: UpgradeContext): StepDetection {
  const candidates = hashScopeCandidates(ctx);
  const v117 = candidates.filter((c) => c.scope === "v1.17");
  const legacy = candidates.filter((c) => c.scope === "legacy");
  const mismatch = candidates.filter((c) => c.scope === "mismatch");
  const queued = queuedLeftovers(ctx);
  const left = mismatch.length > 0 ? `left alone: ${mismatch.map((c) => c.key).join(", ")} — body no longer matches ratifiedHash in any scope (revert, or em slice revise and re-ratify)` : null;
  if (v117.length === 0 && legacy.length === 0 && queued.length === 0) {
    return { applicable: false, reason: `every intact ratifiedHash is in the 1.19 scope and no question is queued in the state file${left ? `; ${left}` : ""}` };
  }
  const restamp = "em upgrade will re-stamp them in the 1.19 scope (authored text only: generated regions and Open Questions deferrals excluded; same body, not a re-signing; ratifiedRef untouched)";
  const parts: string[] = [];
  if (v117.length > 0) parts.push(`${v117.length} doc(s) carry a 1.17–1.18 ratifiedHash (generated regions inside; body intact): ${v117.map((c) => c.key).join(", ")} — ${restamp}`);
  if (legacy.length > 0) parts.push(`${legacy.length} doc(s) carry a pre-1.17 whole-body ratifiedHash (body intact): ${legacy.map((c) => c.key).join(", ")} — ${restamp}`);
  if (queued.length > 0) {
    const n = queued.reduce((s, q) => s + q.items.length, 0);
    parts.push(`${n} question(s) queued in ${STATE_FILE_NAME} by 1.16's em slice defer (GH #236) for ${queued.map((q) => `${q.key}@v${q.version + 1}`).join(", ")} — em upgrade will write each into its doc's Open Questions as a deferred item and drain the queue`);
  }
  if (left) parts.push(left);
  return { applicable: true, reason: parts.join("; ") };
}

function applyRatifiedHashScope(ctx: UpgradeContext): StepApplyOutcome {
  const oldScope = new Set(hashScopeCandidates(ctx).filter((c) => isOldHashScope(c.scope)).map((c) => c.path));
  const queued = queuedLeftovers(ctx);
  const touched = new Map<string, string>(); // abs path -> next content
  const current = (path: string): string => touched.get(path) ?? readFileSync(path, "utf8");
  // Queue first, on the doc as read: `finishSignedDocEdit` re-stamps an old-scope hash itself.
  for (const q of queued) {
    const file = join(ctx.baseDir, q.path);
    let content = current(file);
    const before = content;
    for (const item of q.items) {
      const r = applyDeferOrAppend(content, item.question, {
        until: `v${item.until}`,
        decision: item.decision,
        ...(item.by !== undefined ? { by: item.by } : {}),
        on: item.on,
        currentVersion: q.version,
      });
      if (!r.ok) return { ok: false, message: `${q.path}: queued question "${item.question}" — ${r.message}` };
      content = r.content;
    }
    if (isSignedDoc(before)) {
      const finished = finishSignedDocEdit(before, content);
      if (!finished.ok) return { ok: false, message: `${q.path}: ${finished.message}` };
      content = finished.content;
    }
    touched.set(file, content);
    oldScope.delete(q.path);
  }
  for (const path of oldScope) {
    const file = join(ctx.baseDir, path);
    const raw = current(file);
    const next = replaceFieldValue(raw, "ratifiedHash", sliceDocBodyHash(raw));
    if (next === null) return { ok: false, message: `${path}: could not locate ratifiedHash: in the frontmatter` };
    touched.set(file, next);
  }
  // Verify before write: every touched doc must now match its hash in the current scope.
  for (const [file, content] of touched) {
    const m = fieldLineRegex("ratifiedHash").exec(content);
    const recorded = m ? normalizeFieldValue(m[2]) : null;
    if (recorded !== null && ratifiedHashScope(content, recorded) !== "current") {
      return { ok: false, message: `${relative(ctx.baseDir, file)}: the rewrite would not match ratifiedHash — aborting, nothing written` };
    }
  }
  for (const [file, content] of touched) writeFileSync(file, content, "utf8");
  const changedFiles = [...touched.keys()];
  if (queued.length > 0) {
    const statePath = join(ctx.baseDir, STATE_FILE_NAME);
    let state = readFileSync(statePath, "utf8");
    for (const q of queued) state = drainQueueInState(state, q.key, q.version + 1).content;
    writeFileSync(statePath, state, "utf8");
    changedFiles.push(statePath);
  }
  return { ok: true, changedFiles };
}

// ---- Step 8-: collapse-alternative-events (GH #290 / #278) and fold-continuations (GH #290 / #287) ----
// The two steps that rewrite the `.em` itself (planned by upgradeReshape.ts: text surgery, verified by
// recompiling before anything is written). They run before the doc/index steps, which re-read the
// model `applyUpgrade` recompiles after each step. `fold-continuations` is OPT-IN (see below).

function readModelText(ctx: UpgradeContext): string {
  return readFileSync(ctx.modelFile, "utf8");
}

function freshCompile(ctx: UpgradeContext): { model: NormalizedModel; refs: RefsResult } | null {
  try {
    const c = compile(readModelText(ctx));
    return { model: c.model, refs: c.refs };
  } catch {
    return null;
  }
}

/** Signed docs (ratified or shipped) whose generated regions would be stale against `nextText`, i.e. that
 *  a rewrite leaves behind a signature the regions no longer match. Read-only. */
function signedDocsStaleAfter(ctx: UpgradeContext, nextText: string): string[] {
  const staleSigned = (src: string): Map<string, string> => {
    const out = new Map<string, string>();
    let c;
    try {
      c = compile(src);
    } catch {
      return out;
    }
    const r = runSliceSync(c.model, c.refs, ctx.baseDir, undefined, true);
    if (!r.ok) return out;
    for (const d of r.docs) {
      if (d.status === "stale" && isSignedDoc(readFileSync(join(ctx.baseDir, d.path), "utf8"))) {
        out.set(d.path, `${d.path} (${d.regions.filter((g) => g.status === "stale").map((g) => g.name).join(", ")})`);
      }
    }
    return out;
  };
  const before = staleSigned(readModelText(ctx));
  return [...staleSigned(nextText)].filter(([path]) => !before.has(path)).map(([, label]) => label); // newly stale only
}

const CARRIED_SECTIONS = /^##\s+(Scenarios|Invariants|Open Questions|Decisions(?: log)?)\s*$/i;

/** Sections of a retiring doc whose AUTHORED content a human must carry to the kept doc (generated
 *  regions are rebuilt from the model, so they are not content). */
function carriedSections(raw: string): string[] {
  const body = raw.replace(/<!-- GENERATED:[^>]*:start[^>]*-->[\s\S]*?<!-- GENERATED:[^>]*:end -->/g, "");
  const lines = body.split("\n");
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CARRIED_SECTIONS.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    let content = false;
    for (; j < lines.length && !/^#{1,2}\s/.test(lines[j]); j++) if (lines[j].trim() !== "" && !lines[j].includes("{{")) content = true;
    if (content) found.push(m[1]);
  }
  return found;
}

/** Where a collapsed slice's retired doc goes: beside the model, outside `slices/` (so it is not an
 *  orphaned slice doc), keeping its file name. */
const ARCHIVE_DIR = join("archive", "slices");

interface RetiredDoc {
  from: string;
  to: string;
  key: string;
  keptKey: string;
  /** The doc the kept slice binds (cross-binding aware), and its version — null when it has none. */
  keptDoc: string | null;
  keptVersion: number | null;
  retiredVersion: number;
  text: string;
  carried: string[];
}

function retiredDocs(ctx: UpgradeContext, groups: Array<{ keys: string[] }>): RetiredDoc[] {
  const out: RetiredDoc[] = [];
  const refOf = elementRefOf(ctx);
  const joinOf = (key: string) => {
    const i = ctx.refs.sliceKeys.indexOf(key);
    return i === -1 ? null : resolveSliceDocJoin(ctx.model, ctx.refs, ctx.model.slices[i], key, ctx.baseDir, refOf).doc;
  };
  for (const g of groups) {
    const kept = joinOf(g.keys[0]);
    const keptDoc = kept && kept.found && kept.reason === null ? kept.path : null;
    const keptVersion = kept && keptDoc ? kept.version : null;
    for (const key of g.keys.slice(1)) {
      const bound = joinOf(key);
      const rel = bound && bound.found && bound.reason === null ? bound.path : `slices/${key}.md`;
      const from = join(ctx.baseDir, rel);
      if (!existsSync(from) || (keptDoc !== null && rel === keptDoc)) continue;
      const raw = readFileSync(from, "utf8");
      const range = locateFrontmatterInner(raw);
      const retiredVersion = Number(/^version:\s*(\d+)/m.exec(raw)?.[1] ?? "1");
      const target = keptDoc !== null ? basename(keptDoc, ".md") : g.keys[0];
      let next = raw;
      if (range) {
        const fenceEnd = raw.indexOf("\n", range.innerEnd) + 1 || raw.length;
        const banner = `\n> **SUPERSEDED** by \`${target}\` (\`superseded-by\`): this slice was collapsed into one recording alternative events (GH #278). Kept for history; fold anything worth keeping into \`${keptDoc ?? `slices/${g.keys[0]}.md`}\`.\n`;
        next = raw.slice(0, range.innerEnd) + `superseded-by: ${target}@v${keptVersion ?? 1}\n` + raw.slice(range.innerEnd, fenceEnd) + banner + raw.slice(fenceEnd);
      }
      out.push({ from, to: join(ctx.baseDir, ARCHIVE_DIR, basename(rel)), key, keptKey: g.keys[0], keptDoc, keptVersion, retiredVersion, text: next, carried: carriedSections(raw) });
    }
  }
  return out;
}

function carriedNotes(retired: RetiredDoc[]): string[] {
  return retired.filter((r) => r.carried.length > 0).map((r) => `${ARCHIVE_DIR}/${basename(r.to)} holds ${r.carried.join(", ")} — fold these into ${r.keptDoc ?? `slices/${r.keptKey}.md`}`);
}

/** GH #374: a rewrite keeps the comment directly above a moved line; any other comment in a slice it
 *  drops is lost, so the reason names each one — the dry run says it and the apply reason repeats it. */
function droppedCommentsNote(dropped: Array<{ key: string; lines: string[] }>, anchor: string): string {
  if (dropped.length === 0) return "";
  const each = dropped.map((d) => `${d.lines.length} in ${d.key} (${d.lines.map((l) => `\`${l}\``).join(", ")})`);
  return `; comment line(s) not directly above ${anchor} are DROPPED by the rewrite: ${each.join("; ")} — move them by hand first`;
}

function detectCollapseAlternativeEvents(ctx: UpgradeContext): StepDetection {
  const fresh = freshCompile(ctx);
  const plan = fresh ? planCollapseAlternativeEvents(fresh.model, fresh.refs, readModelText(ctx)) : null;
  if (plan === null) return { applicable: false, reason: "no run of adjacent slices repeats one command and differs only in the recorded event" };
  const desc = plan.groups.map((g) => `${g.slices.map((n) => `"${n}"`).join(" + ")} → "${g.slices[0]}" recording ${g.form === "inline" ? g.events.join(" | ") : `oneof { ${g.events.join(", ")} }`}`);
  const retired = retiredDocs(ctx, plan.groups);
  const notes = carriedNotes(retired);
  const stale = signedDocsStaleAfter(ctx, plan.next);
  return {
    applicable: true,
    reason:
      `${plan.groups.length} run(s) of repeated-command slices collapse to alternative events: ${desc.join("; ")} — em upgrade will rewrite them (the first slice's key is kept; the others' docs move to ${ARCHIVE_DIR}/ with superseded-by and a SUPERSEDED banner, and the kept doc gains merged-from)` +
      (notes.length > 0 ? `; ${notes.join("; ")}` : "") +
      droppedCommentsNote(plan.droppedComments, "a merged slice's event") +
      (stale.length > 0 ? `; signed doc(s) whose generated regions go stale: ${stale.join(", ")} — em upgrade syncs the kept slice's doc, run em slice sync for any other (since 1.19.0 sync keeps the signature: ratifiedHash covers the authored text only)` : ""),
  };
}

/** Frontmatter-only edit: adds `key: value` before the closing fence (a no-op without frontmatter). */
function addFrontmatterLine(raw: string, line: string): string {
  const range = locateFrontmatterInner(raw);
  return range ? raw.slice(0, range.innerEnd) + line + "\n" + raw.slice(range.innerEnd) : raw;
}

function applyCollapseAlternativeEvents(ctx: UpgradeContext): StepApplyOutcome {
  const fresh = freshCompile(ctx);
  const text = readModelText(ctx);
  const plan = fresh ? planCollapseAlternativeEvents(fresh.model, fresh.refs, text) : null;
  if (plan === null) return { ok: false, message: "the model no longer collapses cleanly" };
  const changed = [ctx.modelFile];
  const retired = retiredDocs(ctx, plan.groups); // computed on the OLD model (joins, versions)
  const notes = carriedNotes(retired);
  writeFileSync(ctx.modelFile, plan.next, "utf8");
  for (const r of retired) {
    mkdirSync(dirname(r.to), { recursive: true });
    writeFileSync(r.to, r.text, "utf8");
    rmSync(r.from);
    changed.push(r.from, r.to);
  }
  // Lineage back-link on the kept doc: `merged-from: <retired>@v<N>` (frontmatter only, outside the
  // ratified hash). A SIGNED kept doc is not touched; `lineage-backlink-missing` lists it.
  for (const r of retired) {
    if (r.keptDoc === null) continue;
    const abs = join(ctx.baseDir, r.keptDoc);
    const raw = readFileSync(abs, "utf8");
    if (isSignedDoc(raw)) continue;
    const ref = `${basename(r.to, ".md")}@v${r.retiredVersion}`;
    const existing = /^merged-from:\s*(.*)$/m.exec(raw);
    const next = existing ? raw.replace(/^merged-from:\s*(.*)$/m, (_m, v) => `merged-from: ${String(v).trim() === "" ? ref : `${String(v).trim()}, ${ref}`}`) : addFrontmatterLine(raw, `merged-from: ${ref}`);
    writeFileSync(abs, next, "utf8");
    if (!changed.includes(abs)) changed.push(abs);
  }
  // Regenerate the kept slice's event region (one `Records one of:` region now). A signed doc is synced
  // too and keeps its signature (GH #347: ratifiedHash covers the authored text only).
  const after = freshCompile(ctx);
  if (after) {
    for (const g of plan.groups) {
      const kept = retired.find((r) => r.keptKey === g.keys[0])?.keptDoc ?? `slices/${g.keys[0]}.md`;
      const doc = join(ctx.baseDir, kept);
      if (existsSync(doc)) {
        const r = runSliceSync(after.model, after.refs, ctx.baseDir, g.keys[0], false);
        const bad = r.ok ? r.docs.find((d) => d.status === "malformed") : undefined;
        if (bad) return { ok: false, message: `${bad.path}: em slice sync could not rewrite it — ${bad.problems.join("; ")}` };
        if (r.ok && r.docs.some((d) => d.status === "synced") && !changed.includes(doc)) changed.push(doc);
      }
    }
  }
  return { ok: true, changedFiles: changed, notes };
}

// ---- fold-continuations is OPT-IN (`em upgrade --apply --fold-continuations`) ----
// Default form (a): consecutive continuations of ONE view stack into the first slice (its key, name,
// `continuationOf`, doc join and index row stay). `--to-sugar` instead moves them into the host
// command slice as `view X again … shown on` lines; that CHANGES `continuationOf` and the doc join to
// the host (`<host>--again`) and removes the index rows.

const FOLD_FLAG = "em upgrade --apply --fold-continuations";

function foldPlan(ctx: UpgradeContext): { kind: "stack"; plan: ReturnType<typeof planStackContinuations> } | { kind: "sugar"; plan: ReturnType<typeof planFoldContinuations> } {
  const fresh = freshCompile(ctx);
  if (!fresh) return { kind: "stack", plan: null };
  const text = readModelText(ctx);
  return ctx.toSugar === true
    ? { kind: "sugar", plan: planFoldContinuations(fresh.model, fresh.refs, text) }
    : { kind: "stack", plan: planStackContinuations(fresh.model, fresh.refs, text) };
}

function detectFoldContinuations(ctx: UpgradeContext): StepDetection {
  const f = foldPlan(ctx);
  if (f.plan === null) return { applicable: false, reason: "no consecutive hand-named continuation slices of one view (stack) — or, with --to-sugar, no continuation directly after its host command — in a foldable shape" };
  if (f.kind === "sugar" && (f.plan as NonNullable<ReturnType<typeof planFoldContinuations>>).groups.length === 0) {
    const r = (f.plan as NonNullable<ReturnType<typeof planFoldContinuations>>).refused;
    return { applicable: false, reason: `--to-sugar: nothing folded; refused: ${r.map((x) => `${x.hostKey} (${x.reason})`).join("; ")}` };
  }
  const optIn = ctx.foldContinuations === true || ctx.toSugar === true;
  const prefix = optIn ? "" : `OPT-IN, not applied by a plain --apply (run \`${FOLD_FLAG}\`): `;
  const stale = signedDocsStaleAfter(ctx, f.plan.next);
  const staleNote = stale.length > 0 ? `; signed doc(s) whose generated regions (e.g. the view's \`via\` annotations) go stale: ${stale.join(", ")} — run em slice sync afterwards (since 1.19.0 it keeps the signature: ratifiedHash covers the authored text only)` : "";
  if (f.kind === "stack") {
    const p = f.plan as NonNullable<ReturnType<typeof planStackContinuations>>;
    const desc = p.groups.map((g) => `${[g.kept, ...g.dropped].map((n) => `"${n}"`).join(" + ")} → one continuation slice "${g.kept}" (key ${g.keptKey} kept; dropped keys: ${g.droppedKeys.join(", ")})`);
    const skipped = p.skipped.length > 0 ? `; left unstacked: ${p.skipped.map((s) => `${s.key} (${s.reason})`).join(", ")}` : "";
    const dropped = droppedCommentsNote(p.droppedComments, "a moved `view … again` line");
    return { applicable: true, reason: `${prefix}${desc.join("; ")} — continuationOf, the doc join and the kept key's index row are unchanged${skipped}${dropped}${staleNote}` };
  }
  const p = f.plan as NonNullable<ReturnType<typeof planFoldContinuations>>;
  const desc = p.groups.map((g) => `${g.folded.map((n) => `"${n}"`).join(" + ")} (keys ${g.foldedKeys.join(", ")}) → \`view … again\` lines in "${g.host}" (column ${g.hostKey}--again)`);
  const refusedNote = p.refused.length > 0 ? `; refused: ${p.refused.map((x) => `${x.hostKey} (${x.reason})`).join("; ")}` : "";
  const dropped = droppedCommentsNote(p.droppedComments, "a moved `view … again` line");
  return { applicable: true, reason: `${prefix}--to-sugar: ${desc.join("; ")}${refusedNote}${dropped} — CHANGES continuationOf and the doc join to the host (${p.groups.map((g) => `${g.hostKey}--again`).join(", ")}) and removes the index rows of ${p.groups.flatMap((g) => g.foldedKeys).join(", ")} (a stray own doc of a folded slice is left alone)${staleNote}` };
}

function applyFoldContinuations(ctx: UpgradeContext): StepApplyOutcome {
  const f = foldPlan(ctx);
  if (f.plan === null || ("groups" in f.plan && f.plan.groups.length === 0)) return { ok: false, message: "the model no longer folds cleanly" };
  writeFileSync(ctx.modelFile, f.plan.next, "utf8");
  return { ok: true, changedFiles: [ctx.modelFile] };
}

// ---- Step 8a: view-doc-sources-stale (GH #290 / #280) — view regions list the union of `from`. ----
// 1.18.0's generated `em-slice-view` region lists the UNION of `from` across a read model's `again`
// instances (GH #280), so a doc generated under 1.17 states an origin-only "built from" line. This
// step is `em slice sync`'s own check/apply, narrowed to docs whose VIEW region is stale. Since
// 1.19.0 a SIGNED doc (ratified or shipped) is synced too and keeps its signature (GH #347:
// `ratifiedHash` covers the authored text only; `em slice sync` re-stamps an intact old-scope hash
// in the same write).

type StaleDoc = { key: string; path: string };

function staleViewDocs(ctx: UpgradeContext): StaleDoc[] {
  const out: StaleDoc[] = [];
  const r = runSliceSync(ctx.model, ctx.refs, ctx.baseDir, undefined, true);
  if (!r.ok) return out;
  for (const d of r.docs) {
    if (d.status !== "stale" || !hasStaleViewRegion(d)) continue;
    out.push({ key: d.key, path: d.path });
  }
  return out;
}

function hasStaleViewRegion(d: { regions: Array<{ name: string; status: string }> }): boolean {
  return d.regions.some((g) => g.status === "stale" && g.name.startsWith("em-slice-view"));
}

function detectViewDocSourcesStale(ctx: UpgradeContext): StepDetection {
  const open = staleViewDocs(ctx);
  if (open.length === 0) {
    return { applicable: false, reason: "no bound slice doc's view region is stale against the model" };
  }
  return {
    applicable: true,
    reason: `em slice sync --check would change the view region of ${open.length} doc(s): ${open.map((d) => d.path).join(", ")} — em upgrade will run em slice sync on them (a ratified or shipped doc keeps its signature)`,
  };
}

function applyViewDocSourcesStale(ctx: UpgradeContext): StepApplyOutcome {
  const open = staleViewDocs(ctx);
  const changedFiles: string[] = [];
  for (const d of open) {
    const r = runSliceSync(ctx.model, ctx.refs, ctx.baseDir, d.key, false);
    if (!r.ok) return { ok: false, message: r.message };
    const bad = r.docs.find((x) => x.status === "malformed");
    if (bad) return { ok: false, message: `${bad.path}: em slice sync could not rewrite it — ${bad.problems.join("; ")}` };
    changedFiles.push(join(ctx.baseDir, d.path));
  }
  return { ok: true, changedFiles };
}

// ---- Step 8b: slice-index-stale (GH #290 / #275) — the README Slices table. ----

function detectSliceIndexStale(ctx: UpgradeContext): StepDetection {
  const r = runSliceIndex(ctx.model, ctx.refs, ctx.modelFile, true);
  if (r.ok) return { applicable: false, reason: "the README Slices table is current" };
  if (r.kind === "stale") return { applicable: true, reason: `${join(ctx.baseDir, "README.md")}'s Slices table is stale (em slice index --check) — em upgrade will regenerate it` };
  return { applicable: false, reason: r.kind === "missing-readme" ? "no README.md beside the model — nothing to index" : "README.md has no GENERATED:slices markers — nothing to index" };
}

function applySliceIndexStale(ctx: UpgradeContext): StepApplyOutcome {
  const r = runSliceIndex(ctx.model, ctx.refs, ctx.modelFile, false);
  if (!r.ok) return { ok: false, message: r.message };
  return { ok: true, changedFiles: r.wrote ? [r.readmePath] : [] };
}

// ---- Step 8c: parking-lot-fragments (GH #290 / #283) — substring bullets become the item's label. ----

function parkingLotDocs(ctx: UpgradeContext): Map<string, string> {
  const docs = new Map<string, string>();
  for (const d of nonContinuationDocs(ctx)) {
    const file = join(ctx.baseDir, d.path);
    if (d.path !== "" && existsSync(file)) docs.set(d.key, readFileSync(file, "utf8"));
  }
  return docs;
}

function detectParkingLotFragments(ctx: UpgradeContext): StepDetection {
  const statePath = join(ctx.baseDir, STATE_FILE_NAME);
  if (!existsSync(statePath)) return { applicable: false, reason: `no ${STATE_FILE_NAME} beside the model` };
  const { rewrites } = rewriteParkingLotFragments(readFileSync(statePath, "utf8"), parkingLotDocs(ctx));
  if (rewrites.length === 0) return { applicable: false, reason: "no parking-lot bullet is a fragment of an Open Questions item" };
  return {
    applicable: true,
    reason: `${rewrites.length} parking-lot bullet(s) hold a fragment of an Open Questions item (the pre-1.18 em slice defer shape): ${rewrites.map((r) => `"${r.from}" → "${r.to}"`).join("; ")} — em upgrade will rewrite each to the item's label`,
  };
}

function applyParkingLotFragments(ctx: UpgradeContext): StepApplyOutcome {
  const statePath = join(ctx.baseDir, STATE_FILE_NAME);
  const { content } = rewriteParkingLotFragments(readFileSync(statePath, "utf8"), parkingLotDocs(ctx));
  writeFileSync(statePath, content, "utf8");
  return { ok: true, changedFiles: [statePath] };
}

// ---- Step 8: system-manifest (MIL-235, R3) — system.yaml 1.0 -> 2.0. ----
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
  { id: "skill-plugin", sinceVersion: "1.14.0", detect: detectSkillPlugin, apply: applySkillPlugin },
  { id: "skill-bundle", sinceVersion: "1.7.0", detect: detectSkillBundle, apply: applySkillBundle },
  { id: "reaction-shape", sinceVersion: "1.8.0", detect: detectReactionShape, apply: applyReactionShape },
  { id: "state-file", sinceVersion: "1.13.0", detect: detectStateFile, apply: applyStateFile },
  { id: "ci-block", sinceVersion: "1.9.0", detect: detectCiBlock, apply: applyCiBlock },
  { id: "api-contract-missing", sinceVersion: "1.18.1", detect: detectApiContractMissing, apply: applyApiContractMissing },
  { id: "constitution", sinceVersion: "1.11.0", detect: detectConstitution, apply: applyConstitution },
  { id: "ratified-signoff", sinceVersion: "1.14.0", detect: detectRatifiedSignoff, apply: applyRatifiedSignoff },
  { id: "ratified-hash-scope", sinceVersion: "1.19.0", detect: detectRatifiedHashScope, apply: applyRatifiedHashScope },
  { id: "collapse-alternative-events", sinceVersion: "1.18.0", detect: detectCollapseAlternativeEvents, apply: applyCollapseAlternativeEvents },
  { id: "fold-continuations", sinceVersion: "1.18.0", detect: detectFoldContinuations, apply: applyFoldContinuations, optedIn: (c) => c.foldContinuations === true || c.toSugar === true },
  { id: "view-doc-sources-stale", sinceVersion: "1.18.0", detect: detectViewDocSourcesStale, apply: applyViewDocSourcesStale },
  { id: "slice-index-stale", sinceVersion: "1.18.0", detect: detectSliceIndexStale, apply: applySliceIndexStale },
  { id: "parking-lot-fragments", sinceVersion: "1.18.0", detect: detectParkingLotFragments, apply: applyParkingLotFragments },
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
  | "public-field-types-unresolved"
  | "plugin-install-locally"
  | "slice-doc-stale-signed"
  | "lineage-backlink-missing"
  | "fold-continuations-opt-in"
  | "shared-event-now-legal"
  | "roster-not-initialised"
  | "api-contract-blocked"
  | "ci-paths-hand-edited";

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
  const results: Array<{ key: string; status: string | null; shipped: boolean; ratifiedBy: string | null; ratifiedHash: string | null; version: number | null; path: string }> = [];
  ctx.model.slices.forEach((slice, i) => {
    const key = ctx.refs.sliceKeys[i];
    const { doc, continuationOf } = resolveSliceDocJoin(ctx.model, ctx.refs, slice, key, ctx.baseDir, elementRefOf(ctx));
    if (continuationOf !== null) return;
    results.push({ key, status: doc.status, shipped: doc.shipped !== null, ratifiedBy: doc.ratifiedBy, ratifiedHash: doc.ratifiedHash, version: doc.version, path: doc.path });
  });
  return results;
}

function detectNoModelVersion(ctx: UpgradeContext): HumanItem | null {
  const loaded = loadStateFile(ctx.baseDir);
  if (!loaded.ok) return null;
  const parsed = parseState(loaded.text);
  if (!parsed.ok || parsed.state.modelVersion !== null) return null;
  const hasImplemented = nonContinuationDocs(ctx).some((d) => d.shipped); // MIL-283: the shipped record, not the working status
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
  // MIL-283: since 1.15.0 an unsigned `ready-to-implement` is a state no command produces (the
  // next version opens as `draft`) and `em slice ratify` no longer accepts it — the exit is
  // `em slice revise`, which reopens the doc as a draft at the same version.
  return {
    id: "ready-to-implement-no-ratifiedby",
    reason: `${keys.length} ready-to-implement doc(s) with no ratifiedBy (version > 1 — a pre-1.15 reratify left them unsigned): ${keys.join(", ")} — run \`em slice revise\` on each (reopens it as a draft at the same version), then review and \`em slice ratify --by <name>\``,
  };
}

function detectCoverageScopeDefault(ctx: UpgradeContext): HumanItem | null {
  const ciPath = ciWorkflowPath(ctx.repoRoot);
  if (!existsSync(ciPath)) return null;
  const content = readFileSync(ciPath, "utf8");
  if (!/\bcoverage\b[^\n]*--strict\b/.test(content)) return null;
  const anyImplemented = nonContinuationDocs(ctx).some((d) => d.shipped); // MIL-283
  if (anyImplemented) return null;
  return {
    id: "coverage-scope-default",
    reason: "em-ci.yml runs `em coverage --strict`, but no slice doc is status: implemented yet (MIL-207 scopes --strict to implemented docs only) — the gate is trivially green until the first slice is marked implemented",
  };
}

function detectUnratifiedConstitution(ctx: UpgradeContext): HumanItem | null {
  const path = locateConstitution(ctx.baseDir);
  if (!path) return null;
  const content = readFileSync(path, "utf8");
  // spec-kit's own sign-off is a `**Ratified**: <date>` footer line (MIL-287): either form counts.
  if (/^\*\*Ratified\*\*:\s*\S/m.test(content)) return null;
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

/** MIL-232: the machine-level plugin registration is per user and cannot be done by `em upgrade`.
 *  Fires when the `skill-plugin` step is pending (it will declare the plugin), or when the repo
 *  declares the plugin at the installed version but the machine registry lacks it. */
function detectPluginInstallLocally(ctx: UpgradeContext): HumanItem | null {
  const commands = pluginInstallCommands(ctx.installedVersion);
  const snippet = `run \`${commands.join(" && ")}\` on each developer machine and in CI (the generated em-ci.yml does it)`;
  if (detectSkillPlugin(ctx).applicable) {
    return { id: "plugin-install-locally", reason: `the em plugin will be declared in .claude/settings.json but is registered per machine — after --apply, ${snippet}` };
  }
  const check = checkPlugin(ctx.repoRoot, ctx.installedVersion, claudePluginsDir());
  if (check && check.findings.some((f) => f.code === "plugin-not-installed-locally")) {
    return { id: "plugin-install-locally", reason: `the em plugin is declared but not registered on this machine — ${snippet}` };
  }
  return null;
}

/** GH #290 / GH #347: a SIGNED doc (ratified or shipped) whose generated regions are stale against the
 *  model and that no step syncs (`view-doc-sources-stale` syncs a doc with a stale view region, signed or
 *  not). Since 1.19.0 the fix is mechanical — `em slice sync` keeps the signature, because
 *  `ratifiedHash` covers the authored text only; model-change discipline is the model's own pin
 *  (`model-versions/v<N>.json`). Raised for the event, command and invariants regions. */
function detectSliceDocStaleSigned(ctx: UpgradeContext): HumanItem | null {
  const r = runSliceSync(ctx.model, ctx.refs, ctx.baseDir, undefined, true);
  if (!r.ok) return null;
  // A doc with a stale view region is `view-doc-sources-stale`'s — unless sync could not rewrite it
  // (`signatureRefused`), in which case that step fails on it and the human item must still name it.
  const docs = r.docs.filter(
    (d) => d.status === "stale" && (!hasStaleViewRegion(d) || d.signatureRefused !== undefined) && isSignedDoc(readFileSync(join(ctx.baseDir, d.path), "utf8")),
  );
  if (docs.length === 0) return null;
  return {
    id: "slice-doc-stale-signed",
    reason: `${docs.map((d) => `${d.path} (${d.regions.filter((g) => g.status === "stale").map((g) => g.name).join(", ")})`).join("; ")} — ratified or shipped and stale against the model; run \`em slice sync ${basename(ctx.modelFile)}\` (it rewrites the generated regions and keeps the signature: ratifiedHash covers the authored text only)`,
  };
}

/** GH #290 / #278: a retired doc under archive/slices/ names its successor in `superseded-by`, but the
 *  successor (a signed doc `em upgrade` did not touch) lacks the `merged-from` back-link. */
function detectLineageBacklinkMissing(ctx: UpgradeContext): HumanItem | null {
  const dir = join(ctx.baseDir, ARCHIVE_DIR);
  if (!existsSync(dir)) return null;
  const missing: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
    const retired = parseSliceDoc(readFileSync(join(dir, f), "utf8"));
    for (const ref of retired.supersededBy) {
      if (!ref.sliceKey) continue;
      const target = join(ctx.baseDir, "slices", `${ref.sliceKey}.md`);
      if (!existsSync(target)) continue;
      const doc = parseSliceDoc(readFileSync(target, "utf8"));
      const key = basename(f, ".md");
      if (!doc.mergedFrom.some((m) => m.sliceKey === key)) missing.push(`slices/${ref.sliceKey}.md needs merged-from: ${key}@v${retired.version ?? 1}`);
    }
  }
  if (missing.length === 0) return null;
  return { id: "lineage-backlink-missing", reason: `${missing.join("; ")} (the doc is signed or was edited since; add the line to its frontmatter — it is outside the ratified hash)` };
}

/** GH #290 / #287: `fold-continuations` is detected and listed by every run but needs the flag. */
function detectFoldContinuationsOptIn(ctx: UpgradeContext): HumanItem | null {
  if (ctx.foldContinuations === true || ctx.toSugar === true) return null;
  const d = detectFoldContinuations(ctx);
  return d.applicable ? { id: "fold-continuations-opt-in", reason: d.reason } : null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** The version the repo is upgrading FROM (recorded `Em version:` bullet, else inferred). */
function recordedFromVersion(ctx: UpgradeContext): string {
  const loaded = loadStateFile(ctx.baseDir);
  let recorded: string | null = null;
  if (loaded.ok) {
    const parsed = parseState(loaded.text);
    if (parsed.ok) recorded = parsed.state.emVersion;
  }
  return resolveFromVersion(ctx, recorded).version;
}

/** GH #290 / #259: signatures are a human decision, so the roster is never generated silently. */
function detectRosterNotInitialised(ctx: UpgradeContext): HumanItem | null {
  if (findRosterAbove(ctx.baseDir) !== null) return null;
  const { ratifiers } = observeSigners(ctx.model, ctx.refs, ctx.baseDir);
  if (ratifiers.length === 0) return null;
  return {
    id: "roster-not-initialised",
    reason: `${ratifiers.length} ratifier(s) have signed slice docs (${ratifiers.join(", ")}) and there is no ratifiers.yaml — decide who may sign, then run \`em roster init ${basename(ctx.modelFile)}\` to seed one from those names and review it before committing`,
  };
}


/** GH #290 / #279: information only. Since 1.18.0 the same event recorded by several commands (same
 *  name and context) is one logical event and `duplicate-name` no longer fires; nothing to change. */
function detectSharedEventNowLegal(ctx: UpgradeContext): HumanItem | null {
  // The transition only: a repo already stamped 1.18.0+ has seen this note.
  if (compareVersions(recordedFromVersion(ctx), "1.18.0") >= 0) return null;
  const shared = new Set<string>();
  for (const el of ctx.model.elements) if (el.kind === "event" && el.logicalId !== el.id) shared.add(el.name);
  if (shared.size === 0) return null;
  return {
    id: "shared-event-now-legal",
    reason: `information only: ${[...shared].join(", ")} ${shared.size === 1 ? "is" : "are"} recorded by more than one command — legal since 1.18.0 (one logical event; duplicate-name no longer fires), no model change needed`,
  };
}

/** GH #331: the api-check job needs a contract the mechanical step could not generate. */
function detectApiContractBlocked(ctx: UpgradeContext): HumanItem | null {
  const { blocked } = contractPlan(ctx);
  if (blocked.length === 0) return null;
  return {
    id: "api-contract-blocked",
    reason: `the contract could not be generated for ${blockedText(blocked)}, so the api-check job will fail until it exists - run \`em validate <model>\` to see why, fix it, then \`em api generate <model>\``,
  };
}

/** GH #346: a hand-edited `pull_request.paths` filter that lacks entries of the current preset is
 *  left alone, but the owner should know why upgrade PRs may get no CI run. */
function detectCiPathsHandEdited(ctx: UpgradeContext): HumanItem | null {
  const ciPath = ciWorkflowPath(ctx.repoRoot);
  if (!existsSync(ciPath)) return null;
  const content = readFileSync(ciPath, "utf8");
  if (refreshCiPullRequestPaths(content) !== null) return null;
  const missing = missingCiPullRequestPaths(content);
  if (!missing || missing.length === 0) return null;
  return {
    id: "ci-paths-hand-edited",
    reason: `em-ci.yml's hand-edited pull_request paths filter lacks ${missing.map((p) => `"${p}"`).join(", ")}, so a PR touching only those files (an \`em upgrade\` PR, for one) runs no CI; em leaves a hand-edited filter alone - add them if you want those PRs checked`,
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
  detectPluginInstallLocally,
  detectSliceDocStaleSigned,
  detectLineageBacklinkMissing,
  detectFoldContinuationsOptIn,
  detectSharedEventNowLegal,
  detectRosterNotInitialised,
  detectApiContractBlocked,
  detectCiPathsHandEdited,
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
  /** Present (true) for an opt-in step that is detected but not opted into by this run's flags: listed, never applied. */
  optIn?: boolean;
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
    const optIn = s.optedIn !== undefined && !s.optedIn(ctx) && d.applicable;
    return { id: s.id, sinceVersion: s.sinceVersion, applicable: d.applicable, human: d.human === true, reason: d.reason, ...(optIn ? { optIn: true } : {}) };
  });
  const human = detectHumanItems(ctx);

  return { from, to: ctx.installedVersion, steps, human, stateFileError };
}

export interface ApplyStepResult {
  id: UpgradeStepId;
  applied: boolean;
  changedFiles: string[];
  commit: string | null;
  /** What a human must still do for this step (e.g. content of a retired doc to carry over). */
  notes?: string[];
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
    if (step.optedIn && !step.optedIn(ctx)) {
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
    applied.push({ id: step.id, applied: true, changedFiles: result.changedFiles, commit: message, ...(result.notes && result.notes.length > 0 ? { notes: result.notes } : {}) });
    // A step may have rewritten the model (or its docs): later steps must see the new one.
    const fresh = freshCompile(ctx);
    if (fresh) {
      ctx.model = fresh.model;
      ctx.refs = fresh.refs;
    }
  }

  // The pre-apply human list can be stale (a rewritten model, a doc now out of sync): report the upgraded
  // repo's, computed before the `Em version:` stamp so transition-only notes still show.
  report.human = detectHumanItems(ctx);
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
