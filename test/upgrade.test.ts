// SPDX-License-Identifier: MIT
// Coverage for `em upgrade`'s core logic (src/cli/upgrade.ts, MIL-219): dry-run detection of
// every mechanical step and human item, --apply's one-commit-per-step behavior and idempotency,
// dirty-tree refusal, and --check's hard-incompatibility-only exit contract. Real git throughout
// (spawnSync, same convention test/cli.test.ts/test/metrics.test.ts use) — the whole point of
// this module is the git-commit orchestration, which a fake GitRunner would only paper over.
// CLI wiring (`em upgrade <file> [--apply|--check|--json]`) gets a light smoke check in
// test/cli.test.ts; this file exercises the orchestration functions directly. Neutral domain
// throughout (orders/catalog), per the engagement's non-negotiables.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compile } from "../src/pipeline.js";
import { makeMultiModelRepo, MULTI_MODEL_EXAMPLE_DIR } from "./helpers/multiModelRepo.js";
import { buildCiWorkflowFile, ciWorkflowPath } from "../src/cli/ciInit.js";
import {
  UpgradeContext,
  resolveFromVersion,
  resolveRepoRoot,
  isWorkingTreeClean,
  hasGitIdentity,
  detectUpgrade,
  applyUpgrade,
  checkUpgrade,
  UPGRADE_STEPS,
  applyGrandfatherSignoff,
} from "../src/cli/upgrade.js";
import { localIsoDate } from "../src/util/localDate.js";
import { STATE_FILE_NAME, loadStateFile, parseState } from "../src/cli/stateFile.js";

const INSTALLED_VERSION = "1.13.0";

function git(dir: string, ...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.email=t@t.test", "-c", "user.name=t", "-C", dir, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

const OLD_SHAPE_SOURCE = `slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
  processor Payment Gateway
}

slice "Capture Payment" {
  command Capture Payment
  event Payment Captured @Payment
}
`;

// The "more than one reaction" refusal case (mirrors test/migrateReactionShape.test.ts) — a
// shape em migrate itself refuses to touch, the `predates-1.6` human item's own trigger.
const REFUSAL_SHAPE_SOURCE = `slice "Leading" {
  view Read Model from "Some Event"
  processor First Reaction
  automation Second Reaction
}

slice "Following" {
  command Do Thing
  event Thing Done
}
`;

const SIX_BULLET_STATE_FILE = `# Event Modeling Progress — Checkout

- **Model file:** \`checkout.em\`
- **Current phase:** slice
- **Current step:** 4
- **Last updated:** 2026-01-01
- **Last conformance:** never
- **Last stakeholder review:** never
`;

interface FixtureOptions {
  source?: string;
  stateFile?: string | null;
  vendoredSkillStamp?: string | null; // null: no vendored bundle at all
}

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A "1.6 shape" fixture repo (per the brief): old two-slice reaction, a state file with only
 *  the original six bullets, no constitution, no CI workflow, optionally a stale vendored skill
 *  bundle — committed as the repo's initial commit so `isWorkingTreeClean` starts true. */
function makeFixtureRepo(opts: FixtureOptions = {}): { dir: string; packagedSkillsRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), "em-upgrade-fixture-"));
  tmpDirs.push(dir);
  git(dir, "init", "-q");
  // Persistent repo-local identity, not just this test file's own `-c user.name=...` override
  // (a one-shot flag, never written to `.git/config`): `applyUpgrade`'s internal `git commit`
  // calls (inside the CLI/module under test, via `realGit`) carry no such override of their own
  // and would otherwise depend on the *running machine's* global git config — absent on a CI
  // runner, present on a dev machine, which is exactly why this passed locally and failed in CI.
  git(dir, "config", "user.email", "t@t.test");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "checkout.em"), opts.source ?? OLD_SHAPE_SOURCE);
  const stateFile = opts.stateFile === undefined ? SIX_BULLET_STATE_FILE : opts.stateFile;
  if (stateFile !== null) writeFileSync(join(dir, STATE_FILE_NAME), stateFile);

  if (opts.vendoredSkillStamp !== null && opts.vendoredSkillStamp !== undefined) {
    mkdirSync(join(dir, ".claude", "skills", "event-modeling"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "event-modeling", "SKILL.md"), `---\nem-version: ${opts.vendoredSkillStamp}\n---\nold body\n`);
  }

  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");

  const packagedSkillsRoot = makePackagedSkillsRoot();
  tmpDirs.push(packagedSkillsRoot);
  return { dir, packagedSkillsRoot };
}

