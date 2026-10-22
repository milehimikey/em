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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compile } from "../src/pipeline.js";
import { makeMultiModelRepo, MULTI_MODEL_EXAMPLE_DIR } from "./helpers/multiModelRepo.js";
import { CI_PR_PATHS, missingCiPullRequestPaths, refreshCiPullRequestPaths, buildCiWorkflowFile, buildCiWorkflowFileMulti, buildConformWorkflowFileMulti, conformWorkflowPath, ciWorkflowPath, type CiModel } from "../src/cli/ciInit.js";
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
  detectHumanItems,
} from "../src/cli/upgrade.js";
import { localIsoDate } from "../src/util/localDate.js";
import { ratifiedHashScope, sliceDocBodyHash, sliceDocLegacyBodyHash } from "../src/catalog/sliceDoc.js";
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
  "event-modeling-engagement",
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

  it("a stale vendored bundle is handled by skill-plugin, not skill-bundle (MIL-232)", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ vendoredSkillStamp: "1.7.0" });
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const report = detectUpgrade(ctx);
    const skillStep = report.steps.find((s) => s.id === "skill-bundle")!;
    expect(skillStep.applicable).toBe(false);
    expect(report.steps.find((s) => s.id === "skill-plugin")!.applicable).toBe(true);
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

  it("flags public-field-types-unresolved, listing every offending public field (MIL-237, detect-only)", () => {
    const source = `type Line { sku: Sku, qty: int }
slice "Place Order" {
  command Place Order public { total: Money, lines: Line[] }
  event Order Placed @Orders public { orderId, total: decimal }
  event Internal Thing @Orders { anything: Whatever }
}
`;
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source });
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const item = detectUpgrade(ctx).human.find((h) => h.id === "public-field-types-unresolved");
    expect(item).toEqual({
      id: "public-field-types-unresolved",
      reason:
        "3 public field(s) without a public type: Place Order.total: Money, Order Placed.orderId: (no type), Line.sku: Sku — " +
        "give each a type from string, text, int, long, decimal, boolean, uuid, date, datetime, duration, bytes, `X[]`, " +
        "or a declared `type` (em 1.14 strict public types), or drop `public`",
    });
  });

  it("does not flag public-field-types-unresolved when every public field resolves", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN_SOURCE });
    const ctx = makeCtx(dir, packagedSkillsRoot);
    expect(detectUpgrade(ctx).human.map((h) => h.id)).not.toContain("public-field-types-unresolved");
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

  it("accepts spec-kit's **Ratified**: footer as a sign-off too (MIL-287)", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN_SOURCE });
    writeFileSync(join(dir, "constitution.md"), "---\nratifiedBy:\n---\n# Constitution\n\n**Ratified**: 2026-01-01\n");
    const human = detectUpgrade(makeCtx(dir, packagedSkillsRoot)).human;
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

describe("ci-block step — multi-model blocks (MIL-233)", () => {
  const CLEAN_SOURCE = 'slice "Place Order" {\n  ui Checkout @Customer\n  command Place Order\n  event Order Placed\n}\n';
  const MANIFEST = 'systemSchemaVersion: "2.0"\nname: S\nmodels:\n  checkout:\n    source: checkout.em\n  billing:\n    source: billing/billing.em\n';
  const MODELS: CiModel[] = [
    { key: "checkout", path: "checkout.em" },
    { key: "billing", path: "billing/billing.em" },
  ];

  function repoWith(opts: { manifest: boolean; version: string }): { dir: string; packagedSkillsRoot: string } {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN_SOURCE });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(ciWorkflowPath(dir), buildCiWorkflowFileMulti("system.yaml", MODELS, "test", opts.version));
    writeFileSync(conformWorkflowPath(dir), buildConformWorkflowFileMulti("system.yaml", MODELS, opts.version));
    if (opts.manifest) writeFileSync(join(dir, "system.yaml"), MANIFEST);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "add multi-model ci");
    return { dir, packagedSkillsRoot };
  }

  it("is not applicable when the multi-model block already matches the installed em", () => {
    const { dir, packagedSkillsRoot } = repoWith({ manifest: true, version: INSTALLED_VERSION });
    const step = detectUpgrade(makeCtx(dir, packagedSkillsRoot)).steps.find((s) => s.id === "ci-block")!;
    expect(step.applicable).toBe(false);
  });

  it("refreshes every model's section from the manifest beside the repo root, in both files", () => {
    const { dir, packagedSkillsRoot } = repoWith({ manifest: true, version: "1.9.0" });
    // The manifest gained a model since the block was generated: the manifest is authoritative.
    writeFileSync(join(dir, "system.yaml"), MANIFEST + "  shipping:\n    source: shipping/shipping.em\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "add a model");
    const ctx = makeCtx(dir, packagedSkillsRoot);
    expect(detectUpgrade(ctx).steps.find((s) => s.id === "ci-block")!.applicable).toBe(true);
    const result = applyUpgrade(ctx);
    expect(result.ok).toBe(true);
    const all: CiModel[] = [...MODELS, { key: "shipping", path: "shipping/shipping.em" }];
    // Only the managed block refreshes (the generated header comment is the repo's from then on).
    const body = (text: string) => text.slice(text.indexOf("# GENERATED:"));
    expect(body(readFileSync(ciWorkflowPath(dir), "utf8"))).toBe(body(buildCiWorkflowFileMulti("system.yaml", all, "test", INSTALLED_VERSION)));
    expect(body(readFileSync(conformWorkflowPath(dir), "utf8"))).toBe(body(buildConformWorkflowFileMulti("system.yaml", all, INSTALLED_VERSION)));
  });

  it("never narrows a multi-model block to one model when there is no manifest: not applicable, with the reason", () => {
    const { dir, packagedSkillsRoot } = repoWith({ manifest: false, version: "1.9.0" });
    const before = readFileSync(ciWorkflowPath(dir), "utf8");
    const ctx = makeCtx(dir, packagedSkillsRoot);
    const step = detectUpgrade(ctx).steps.find((s) => s.id === "ci-block")!;
    expect(step.applicable).toBe(false);
    expect(step.reason).toContain("em-ci.yml covers 2 models (billing/billing.em, checkout.em) but no readable system.yaml sits at the repo root");
    applyUpgrade(ctx);
    expect(readFileSync(ciWorkflowPath(dir), "utf8")).toBe(before);
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
      // MIL-234: the shipped example's headers carry handles; the migration writes the legacy
      // manifest's free-text owners as-is, so compare modulo that one substitution.
      const shipped = readFileSync(join(MULTI_MODEL_EXAMPLE_DIR, rel), "utf8")
        .replace('owner "@example/storefront"', 'owner "Storefront team"')
        .replace('owner "@example/warehouse"', 'owner "Warehouse team"')
        // MIL-266: the shipped translation carries its doc binding after `consumes`; the legacy
        // fixture has none (the migration appends `consumes` at the end of the line).
        .replace(' note "slices/receive-order.md"', "");
      expect(readFileSync(join(repo.dir, rel), "utf8")).toBe(shipped);
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

// MIL-232 (R14): vendored bundle -> pinned em plugin, one commit.
describe("skill-plugin step", () => {
  const SETTINGS_BEFORE = `{\n  "permissions": { "allow": ["Bash(git status)"] },\n  "model": "opus"\n}\n`;
  const SETTINGS_AFTER = `{
  "permissions": {
    "allow": [
      "Bash(git status)"
    ]
  },
  "model": "opus",
  "extraKnownMarketplaces": {
    "em-1-13-0": {
      "source": {
        "source": "github",
        "repo": "milehimikey/em",
        "ref": "v1.13.0"
      }
    }
  },
  "enabledPlugins": {
    "em@em-1-13-0": true
  }
}
`;

  function vendoredRepo(withSettings = true): { dir: string; packagedSkillsRoot: string } {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ vendoredSkillStamp: INSTALLED_VERSION });
    for (const d of BUNDLE_DIR_NAMES) {
      mkdirSync(join(dir, ".claude", "skills", d), { recursive: true });
      writeFileSync(join(dir, ".claude", "skills", d, "x.md"), "vendored\n");
    }
    mkdirSync(join(dir, ".claude", "skills", "my-own-skill"), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", "my-own-skill", "SKILL.md"), "mine\n");
    if (withSettings) writeFileSync(join(dir, ".claude", "settings.json"), SETTINGS_BEFORE);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "vendor bundle");
    return { dir, packagedSkillsRoot };
  }

  const step = UPGRADE_STEPS.find((s) => s.id === "skill-plugin")!;

  it("is the first step, ahead of skill-bundle", () => {
    const ids = UPGRADE_STEPS.map((s) => s.id);
    expect(ids[0]).toBe("skill-plugin");
    expect(ids[1]).toBe("skill-bundle");
    expect(step.sinceVersion).toBe("1.14.0");
  });

  it("dry-run lists the directories, the settings entries, the AGENTS.md refresh, and the human install item", () => {
    const { dir, packagedSkillsRoot } = vendoredRepo();
    const report = detectUpgrade(makeCtx(dir, packagedSkillsRoot));
    const s = report.steps.find((x) => x.id === "skill-plugin")!;
    expect(s.applicable).toBe(true);
    expect(report.steps[0].id).toBe("skill-plugin");
    expect(report.steps.find((x) => x.id === "skill-bundle")!.applicable).toBe(false);
    for (const d of BUNDLE_DIR_NAMES) expect(s.reason).toContain(`.claude/skills/${d}`);
    expect(s.reason).toContain('extraKnownMarketplaces["em-1-13-0"]');
    expect(s.reason).toContain('enabledPlugins["em@em-1-13-0"]');
    expect(s.reason).toContain("AGENTS.md");
    const h = report.human.find((x) => x.id === "plugin-install-locally")!;
    expect(h.reason).toContain("claude plugin marketplace add milehimikey/em@v1.13.0 --scope project");
    expect(h.reason).toContain("claude plugin install em@em-1-13-0 --scope project");
    // dry-run wrote nothing
    expect(spawnSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" }).stdout).toBe("");
  });

  it("--apply makes exactly one skill-plugin commit with the trailer, merges settings, spares siblings, refreshes AGENTS.md", () => {
    const { dir, packagedSkillsRoot } = vendoredRepo();
    const result = applyUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(result.ok).toBe(true);
    const out = spawnSync("git", ["-C", dir, "log", "--format=%s%x1f%(trailers:key=Em-Upgrade,valueonly)%x1e"], { encoding: "utf8" }).stdout;
    const rows = out.split("\x1e").map((r) => r.trim()).filter(Boolean).map((r) => r.split("\x1f").map((x) => x.trim()));
    expect(rows.filter((r) => r[1] === "skill-plugin")).toHaveLength(1);
    for (const d of BUNDLE_DIR_NAMES) expect(existsSync(join(dir, ".claude", "skills", d))).toBe(false);
    expect(readFileSync(join(dir, ".claude", "skills", "my-own-skill", "SKILL.md"), "utf8")).toBe("mine\n");
    expect(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).toBe(SETTINGS_AFTER);
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    for (const n of ["/em:event-modeling", "/em:discover", "/em:design", "/em:implement", "/em:conform", "/em:review"]) expect(agents).toContain(n);
    expect(agents).toContain("claude plugin marketplace add milehimikey/em@v<version> --scope project");
    expect(isWorkingTreeClean(dir)).toBe(true);
    const applied = result.ok ? result.applied : [];
    expect(applied.find((a) => a.id === "skill-bundle")!.applied).toBe(false);
    expect(rows.filter((r) => /skill-/.test(r[1]))).toHaveLength(1);
    expect(applied.find((a) => a.id === "skill-plugin")!.changedFiles).toContain(join(".claude", "settings.json"));
  });

  it("creates settings.json when absent", () => {
    const { dir, packagedSkillsRoot } = vendoredRepo(false);
    expect(applyUpgrade(makeCtx(dir, packagedSkillsRoot)).ok).toBe(true);
    const parsed = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    expect(parsed.enabledPlugins).toEqual({ "em@em-1-13-0": true });
  });

  it("a second run is not applicable and makes no commit", () => {
    const { dir, packagedSkillsRoot } = vendoredRepo();
    applyUpgrade(makeCtx(dir, packagedSkillsRoot));
    const before = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout;
    const again = applyUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(again.ok).toBe(true);
    expect(spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout).toBe(before);
    const rep = detectUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(rep.steps.find((x) => x.id === "skill-plugin")!.applicable).toBe(false);
    expect(rep.steps.find((x) => x.id === "skill-bundle")!.reason).toBe("plugin repo — nothing to sync");
  });

  it("is not applicable when the plugin is already declared, or no bundle is vendored", () => {
    const { dir, packagedSkillsRoot } = vendoredRepo();
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ extraKnownMarketplaces: { "em-1-12-0": { source: { source: "github", repo: "milehimikey/em", ref: "v1.12.0" } } } }),
    );
    expect(step.detect(makeCtx(dir, packagedSkillsRoot)).applicable).toBe(false);
    const bare = makeFixtureRepo();
    expect(step.detect(makeCtx(bare.dir, bare.packagedSkillsRoot)).applicable).toBe(false);
  });

  it("refuses to touch an unparseable settings.json (nothing deleted)", () => {
    const { dir, packagedSkillsRoot } = vendoredRepo();
    writeFileSync(join(dir, ".claude", "settings.json"), "{ not json");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "broken settings");
    const ctx = makeCtx(dir, packagedSkillsRoot);
    expect(step.detect(ctx).applicable).toBe(false);
    expect(step.apply(ctx).ok).toBe(false);
    expect(existsSync(join(dir, ".claude", "skills", "event-modeling"))).toBe(true);
  });

  it("refuses a dirty tree", () => {
    const { dir, packagedSkillsRoot } = vendoredRepo();
    writeFileSync(join(dir, "stray.txt"), "x");
    const r = applyUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(r.ok).toBe(false);
    expect(existsSync(join(dir, ".claude", "skills", "event-modeling"))).toBe(true);
  });

  it("plugin-install-locally fires for a declared plugin missing from the machine registry, and clears when registered", () => {
    const { dir, packagedSkillsRoot } = vendoredRepo();
    applyUpgrade(makeCtx(dir, packagedSkillsRoot));
    const plugins = mkdtempSync(join(tmpdir(), "em-upgrade-plugins-"));
    tmpDirs.push(plugins);
    const prev = process.env.EM_CLAUDE_PLUGINS_DIR;
    process.env.EM_CLAUDE_PLUGINS_DIR = plugins;
    try {
      expect(detectUpgrade(makeCtx(dir, packagedSkillsRoot)).human.some((h) => h.id === "plugin-install-locally")).toBe(true);
      writeFileSync(join(plugins, "known_marketplaces.json"), JSON.stringify({ "em-1-13-0": { source: { source: "github", repo: "milehimikey/em", ref: "v1.13.0" } } }));
      expect(detectUpgrade(makeCtx(dir, packagedSkillsRoot)).human.some((h) => h.id === "plugin-install-locally")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.EM_CLAUDE_PLUGINS_DIR;
      else process.env.EM_CLAUDE_PLUGINS_DIR = prev;
    }
  });
});