const BUNDLE_DIR_NAMES = [
  "event-modeling",
  "event-modeling-discover",
  "event-modeling-design",
  "event-modeling-implement",
  "event-modeling-conform",
  "event-modeling-review",
  "event-modeling-shared",
];

function makePackagedSkillsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "em-upgrade-packaged-"));
  for (const name of BUNDLE_DIR_NAMES) mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, "event-modeling", "SKILL.md"), `---\nem-version: ${INSTALLED_VERSION}\n---\nnew body\n`);
  return root;
}

function makeCtx(dir: string, packagedSkillsRoot: string, source?: string): UpgradeContext {
  const modelFile = join(dir, "checkout.em");
  const text = source ?? readFileSync(modelFile, "utf8");
  const { model, refs } = compile(text);
  const repoRootResult = resolveRepoRoot(dir);
  if (!repoRootResult.ok) throw new Error(repoRootResult.message);
  return {
    modelFile,
    baseDir: dir,
    repoRoot: repoRootResult.repoRoot,
    installedVersion: INSTALLED_VERSION,
    packagedSkillsRoot,
    model,
    refs,
  };
}

describe("resolveRepoRoot / isWorkingTreeClean", () => {
  it("resolves the repo root and reports a clean tree right after commit", () => {
    const { dir } = makeFixtureRepo();
    const result = resolveRepoRoot(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(isWorkingTreeClean(result.repoRoot)).toBe(true);
    }
  });

  it("refuses a directory outside any git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-upgrade-nogit-"));
    tmpDirs.push(dir);
    const result = resolveRepoRoot(dir);
    expect(result.ok).toBe(false);
  });

  it("hasGitIdentity is true once the fixture's own repo-local config is set", () => {
    const { dir } = makeFixtureRepo();
    expect(hasGitIdentity(dir)).toBe(true);
  });
});

describe("resolveFromVersion", () => {
  it("uses the recorded Em version: bullet when present, never inferred", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo();
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const from = resolveFromVersion(ctx, "1.10.0");
    expect(from).toEqual({ version: "1.10.0", inferred: false, basis: "recorded `Em version:` bullet" });
  });

  it("infers 1.6.0 from an old two-slice reaction shape when nothing is recorded", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo();
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const from = resolveFromVersion(ctx, null);
    expect(from.version).toBe("1.6.0");
    expect(from.inferred).toBe(true);
    expect(from.basis).toMatch(/old two-slice/);
  });

  it("infers from the vendored skill bundle's em-version stamp when the shape is already clean", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({
      source: 'slice "Place Order" {\n  ui Checkout @Customer\n  command Place Order\n  event Order Placed\n}\n',
      vendoredSkillStamp: "1.9.2",
    });
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const from = resolveFromVersion(ctx, null);
    expect(from).toEqual({ version: "1.9.2", inferred: true, basis: "vendored skill bundle's em-version: stamp" });
  });

  it("falls back to unknown with no evidence at all", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({
      source: 'slice "Place Order" {\n  ui Checkout @Customer\n  command Place Order\n  event Order Placed\n}\n',
    });
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const from = resolveFromVersion(ctx, null);
    expect(from.version).toBe("unknown");
    expect(from.inferred).toBe(true);
  });
});