// MIL-269 (R32): the four .claude/agents/em-*.md files ride inside the existing skill steps; the
// directory is shared with the consumer's own agents, so only the fixed list is ever touched.
describe("agent files in skill-bundle / skill-plugin (MIL-269)", () => {
  const AGENT_FILES = ["em-implementer.md", "em-validator.md", "em-reviewer.md", "em-critic.md"];

  function agentRepo(): { dir: string; packagedSkillsRoot: string; packagedAgentsRoot: string } {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ vendoredSkillStamp: INSTALLED_VERSION });
    for (const d of BUNDLE_DIR_NAMES) {
      mkdirSync(join(dir, ".claude", "skills", d), { recursive: true });
      writeFileSync(join(packagedSkillsRoot, d, "x.md"), "vendored\n");
      writeFileSync(join(dir, ".claude", "skills", d, "x.md"), "vendored\n");
    }
    writeFileSync(join(dir, ".claude", "skills", "event-modeling", "SKILL.md"), readFileSync(join(packagedSkillsRoot, "event-modeling", "SKILL.md")));
    const packagedAgentsRoot = mkdtempSync(join(tmpdir(), "em-upgrade-packaged-agents-"));
    tmpDirs.push(packagedAgentsRoot);
    for (const f of AGENT_FILES) writeFileSync(join(packagedAgentsRoot, f), `packaged ${f}\n`);
    mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
    for (const f of AGENT_FILES) writeFileSync(join(dir, ".claude", "agents", f), `packaged ${f}\n`);
    writeFileSync(join(dir, ".claude", "agents", "my-agent.md"), "mine\n");
    // an unparseable settings.json keeps skill-plugin out of the way so skill-bundle is the live step
    writeFileSync(join(dir, ".claude", "settings.json"), "[]");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "vendor bundle + agents");
    return { dir, packagedSkillsRoot, packagedAgentsRoot };
  }
  const ctxOf = (r: { dir: string; packagedSkillsRoot: string; packagedAgentsRoot: string }): UpgradeContext => ({
    ...makeCtx(r.dir, r.packagedSkillsRoot),
    packagedAgentsRoot: r.packagedAgentsRoot,
  });
  const bundle = UPGRADE_STEPS.find((s) => s.id === "skill-bundle")!;
  const plugin = UPGRADE_STEPS.find((s) => s.id === "skill-plugin")!;

  it("skill-bundle: in sync -> not applicable; a stale or missing agent -> applicable, apply restores, siblings untouched", () => {
    const r = agentRepo();
    expect(bundle.detect(ctxOf(r)).applicable).toBe(false);
    writeFileSync(join(r.dir, ".claude", "agents", "em-validator.md"), "edited\n");
    rmSync(join(r.dir, ".claude", "agents", "em-critic.md"));
    const d = bundle.detect(ctxOf(r));
    expect(d.applicable).toBe(true);
    expect(d.reason).toContain("2 file(s)");
    const out = bundle.apply(ctxOf(r));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.changedFiles.sort()).toEqual([join(".claude", "agents", "em-critic.md"), join(".claude", "agents", "em-validator.md")]);
    expect(readFileSync(join(r.dir, ".claude", "agents", "em-validator.md"), "utf8")).toBe("packaged em-validator.md\n");
    expect(readFileSync(join(r.dir, ".claude", "agents", "my-agent.md"), "utf8")).toBe("mine\n");
    expect(bundle.detect(ctxOf(r)).applicable).toBe(false);
  });

  it("skill-plugin removes exactly the four em agent files and nothing else in .claude/agents/", () => {
    const r = agentRepo();
    writeFileSync(join(r.dir, ".claude", "settings.json"), "{}\n");
    git(r.dir, "add", "-A");
    git(r.dir, "commit", "-q", "-m", "settings");
    const d = plugin.detect(ctxOf(r));
    expect(d.applicable).toBe(true);
    for (const f of AGENT_FILES) expect(d.reason).toContain(`.claude/agents/${f}`);
    const out = plugin.apply(ctxOf(r));
    expect(out.ok).toBe(true);
    if (out.ok) for (const f of AGENT_FILES) expect(out.changedFiles).toContain(join(".claude", "agents", f));
    for (const f of AGENT_FILES) expect(existsSync(join(r.dir, ".claude", "agents", f))).toBe(false);
    expect(readFileSync(join(r.dir, ".claude", "agents", "my-agent.md"), "utf8")).toBe("mine\n");
  });
});

describe("ratified-hash-scope step (GH #253)", () => {
  const CLEAN = 'slice "Place Order" {\n  ui Checkout @Customer\n  command Place Order note "slices/place-order.md"\n  event Order Placed\n}\n';
  const BODY = "# Slice\n\n## Open Questions\n\n- [x] answered — yes\n\n## Notes\n\nnone\n";
  const signed = (hash: string, status = "ready-to-implement") =>
    `---\nschemaVersion: 1\npattern: state-change\nswimlane: orders\nstatus: ${status}\nversion: 1\nratifiedBy: Alex\nratifiedOn: 2026-10-02\nratifiedHash: ${hash}\n---\n${BODY}`;
  const STATE = `${SIX_BULLET_STATE_FILE}\n## Decisions log\n- 2026-01-01: old — why\n\n## Open questions / parking lot\n\n## Slice inventory\n`;
  const QUEUED = "- retry policy (from slice place-order, queued for place-order@v2, until v2, 2026-10-12, by Alex; decision: fail fast)";
  const stepOf = (dir: string, root: string) => detectUpgrade(makeCtx(dir, root)).steps.find((st) => st.id === "ratified-hash-scope")!;

  it("is registered after ratified-signoff and before system-manifest, since 1.19.0 (GH #347: its sinceVersion says 1.19.0)", () => {
    const ids = UPGRADE_STEPS.map((s) => s.id);
    expect(ids.indexOf("ratified-hash-scope")).toBe(ids.indexOf("ratified-signoff") + 1);
    expect(ids.at(-1)).toBe("system-manifest");
    expect(UPGRADE_STEPS.find((s) => s.id === "ratified-hash-scope")!.sinceVersion).toBe("1.19.0");
  });

  it("not applicable when every hash is current and nothing is queued; a mismatched doc alone is reported, never applied", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN, stateFile: STATE });
    mkdirSync(join(dir, "slices"), { recursive: true });
    const docPath = join(dir, "slices", "place-order.md");
    writeFileSync(docPath, signed(sliceDocBodyHash(signed("x"))));
    expect(stepOf(dir, packagedSkillsRoot)).toMatchObject({ applicable: false, reason: "every intact ratifiedHash is in the 1.19 scope and no question is queued in the state file" });
    writeFileSync(docPath, signed(sliceDocBodyHash(signed("x"))).replace("— yes", "— no"));
    // GH #347: a doc matching no scope is listed and left alone.
    expect(stepOf(dir, packagedSkillsRoot)).toMatchObject({
      applicable: false,
      reason: "every intact ratifiedHash is in the 1.19 scope and no question is queued in the state file; left alone: place-order — body no longer matches ratifiedHash in any scope (revert, or em slice revise and re-ratify)",
    });
  });

  it("--apply re-stamps a legacy whole-body hash (same body), in one commit, and a second run is a no-op", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN, stateFile: STATE });
    mkdirSync(join(dir, "slices"), { recursive: true });
    const docPath = join(dir, "slices", "place-order.md");
    const legacy = sliceDocLegacyBodyHash(signed("x"));
    writeFileSync(docPath, signed(legacy));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "doc");
    const d = stepOf(dir, packagedSkillsRoot);
    expect(d.applicable).toBe(true);
    expect(d.reason).toBe("1 doc(s) carry a pre-1.17 whole-body ratifiedHash (body intact): place-order — em upgrade will re-stamp them in the 1.19 scope (authored text only: generated regions and Open Questions deferrals excluded; same body, not a re-signing; ratifiedRef untouched)");
    const result = applyUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const step = result.applied.find((a) => a.id === "ratified-hash-scope")!;
    expect(step.applied).toBe(true);
    expect(step.changedFiles).toEqual([docPath]);
    const text = readFileSync(docPath, "utf8");
    expect(text).toBe(signed(sliceDocBodyHash(signed("x"))));
    const log = spawnSync("git", ["-C", dir, "log", "--format=%s"], { encoding: "utf8" }).stdout;
    expect(log.split("\n").filter((l) => l.startsWith("em upgrade: ratified-hash-scope"))).toHaveLength(1);
    expect(stepOf(dir, packagedSkillsRoot).applicable).toBe(false);
  });

  it("--apply moves a 1.16 queued question into its doc as the deferred item (re-stamping a legacy hash on the way) and drains the queue", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN, stateFile: STATE.replace("## Open questions / parking lot\n", `## Open questions / parking lot\n${QUEUED}\n`) });
    mkdirSync(join(dir, "slices"), { recursive: true });
    const docPath = join(dir, "slices", "place-order.md");
    writeFileSync(docPath, signed(sliceDocLegacyBodyHash(signed("x")), "implemented"));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "doc");
    const d = stepOf(dir, packagedSkillsRoot);
    expect(d.applicable).toBe(true);
    expect(d.reason).toContain("1 question(s) queued in .event-modeling.md by 1.16's em slice defer (GH #236) for place-order@v2");
    const result = applyUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const step = result.applied.find((a) => a.id === "ratified-hash-scope")!;
    expect(step.changedFiles).toEqual([docPath, join(dir, STATE_FILE_NAME)]);
    const text = readFileSync(docPath, "utf8");
    expect(text).toContain("- [x] answered — yes\n- [x] retry policy — v1: fail fast; deferred to v2 (2026-10-12, Alex)\n\n## Notes");
    const hash = /ratifiedHash: (\S+)/.exec(text)![1];
    expect(ratifiedHashScope(text, hash)).toBe("current");
    const state = readFileSync(join(dir, STATE_FILE_NAME), "utf8");
    expect(state).not.toContain("queued for");
    expect(state).toContain("- retry policy (from slice place-order, deferred to v2)");
    expect(stepOf(dir, packagedSkillsRoot).applicable).toBe(false);
  });
});