describe("detectUpgrade — 1.6-shape fixture", () => {
  it("finds skill-bundle not applicable (no vendored bundle), reaction-shape/state-file/constitution applicable, ci-block not applicable", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo();
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const report = detectUpgrade(ctx);

    expect(report.from.version).toBe("1.6.0");
    expect(report.to).toBe(INSTALLED_VERSION);
    expect(report.stateFileError).toBeNull();

    const byId = Object.fromEntries(report.steps.map((s) => [s.id, s]));
    expect(byId["skill-bundle"].applicable).toBe(false);
    expect(byId["reaction-shape"].applicable).toBe(true);
    expect(byId["state-file"].applicable).toBe(true);
    expect(byId["ci-block"].applicable).toBe(false);
    expect(byId["constitution"].applicable).toBe(true);

    expect(report.steps.map((s) => s.id)).toEqual(UPGRADE_STEPS.map((s) => s.id));
  });

  it("finds skill-bundle applicable when a stale vendored bundle exists", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ vendoredSkillStamp: "1.7.0" });
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const report = detectUpgrade(ctx);
    const skillStep = report.steps.find((s) => s.id === "skill-bundle")!;
    expect(skillStep.applicable).toBe(true);
  });

  it("reports the predates-1.6 human item (never a step) for a refusal shape", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: REFUSAL_SHAPE_SOURCE });
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const report = detectUpgrade(ctx);
    expect(report.human.map((h) => h.id)).toContain("predates-1.6");
    // Nothing changes mechanically — planMigration reports the pair as a refusal, not a change.
    const reactionStep = report.steps.find((s) => s.id === "reaction-shape")!;
    expect(reactionStep.applicable).toBe(false);
  });
});

describe("detectUpgrade — human list", () => {
  const CLEAN_SOURCE = `model "Catalog Fixture"

persona Ops
context Orders

slice "Place Order" {
  command Place Order note "slices/place-order.md"
  event Order Placed
}
slice "Browse Orders" {
  view Orders from "Order Placed" note "slices/browse-orders.md"
  ui Orders Screen @Ops
}
`;

  it("flags no-model-version when Model version: is none and a slice is implemented", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN_SOURCE });
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(
      join(dir, "slices", "place-order.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: orders\nstatus: implemented\nversion: 1\nimplementedIn: https://github.com/org/repo/pull/1\n---\nbody\n",
    );
    writeFileSync(
      join(dir, "slices", "browse-orders.md"),
      "---\nschemaVersion: 1\npattern: state-view\nswimlane: orders\nstatus: draft\nversion: 1\n---\nbody\n",
    );
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const human = detectUpgrade(ctx).human;
    expect(human.map((h) => h.id)).toContain("no-model-version");
  });

  it("flags ready-to-implement-no-ratifiedby for a reratified (version > 1) doc missing ratifiedBy", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN_SOURCE });
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(
      join(dir, "slices", "place-order.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: orders\nstatus: ready-to-implement\nversion: 2\n---\nbody\n",
    );
    writeFileSync(
      join(dir, "slices", "browse-orders.md"),
      "---\nschemaVersion: 1\npattern: state-view\nswimlane: orders\nstatus: draft\nversion: 1\n---\nbody\n",
    );
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const human = detectUpgrade(ctx).human;
    const item = human.find((h) => h.id === "ready-to-implement-no-ratifiedby");
    expect(item).toBeDefined();
    expect(item!.reason).toContain("place-order");
    expect(item!.reason).toContain("version > 1");
  });

  it("MIL-259: a version-1 doc missing ratifiedBy is grandfathered by the ratified-signoff step, not a human item", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN_SOURCE });
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(
      join(dir, "slices", "place-order.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: orders\nstatus: ready-to-implement\nversion: 1\n---\nbody\n",
    );
    const report = detectUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(report.human.map((h) => h.id)).not.toContain("ready-to-implement-no-ratifiedby");
    const step = report.steps.find((st) => st.id === "ratified-signoff")!;
    expect(step.applicable).toBe(true);
    expect(step.sinceVersion).toBe("1.14.0");
    expect(step.reason).toContain("place-order");
  });

  it("does not flag ready-to-implement-no-ratifiedby once ratifiedBy is set", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN_SOURCE });
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(
      join(dir, "slices", "place-order.md"),
      "---\nschemaVersion: 1\npattern: state-change\nswimlane: orders\nstatus: ready-to-implement\nversion: 1\nratifiedBy: Alex Rivera\n---\nbody\n",
    );
    writeFileSync(
      join(dir, "slices", "browse-orders.md"),
      "---\nschemaVersion: 1\npattern: state-view\nswimlane: orders\nstatus: draft\nversion: 1\n---\nbody\n",
    );
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const human = detectUpgrade(ctx).human;
    expect(human.map((h) => h.id)).not.toContain("ready-to-implement-no-ratifiedby");
  });

  it("flags unratified-constitution when constitution.md has an empty ratifiedBy:", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN_SOURCE });
    writeFileSync(join(dir, "constitution.md"), "---\nratifiedBy:\n---\n# Constitution\ndraft\n");
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const human = detectUpgrade(ctx).human;
    expect(human.map((h) => h.id)).toContain("unratified-constitution");
  });

  it("does not flag unratified-constitution once ratifiedBy is filled in", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN_SOURCE });
    writeFileSync(join(dir, "constitution.md"), "---\nratifiedBy: Alex Rivera\n---\n# Constitution\nratified\n");
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const human = detectUpgrade(ctx).human;
    expect(human.map((h) => h.id)).not.toContain("unratified-constitution");
  });

  it("flags coverage-scope-default when em-ci.yml runs --strict and nothing is implemented", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN_SOURCE });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(
      join(dir, ".github", "workflows", "em-ci.yml"),
      'jobs:\n  coverage:\n    steps:\n      - run: npx @milehimikey/em@1.9.0 coverage "checkout.em" --tests "test" --strict\n',
    );
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const human = detectUpgrade(ctx).human;
    expect(human.map((h) => h.id)).toContain("coverage-scope-default");
  });
});