describe("api-contract-missing step (GH #331)", () => {
  const SRC = 'slice "Place Order" {\n  ui Checkout @Customer\n  command Place Order\n  event Order Placed\n}\n';
  const CONTRACT_REL = join("contracts", "checkout.tsp");

  function repoWithCi(withJob: boolean) {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: SRC });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    let ci = buildCiWorkflowFile("checkout.em", "test", INSTALLED_VERSION);
    if (!withJob) ci = ci.replace(/^ {2}api-check:[\s\S]*?(?=^ {2}slice-index:)/m, "");
    writeFileSync(ciWorkflowPath(dir), ci);
    git(dir, "add", ".github", "checkout.em");
    git(dir, "commit", "-q", "-m", "ci");
    return { dir, packagedSkillsRoot };
  }
  const stepOf = (dir: string, root: string) => detectUpgrade(makeCtx(dir, root)).steps.find((s) => s.id === "api-contract-missing")!;

  it("is detected, applied as its own commit after ci-block, and idempotent", () => {
    const { dir, packagedSkillsRoot } = repoWithCi(true);
    expect(readFileSync(ciWorkflowPath(dir), "utf8")).toContain("api-check:");
    expect(stepOf(dir, packagedSkillsRoot).applicable).toBe(true);
    const ids = UPGRADE_STEPS.map((s) => s.id);
    expect(ids.indexOf("api-contract-missing")).toBe(ids.indexOf("ci-block") + 1);

    const result = applyUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(result.ok).toBe(true);
    const applied = result.ok ? result.applied.find((s) => s.id === "api-contract-missing") : undefined;
    expect(applied?.applied).toBe(true);
    expect(existsSync(join(dir, CONTRACT_REL))).toBe(true);
    const log = spawnSync("git", ["-C", dir, "log", "--format=%s"], { encoding: "utf8" }).stdout;
    expect(log).toContain("api-contract-missing");

    expect(stepOf(dir, packagedSkillsRoot).applicable).toBe(false);
    const again = applyUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(again.ok).toBe(true);
    expect(again.ok ? again.applied.find((s) => s.id === "api-contract-missing")?.applied : undefined).not.toBe(true);
  });

  it("is not detected when there is no generated workflow (and so no api-check job)", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: SRC });
    expect(stepOf(dir, packagedSkillsRoot).applicable).toBe(false);
  });

  it("is not detected when the contract is already present", () => {
    const { dir, packagedSkillsRoot } = repoWithCi(true);
    mkdirSync(join(dir, "contracts"), { recursive: true });
    writeFileSync(join(dir, CONTRACT_REL), "// existing\n");
    expect(stepOf(dir, packagedSkillsRoot).applicable).toBe(false);
  });
});