describe("ci-block step — real generated workflow content", () => {
  const CLEAN_SOURCE = 'slice "Place Order" {\n  ui Checkout @Customer\n  command Place Order\n  event Order Placed\n}\n';

  it("is not applicable when no em-ci.yml exists", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN_SOURCE });
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const step = detectUpgrade(ctx).steps.find((s) => s.id === "ci-block")!;
    expect(step.applicable).toBe(false);
  });

  it("is not applicable when em-ci.yml already matches the installed em (extracted args round-trip)", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN_SOURCE });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(ciWorkflowPath(dir), buildCiWorkflowFile("checkout.em", "test", INSTALLED_VERSION));
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const step = detectUpgrade(ctx).steps.find((s) => s.id === "ci-block")!;
    expect(step.applicable).toBe(false);
  });

  it("is applicable and refreshes the pinned em version when em-ci.yml was generated by an older em", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN_SOURCE });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(ciWorkflowPath(dir), buildCiWorkflowFile("checkout.em", "test", "1.9.0"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "add ci workflow");

    const ctx = makeCtx(dir, packagedSkillsRoot);
    const detected = detectUpgrade(ctx).steps.find((s) => s.id === "ci-block")!;
    expect(detected.applicable).toBe(true);

    const result = applyUpgrade(ctx);
    expect(result.ok).toBe(true);
    const applied = result.ok ? result.applied.find((s) => s.id === "ci-block") : undefined;
    expect(applied?.applied).toBe(true);
    const updated = readFileSync(ciWorkflowPath(dir), "utf8");
    expect(updated).toContain(`npx @milehimikey/em@${INSTALLED_VERSION} coverage "checkout.em" --tests "test" --strict`);
  });
});

describe("applyUpgrade — 1.6-shape fixture", () => {
  it("makes one commit per applicable step, in fixed order, plus a final Em version commit", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo();
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const result = applyUpgrade(ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const appliedIds = result.applied.filter((s) => s.applied).map((s) => s.id);
    expect(appliedIds).toEqual(["reaction-shape", "state-file", "constitution"]);
    for (const s of result.applied.filter((s) => s.applied)) {
      expect(s.commit).toBe(`em upgrade: ${s.id} (1.6.0 → ${INSTALLED_VERSION})`);
    }
    expect(result.emVersionCommit).toBe(`em upgrade: em-version (1.6.0 → ${INSTALLED_VERSION})`);

    const log = spawnSync("git", ["-C", dir, "log", "--format=%s"], { encoding: "utf8" }).stdout.trim().split("\n");
    // Newest first: em-version, constitution, state-file, reaction-shape, init.
    expect(log).toEqual([
      `em upgrade: em-version (1.6.0 → ${INSTALLED_VERSION})`,
      `em upgrade: constitution (1.6.0 → ${INSTALLED_VERSION})`,
      `em upgrade: state-file (1.6.0 → ${INSTALLED_VERSION})`,
      `em upgrade: reaction-shape (1.6.0 → ${INSTALLED_VERSION})`,
      "init",
    ]);

    const rewritten = readFileSync(join(dir, "checkout.em"), "utf8");
    expect(rewritten).toContain('processor Payment Gateway from "Payments To Process"');
    const state = readFileSync(join(dir, STATE_FILE_NAME), "utf8");
    expect(state).toContain(`- **Em version:** ${INSTALLED_VERSION}`);
    expect(state).toContain("- **Model version:** none");
    expect(state).toContain("- **Certified:** never");
  });

  it("is a no-op on a second run — zero new commits, working tree stays clean", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo();
    const ctx1 = makeCtx(dir, packagedSkillsRoot);
    const first = applyUpgrade(ctx1);
    expect(first.ok).toBe(true);

    const beforeLog = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    const ctx2 = makeCtx(dir, packagedSkillsRoot);
    const second = applyUpgrade(ctx2);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.applied.every((s) => !s.applied)).toBe(true);
      expect(second.emVersionCommit).toBeNull();
    }
    const afterLog = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
    expect(afterLog).toBe(beforeLog);
    expect(isWorkingTreeClean(dir)).toBe(true);
  });

  it("refuses to start on a dirty working tree, saying so, without touching anything", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo();
    writeFileSync(join(dir, "untracked.txt"), "dirty");
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const result = applyUpgrade(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/working tree is not clean/);
    expect(result.applied).toEqual([]);
  });

  it("refuses to start with no git identity configured, saying so, without touching anything", () => {
    // A real fixture DOES have identity (makeFixtureRepo sets it) — this simulates the CI-runner
    // case (no git identity anywhere) by intercepting only `git config user.name`/`user.email`
    // and delegating every other call to the real git, rather than actually clearing this
    // machine's own config.
    const { dir, packagedSkillsRoot } = makeFixtureRepo();
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const noIdentityGit = (args: string[]) => {
      if (args[0] === "-C" && args[2] === "config" && (args[3] === "user.name" || args[3] === "user.email")) {
        return { status: 1, stdout: "", stderr: "" };
      }
      const r = spawnSync("git", args, { encoding: "utf8" });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    const result = applyUpgrade(ctx, noIdentityGit);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/no git identity configured/);
    expect(result.applied).toEqual([]);
  });
});

describe("checkUpgrade", () => {
  it("exits ok on the ordinary 1.6-shape case (steps applicable, no hard incompatibility)", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo();
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const { ok } = checkUpgrade(ctx);
    expect(ok).toBe(true);
  });

  it("fails on an unparseable state file (hard incompatibility)", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({
      stateFile: "# Event Modeling Progress\n\n- **Model file:** `checkout.em`\n- **Current phase:** slice\n",
    });
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const { ok, report } = checkUpgrade(ctx);
    expect(ok).toBe(false);
    expect(report.stateFileError).not.toBeNull();
  });

  it("fails on a predates-1.6 refusal shape (hard incompatibility)", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: REFUSAL_SHAPE_SOURCE });
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const { ok } = checkUpgrade(ctx);
    expect(ok).toBe(false);
  });

  it("passes with no state file bullet errors once already upgraded (idempotent from the CI gate's own view)", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo();
    const ctx1 = makeCtx(dir, packagedSkillsRoot);
    applyUpgrade(ctx1);
    const ctx2 = makeCtx(dir, packagedSkillsRoot);
    const { ok } = checkUpgrade(ctx2);
    expect(ok).toBe(true);
  });
});