describe("api-contract-missing step - pre-1.12 workflow, multi-model, blocked (GH #331 round 2)", () => {
  const SRC = 'slice "Place Order" {\n  ui Checkout @Customer\n  command Place Order\n  event Order Placed\n}\n';
  const stepsOf = (dir: string, root: string) => detectUpgrade(makeCtx(dir, root));

  function preApiCheckRepo() {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: SRC });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    // A pre-1.12 workflow: an old pin and no api-check job at all.
    const old = buildCiWorkflowFile("checkout.em", "test", "1.11.0").replace(/^ {2}api-check:[\s\S]*?(?=^ {2}slice-index:)/m, "");
    writeFileSync(ciWorkflowPath(dir), old);
    git(dir, "add", ".github", "checkout.em");
    git(dir, "commit", "-q", "-m", "old ci");
    return { dir, packagedSkillsRoot, old };
  }

  it("dry run lists ci-block and api-contract-missing together; --apply commits them in order; second run is clean", () => {
    const { dir, packagedSkillsRoot, old } = preApiCheckRepo();
    expect(old).not.toContain("api-check:");
    const report = stepsOf(dir, packagedSkillsRoot);
    expect(report.steps.find((s) => s.id === "ci-block")!.applicable).toBe(true);
    expect(report.steps.find((s) => s.id === "api-contract-missing")!.applicable).toBe(true);

    const result = applyUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(result.ok).toBe(true);
    expect(readFileSync(ciWorkflowPath(dir), "utf8")).toContain("api-check:");
    expect(existsSync(join(dir, "contracts", "checkout.tsp"))).toBe(true);
    const subjects = spawnSync("git", ["-C", dir, "log", "--reverse", "--format=%s"], { encoding: "utf8" }).stdout;
    expect(subjects.indexOf("ci-block")).toBeGreaterThan(-1);
    expect(subjects.indexOf("api-contract-missing")).toBeGreaterThan(subjects.indexOf("ci-block", subjects.indexOf("old ci")));

    const after = stepsOf(dir, packagedSkillsRoot);
    expect(after.steps.find((s) => s.id === "ci-block")!.applicable).toBe(false);
    expect(after.steps.find((s) => s.id === "api-contract-missing")!.applicable).toBe(false);
  });

  it("multi-model block: generates every model's contract under its own directory", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: SRC });
    mkdirSync(join(dir, "billing"), { recursive: true });
    writeFileSync(join(dir, "billing", "billing.em"), 'slice "Send Invoice" {\n  command Send Invoice\n  event Invoice Sent\n}\n');
    writeFileSync(join(dir, "system.yaml"), 'systemSchemaVersion: "2.0"\nname: S\nmodels:\n  checkout:\n    source: checkout.em\n  billing:\n    source: billing/billing.em\n');
    const models: CiModel[] = [
      { key: "checkout", path: "checkout.em" },
      { key: "billing", path: "billing/billing.em" },
    ];
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(ciWorkflowPath(dir), buildCiWorkflowFileMulti("system.yaml", models, "test", INSTALLED_VERSION));
    writeFileSync(conformWorkflowPath(dir), buildConformWorkflowFileMulti("system.yaml", models, INSTALLED_VERSION));
    git(dir, "add", ".github", "checkout.em", "billing", "system.yaml");
    git(dir, "commit", "-q", "-m", "multi ci");

    expect(stepsOf(dir, packagedSkillsRoot).steps.find((s) => s.id === "api-contract-missing")!.applicable).toBe(true);
    const result = applyUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(result.ok).toBe(true);
    expect(existsSync(join(dir, "contracts", "checkout.tsp"))).toBe(true);
    expect(existsSync(join(dir, "billing", "contracts", "billing.tsp"))).toBe(true);
    expect(stepsOf(dir, packagedSkillsRoot).steps.find((s) => s.id === "api-contract-missing")!.applicable).toBe(false);
  });

  it("a model with compile errors is not skipped silently: api-contract-blocked names it and the step reason does not claim there is no job", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: OLD_SHAPE_SOURCE });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(ciWorkflowPath(dir), buildCiWorkflowFile("checkout.em", "test", INSTALLED_VERSION));
    git(dir, "add", ".github", "checkout.em");
    git(dir, "commit", "-q", "-m", "ci");
    const report = stepsOf(dir, packagedSkillsRoot);
    const step = report.steps.find((s) => s.id === "api-contract-missing")!;
    expect(step.applicable).toBe(false);
    expect(step.reason).not.toContain("no api-check job lacking");
    expect(step.reason).toContain("checkout.em");
    const item = report.human.find((h) => h.id === "api-contract-blocked");
    expect(item).toBeDefined();
    expect(item!.reason).toContain("checkout.em");
    expect(item!.reason).toContain("compile errors");
    expect(item!.reason).toContain("em validate <model>");
    expect(item!.reason).toContain("em api generate <model>");
  });

  it("a compile-error model whose contract already exists gets no api-contract-blocked item", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: OLD_SHAPE_SOURCE });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(ciWorkflowPath(dir), buildCiWorkflowFile("checkout.em", "test", INSTALLED_VERSION));
    mkdirSync(join(dir, "contracts"), { recursive: true });
    writeFileSync(join(dir, "contracts", "checkout.tsp"), "// existing\n");
    git(dir, "add", ".github", "checkout.em", "contracts");
    git(dir, "commit", "-q", "-m", "ci");
    const report = stepsOf(dir, packagedSkillsRoot);
    expect(report.steps.find((s) => s.id === "api-contract-missing")!.applicable).toBe(false);
    expect(report.human.find((h) => h.id === "api-contract-blocked")).toBeUndefined();
  });

  it("a repo that owns its workflow (markers removed, api-check dropped) leaves ci-block and api-contract-missing not applicable", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: SRC });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    const own = buildCiWorkflowFile("checkout.em", "test", "1.9.0")
      .replace(/^ {2}api-check:[\s\S]*?(?=^ {2}slice-index:)/m, "")
      .split("\n")
      .filter((l) => !l.includes("GENERATED"))
      .join("\n");
    expect(own).not.toContain("GENERATED");
    writeFileSync(ciWorkflowPath(dir), own);
    git(dir, "add", ".github", "checkout.em");
    git(dir, "commit", "-q", "-m", "own ci");
    const report = stepsOf(dir, packagedSkillsRoot);
    expect(report.steps.find((s) => s.id === "ci-block")!.applicable).toBe(false);
    expect(report.steps.find((s) => s.id === "api-contract-missing")!.applicable).toBe(false);
    expect(report.human.find((h) => h.id === "api-contract-blocked")).toBeUndefined();
  });
});

describe("GH #346 - ci preset pull_request paths", () => {
  const CLEAN_SOURCE = 'slice "Place Order" {\n  ui Checkout @Customer\n  command Place Order\n  event Order Placed\n}\n';
  const NEW = [".github/workflows/em-*.yml", "**/.event-modeling.md", ".claude/settings.json", "**/ratifiers.yaml", "**/system.yaml", "**/contracts/**"];
  const legacyOf = (content: string): string => {
    // what 1.18.1 generated: three-entry filter (the header is outside the managed block)
    let out = content;
    for (const p of NEW) out = out.replace(`      - "${p}"\n`, "");
    return out;
  };

  it("fresh em-ci.yml lists the model sources plus workflows, state file, settings, ratifiers, system manifest and contracts (Fix paragraph)", () => {
    const doc = parseYaml(buildCiWorkflowFile("checkout.em", "test", INSTALLED_VERSION)) as { on: { pull_request: { paths: string[] } } };
    expect(doc.on.pull_request.paths).toEqual([...CI_PR_PATHS]);
    for (const p of NEW) expect(doc.on.pull_request.paths).toContain(p);
    const multi = parseYaml(buildCiWorkflowFileMulti("system.yaml", [{ key: "a", path: "a/a.em" }], "test", INSTALLED_VERSION)) as { on: { pull_request: { paths: string[] } } };
    expect(multi.on.pull_request.paths).toEqual([...CI_PR_PATHS]);
  });

  it("refreshCiPullRequestPaths rewrites only the exact legacy list; current and hand-edited filters are untouched", () => {
    const current = buildCiWorkflowFile("checkout.em", "test", INSTALLED_VERSION);
    expect(refreshCiPullRequestPaths(current)).toBeNull();
    const legacy = legacyOf(current);
    expect(legacy).not.toContain(`      - ".claude/settings.json"`);
    expect(refreshCiPullRequestPaths(legacy)).toBe(current);
    expect(refreshCiPullRequestPaths(legacy.replace('"**/README.md"', '"docs/**"'))).toBeNull();
  });

  it("ci-block detects a 1.18.1-shaped workflow as stale and em upgrade writes the new paths (slate: no new step)", () => {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN_SOURCE });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    // same managed block as the installed version, so only the out-of-block filter differs
    writeFileSync(ciWorkflowPath(dir), legacyOf(buildCiWorkflowFile("checkout.em", "test", INSTALLED_VERSION)));
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "add ci workflow");
    const ctx = makeCtx(dir, packagedSkillsRoot);
    expect(detectUpgrade(ctx).steps.find((s) => s.id === "ci-block")!.applicable).toBe(true);
    const result = applyUpgrade(ctx);
    expect(result.ok).toBe(true);
    const updated = readFileSync(ciWorkflowPath(dir), "utf8");
    expect(updated).toBe(buildCiWorkflowFile("checkout.em", "test", INSTALLED_VERSION));
    expect(detectUpgrade(makeCtx(dir, packagedSkillsRoot)).steps.find((s) => s.id === "ci-block")!.applicable).toBe(false);
  });
});