// MIL-257: `--check` says WHY it exits 1, and a repo with no state file has a path to green.
describe("state-file step — missing file is scaffolded, broken file is explained (MIL-257)", () => {
  const FOUR_OF_SIX = "- **Model file:** checkout.em\n- **Current phase:** slice\n- **Last updated:** 2026-01-01\n- **Last conformance:** never\n";

  it("no state file: stateFileError is null, state-file is a pending step, --check passes", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ stateFile: null, source: "slice \"Place Order\" {\n  ui Checkout @Customer\n  command Place Order\n  event Order Placed\n}\n" });
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const { ok, report, reasons } = checkUpgrade(ctx);
    expect(ok).toBe(true);
    expect(reasons).toEqual([]);
    expect(report.stateFileError).toBeNull();
    const step = report.steps.find((s) => s.id === "state-file")!;
    expect(step.applicable).toBe(true);
    expect(step.reason).toContain("will scaffold");
  });

  it("--apply scaffolds a parseable state file as one commit, after which --check is still ok and the step is done", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ stateFile: null, source: "slice \"Place Order\" {\n  ui Checkout @Customer\n  command Place Order\n  event Order Placed\n}\n" });
    const result = applyUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(result.ok).toBe(true);
    const stateStep = result.ok ? result.applied.find((a) => a.id === "state-file")! : null;
    expect(stateStep?.applied).toBe(true);
    const log = spawnSync("git", ["-C", dir, "log", "--format=%s"], { encoding: "utf8" }).stdout.trim().split("\n");
    expect(log.filter((l) => l.startsWith("em upgrade: state-file"))).toHaveLength(1);

    const loaded = loadStateFile(dir);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const parsed = parseState(loaded.text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.state.emVersion).toBe(INSTALLED_VERSION);
    expect(parsed.state.modelVersion).toBeNull();
    expect(parsed.state.lastConformance).toBeNull();
    expect(parsed.state.lastReview).toBeNull();
    expect(loaded.text).toContain("`checkout.em`"); // Model file: names the model actually upgraded

    const again = checkUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(again.ok).toBe(true);
    expect(again.report.steps.find((s) => s.id === "state-file")!.applicable).toBe(false);
  });

  it("existing state file missing required bullets: hard incompatibility naming the file and the bullets; checklist shows the real cause", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ stateFile: FOUR_OF_SIX });
    const { ok, report, reasons } = checkUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(ok).toBe(false);
    expect(report.stateFileError).toContain(join(dir, STATE_FILE_NAME));
    expect(report.stateFileError).toContain('is missing bullet line(s): "- **Current step:**", "- **Last stakeholder review:**"');
    expect(reasons).toEqual([report.stateFileError]);
    const step = report.steps.find((s) => s.id === "state-file")!;
    expect(step.applicable).toBe(false);
    expect(step.reason).toBe(report.stateFileError);
  });

  it("--apply keeps refusing on a broken existing state file, with the specific reason", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ stateFile: FOUR_OF_SIX });
    const result = applyUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('"- **Current step:**"');
  });

  it("predates-1.6 is also named in the reasons", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: REFUSAL_SHAPE_SOURCE });
    const { ok, reasons } = checkUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(ok).toBe(false);
    expect(reasons.some((r) => r.startsWith("predates-1.6:"))).toBe(true);
  });
});

describe("ratified-signoff step (MIL-259)", () => {
  const CLEAN = 'slice "Place Order" {\n  ui Checkout @Customer\n  command Place Order note "slices/place-order.md"\n  event Order Placed\n}\n';

  it("applyGrandfatherSignoff inserts the two keys right after status, preserving CRLF and the body", () => {
    const lf = "---\nschemaVersion: 1\nstatus: ready-to-implement\nversion: 1\n---\nbody\n";
    expect(applyGrandfatherSignoff(lf, "2026-10-07")).toBe(
      '---\nschemaVersion: 1\nstatus: ready-to-implement\nratifiedBy: "grandfathered (unsigned before em 1.14)"\nratifiedOn: 2026-10-07\nversion: 1\n---\nbody\n',
    );
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(applyGrandfatherSignoff(crlf, "2026-10-07")).toBe(
      '---\r\nschemaVersion: 1\r\nstatus: ready-to-implement\r\nratifiedBy: "grandfathered (unsigned before em 1.14)"\r\nratifiedOn: 2026-10-07\r\nversion: 1\r\n---\r\nbody\r\n',
    );
    expect(applyGrandfatherSignoff("---\nstatus: ready-to-implement\nratifiedBy: Alex\n---\n", "2026-10-07")).toBeNull();
  });

  it("--apply writes one commit, the doc then passes --slice-ready's ratification check, and a second run is a no-op", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN, stateFile: null });
    mkdirSync(join(dir, "slices"), { recursive: true });
    const docPath = join(dir, "slices", "place-order.md");
    writeFileSync(docPath, "---\nschemaVersion: 1\npattern: state-change\nswimlane: orders\nstatus: ready-to-implement\nversion: 1\n---\nbody\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "doc");
    const result = applyUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const step = result.applied.find((a) => a.id === "ratified-signoff")!;
    expect(step.applied).toBe(true);
    expect(step.changedFiles).toEqual([docPath]);
    const text = readFileSync(docPath, "utf8");
    expect(text).toContain('ratifiedBy: "grandfathered (unsigned before em 1.14)"');
    expect(text).toContain(`ratifiedOn: ${localIsoDate()}`);
    const log = spawnSync("git", ["-C", dir, "log", "--format=%s"], { encoding: "utf8" }).stdout;
    expect(log.split("\n").filter((l) => l.startsWith("em upgrade: ratified-signoff"))).toHaveLength(1);
    const again = detectUpgrade(makeCtx(dir, packagedSkillsRoot)).steps.find((st) => st.id === "ratified-signoff")!;
    expect(again.applicable).toBe(false);
  });

  it("leaves a version > 1 doc untouched (mid-reratify)", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN, stateFile: null });
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(join(dir, "slices", "place-order.md"), "---\nschemaVersion: 1\npattern: state-change\nswimlane: orders\nstatus: ready-to-implement\nversion: 2\n---\nbody\n");
    const step = detectUpgrade(makeCtx(dir, packagedSkillsRoot)).steps.find((st) => st.id === "ratified-signoff")!;
    expect(step.applicable).toBe(false);
  });
});

// MIL-235 (R2): every --apply commit carries an `Em-Upgrade: <step-id>` trailer.
describe("applyUpgrade — Em-Upgrade trailer", () => {
  it("every step commit and the final em-version commit carry `Em-Upgrade: <id>` (read back via %(trailers))", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo();
    const result = applyUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(result.ok).toBe(true);
    const out = spawnSync("git", ["-C", dir, "log", "--format=%s%x1f%(trailers:key=Em-Upgrade,valueonly)%x1e"], { encoding: "utf8" }).stdout;
    const rows = out
      .split("\x1e")
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => r.split("\x1f").map((x) => x.trim()));
    expect(rows).toEqual([
      [`em upgrade: em-version (1.6.0 → ${INSTALLED_VERSION})`, "em-version"],
      [`em upgrade: constitution (1.6.0 → ${INSTALLED_VERSION})`, "constitution"],
      [`em upgrade: state-file (1.6.0 → ${INSTALLED_VERSION})`, "state-file"],
      [`em upgrade: reaction-shape (1.6.0 → ${INSTALLED_VERSION})`, "reaction-shape"],
      ["init", ""],
    ]);
  });
});

// MIL-235 (R3): system.yaml 1.0 -> 2.0, seams -> consumes, owner -> model header, one commit.
describe("system-manifest step", () => {
  const ctxFor = (modelFile: string): UpgradeContext => {
    const { model, refs } = compile(readFileSync(modelFile, "utf8"));
    const root = resolveRepoRoot(dirname(modelFile));
    if (!root.ok) throw new Error(root.message);
    return { modelFile, baseDir: dirname(modelFile), repoRoot: root.repoRoot, installedVersion: INSTALLED_VERSION, packagedSkillsRoot: tmpdir(), model, refs };
  };
  const step = (_ctx: UpgradeContext) => UPGRADE_STEPS.find((s) => s.id === "system-manifest")!;

  it("is registered last, since 1.14.0", () => {
    expect(UPGRADE_STEPS.map((s) => s.id).at(-1)).toBe("system-manifest");
    expect(UPGRADE_STEPS.find((s) => s.id === "system-manifest")!.sinceVersion).toBe("1.14.0");
  });

  it("detects a 1.0 manifest found by walking up from the model, and is not applicable without one or on 2.0", () => {
    const legacy = makeMultiModelRepo({ legacy: true });
    const current = makeMultiModelRepo();
    const none = makeMultiModelRepo({ manifest: false });
    tmpDirs.push(legacy.dir, current.dir, none.dir);
    const d = step(ctxFor(legacy.fulfillment)).detect(ctxFor(legacy.fulfillment));
    expect(d.applicable).toBe(true);
    expect(d.reason).toMatch(/system\.yaml is systemSchemaVersion "1\.0" — em upgrade will move its 1 seam\(s\) into `consumes` clauses, its owner\(s\) onto the 2 model header\(s\), and rewrite it to "2\.0"$/);
    const c = step(ctxFor(current.checkout)).detect(ctxFor(current.checkout));
    expect(c.applicable).toBe(false);
    expect(c.reason).toMatch(/system\.yaml is already systemSchemaVersion "2\.0"$/);
    const n = step(ctxFor(none.checkout)).detect(ctxFor(none.checkout));
    expect(n).toEqual({ applicable: false, reason: "no system.yaml between the model and the repository root" });
  });

  it("--apply migrates the example in ONE commit with the trailer — identical to the shipped example — and a second run (from the other member) is a no-op", () => {
    const repo = makeMultiModelRepo({ legacy: true });
    tmpDirs.push(repo.dir);
    const before = repo.git("rev-parse", "HEAD").trim();
    const result = applyUpgrade(ctxFor(repo.fulfillment));
    expect(result.ok).toBe(true);
    const applied = result.ok ? result.applied.find((s) => s.id === "system-manifest")! : undefined;
    expect(applied?.applied).toBe(true);

    // Exactly one commit touched the three files, and it carries `Em-Upgrade: system-manifest`.
    const touching = repo.git("log", "--format=%H%x1f%(trailers:key=Em-Upgrade,valueonly)", `${before}..HEAD`, "--", "system.yaml", "models/checkout/checkout.em", "models/fulfillment/fulfillment.em").trim().split("\n");
    expect(touching).toHaveLength(1);
    expect(touching[0].split("\x1f")[1].trim()).toBe("system-manifest");
    const files = repo.git("show", "--name-only", "--format=", touching[0].split("\x1f")[0]).trim().split("\n").sort();
    expect(files).toEqual(["models/checkout/checkout.em", "models/fulfillment/fulfillment.em", "system.yaml"]);

    // The migrated models are byte-identical to the shipped (migrated) example.
    for (const rel of ["models/checkout/checkout.em", "models/fulfillment/fulfillment.em"]) {
      expect(readFileSync(join(repo.dir, rel), "utf8")).toBe(readFileSync(join(MULTI_MODEL_EXAMPLE_DIR, rel), "utf8"));
    }
    const manifest = readFileSync(repo.manifest, "utf8");
    expect(manifest).toContain('systemSchemaVersion: "2.0"');
    expect(manifest).not.toMatch(/^\s*(seams|owner):/m);

    // Second run from the OTHER member: nothing to do.
    expect(step(ctxFor(repo.checkout)).detect(ctxFor(repo.checkout)).applicable).toBe(false);
  });

  it("refuses (writes nothing) when a seam's consumer is not a translation — `consumes` is translation-only", () => {
    const repo = makeMultiModelRepo({ legacy: true });
    tmpDirs.push(repo.dir);
    writeFileSync(repo.fulfillment, readFileSync(repo.fulfillment, "utf8").replace("translation Order Intake", "automation Order Intake"));
    writeFileSync(repo.manifest, readFileSync(repo.manifest, "utf8").replace("translation.order-intake", "automation.order-intake"));
    repo.git("commit", "-q", "-am", "automation consumer");
    const ctx = ctxFor(repo.fulfillment);
    const outcome = step(ctx).apply(ctx);
    expect(outcome).toEqual({
      ok: false,
      message:
        "seams[0] (checkout:checkout/event.order-submitted -> fulfillment:receive-order/automation.order-intake): the consumer is automation " +
        '"Order Intake", but `consumes` is only valid on translation — make it a translation (it crosses a model boundary) or drop the seam, then re-run',
    });
    expect(repo.git("status", "--porcelain").trim()).toBe("");
  });

  it("a bare-slice `to` resolves to the slice's single reaction; an existing header owner wins", () => {
    const repo = makeMultiModelRepo({ legacy: true });
    tmpDirs.push(repo.dir);
    writeFileSync(repo.manifest, readFileSync(repo.manifest, "utf8").replace("fulfillment:receive-order/translation.order-intake", "fulfillment:receive-order"));
    writeFileSync(repo.checkout, readFileSync(repo.checkout, "utf8").replace('model "Checkout"', 'model "Checkout" owner "@shop/storefront"'));
    repo.git("commit", "-q", "-am", "bare slice + owned header");
    const ctx = ctxFor(repo.checkout);
    expect(step(ctx).apply(ctx)).toMatchObject({ ok: true });
    expect(readFileSync(repo.fulfillment, "utf8")).toContain("translation Order Intake consumes checkout:event.order-submitted");
    expect(readFileSync(repo.checkout, "utf8").split("\n")[0]).toBe('model "Checkout" owner "@shop/storefront"');
  });
});