describe("GH #346 round 2 - opt-out, reasons, hand-edited filter, --check parity, multi-model", () => {
  const CLEAN_SOURCE = 'slice "Place Order" {\n  ui Checkout @Customer\n  command Place Order\n  event Order Placed\n}\n';
  const EXTRA = [".github/workflows/em-*.yml", "**/.event-modeling.md", ".claude/settings.json", "**/ratifiers.yaml", "**/system.yaml", "**/contracts/**"];
  const legacyOf = (content: string): string => {
    let out = content;
    for (const p of EXTRA) out = out.replace(`      - "${p}"\n`, "");
    return out;
  };
  function repoWithCi(content: string): { dir: string; packagedSkillsRoot: string } {
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN_SOURCE });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(ciWorkflowPath(dir), content);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "add ci workflow");
    return { dir, packagedSkillsRoot };
  }
  const stepOf = (dir: string, root: string) => detectUpgrade(makeCtx(dir, root)).steps.find((s) => s.id === "ci-block")!;

  it("contracts glob is nested (contractPathFor resolves relative to the model dir)", () => {
    expect(CI_PR_PATHS).toContain("**/contracts/**");
    expect(CI_PR_PATHS).not.toContain("contracts/**");
  });

  it("markers removed + legacy filter: not applicable and --apply writes nothing (opt-out respected)", () => {
    const current = buildCiWorkflowFile("checkout.em", "test", INSTALLED_VERSION);
    const optedOut = legacyOf(current).replace(/^.*GENERATED:.*\n/gm, "");
    expect(optedOut).not.toContain("GENERATED:");
    const { dir, packagedSkillsRoot } = repoWithCi(optedOut);
    expect(stepOf(dir, packagedSkillsRoot).applicable).toBe(false);
    applyUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(readFileSync(ciWorkflowPath(dir), "utf8")).toBe(optedOut);
  });

  it("reason names the filter when only the filter is legacy, and keeps the old wording when the block is stale", () => {
    const current = buildCiWorkflowFile("checkout.em", "test", INSTALLED_VERSION);
    const a = repoWithCi(legacyOf(current));
    expect(stepOf(a.dir, a.packagedSkillsRoot).reason).toBe("em-ci.yml pull_request paths filter is the pre-1.19.0 list");
    const b = repoWithCi(legacyOf(buildCiWorkflowFile("checkout.em", "test", "1.9.0")));
    expect(stepOf(b.dir, b.packagedSkillsRoot).reason).toBe("generated CI block(s) are stale");
  });

  it("hand-edited filter missing preset entries: untouched, human item ci-paths-hand-edited lists the missing ones", () => {
    const edited = buildCiWorkflowFile("checkout.em", "test", INSTALLED_VERSION).replace('      - "**/README.md"\n', '      - "docs/**"\n');
    const { dir, packagedSkillsRoot } = repoWithCi(edited);
    expect(stepOf(dir, packagedSkillsRoot).applicable).toBe(false);
    const item = detectHumanItems(makeCtx(dir, packagedSkillsRoot)).find((h) => h.id === "ci-paths-hand-edited");
    expect(item?.reason).toContain('"**/README.md"');
    expect(item?.reason).not.toContain('"**/*.em"');
    expect(readFileSync(ciWorkflowPath(dir), "utf8")).toBe(edited);
    const ok = repoWithCi(buildCiWorkflowFile("checkout.em", "test", INSTALLED_VERSION));
    expect(detectHumanItems(makeCtx(ok.dir, ok.packagedSkillsRoot)).find((h) => h.id === "ci-paths-hand-edited")).toBeUndefined();
  });

  it("em ci init --check reports the legacy filter as drift (parity with em upgrade)", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const pkgVersion = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
    const run = (dir: string) =>
      spawnSync(process.execPath, [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "src", "cli.ts"), "ci", "init", "checkout.em", "--check"], { cwd: dir, encoding: "utf8" });
    const current = repoWithCi(buildCiWorkflowFile("checkout.em", "test", pkgVersion));
    expect(run(current.dir).stdout).toMatch(/ok: .*em-ci\.yml/);
    const legacy = repoWithCi(legacyOf(buildCiWorkflowFile("checkout.em", "test", pkgVersion)));
    const bad = run(legacy.dir);
    expect(bad.stdout).toContain("pre-1.19.0 list");
    expect(bad.status).not.toBe(0);
  });

  it("multi-model workflow through ci-block: legacy filter detected and rewritten", () => {
    const models: CiModel[] = [{ key: "checkout", path: "checkout.em" }, { key: "billing", path: "billing/billing.em" }];
    const manifest = 'systemSchemaVersion: "2.0"\nname: S\nmodels:\n  checkout:\n    source: checkout.em\n  billing:\n    source: billing/billing.em\n';
    const current = buildCiWorkflowFileMulti("system.yaml", models, "test", INSTALLED_VERSION);
    const { dir, packagedSkillsRoot } = makeFixtureRepo({ source: CLEAN_SOURCE });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(ciWorkflowPath(dir), legacyOf(current));
    writeFileSync(join(dir, "system.yaml"), manifest);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "add multi ci");
    expect(stepOf(dir, packagedSkillsRoot).applicable).toBe(true);
    applyUpgrade(makeCtx(dir, packagedSkillsRoot));
    expect(readFileSync(ciWorkflowPath(dir), "utf8")).toBe(current);
  });
});

describe("GH #346 round 3 - em ci init applies the filter refresh; comment-tolerant parsing", () => {
  const CLEAN_SOURCE = 'slice "Place Order" {\n  ui Checkout @Customer\n  command Place Order\n  event Order Placed\n}\n';
  const EXTRA = [".github/workflows/em-*.yml", "**/.event-modeling.md", ".claude/settings.json", "**/ratifiers.yaml", "**/system.yaml", "**/contracts/**"];
  const legacyOf = (content: string): string => {
    let out = content;
    for (const p of EXTRA) out = out.replace(`      - "${p}"\n`, "");
    return out;
  };
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const pkgVersion = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
  const em = (dir: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "src", "cli.ts"), "ci", "init", "checkout.em", ...args], { cwd: dir, encoding: "utf8" });

  it("legacy workflow: em ci init rewrites the filter, --check then exits 0, a second run says already up to date", () => {
    const { dir } = makeFixtureRepo({ source: CLEAN_SOURCE });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(ciWorkflowPath(dir), legacyOf(buildCiWorkflowFile("checkout.em", "test", pkgVersion)));
    expect(em(dir, "--check").status).not.toBe(0);
    const first = em(dir);
    expect(first.stdout).toContain("pull_request paths filter updated to the 1.19.0 list");
    expect(readFileSync(ciWorkflowPath(dir), "utf8")).toBe(buildCiWorkflowFile("checkout.em", "test", pkgVersion));
    const check = em(dir, "--check");
    expect(check.stdout).toMatch(/ok: .*em-ci\.yml/);
    expect(check.stdout).not.toContain("stale");
    expect(em(dir).stdout).toMatch(/em-ci\.yml already up to date/);
  });

  it("markers removed + legacy filter: em ci init leaves the file untouched", () => {
    const { dir } = makeFixtureRepo({ source: CLEAN_SOURCE });
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    const optedOut = legacyOf(buildCiWorkflowFile("checkout.em", "test", pkgVersion)).replace(/^.*GENERATED:.*\n/gm, "");
    writeFileSync(ciWorkflowPath(dir), optedOut);
    em(dir);
    expect(readFileSync(ciWorkflowPath(dir), "utf8")).toBe(optedOut);
  });

  it("missingCiPullRequestPaths tolerates trailing YAML comments on entries", () => {
    const commented = buildCiWorkflowFile("checkout.em", "test", pkgVersion).replace('      - "**/README.md"\n', '      - "**/README.md" # docs\n');
    expect(missingCiPullRequestPaths(commented)).toEqual([]);
  });
});
