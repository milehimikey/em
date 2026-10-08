// SPDX-License-Identifier: MIT
// Coverage for `em ci init`'s pure plumbing (src/cli/ciInit.ts, MIL-166): from-scratch content,
// the marker-delimited patch/idempotent/stale/missing-markers/force matrix (planCiFile), and the
// shell-injection guard. CLI-level coverage (real fs, `em ci init` end to end) lives in
// test/cli.test.ts, matching test/agentsMd.test.ts (pure) / test/cli.test.ts's AGENTS.md block
// (CLI) split for the marker-delimited AGENTS.md section this reuses the same convention from.
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  buildCiWorkflowFile,
  buildConformWorkflowFile,
  ciManagedBody,
  conformManagedBody,
  managedBlockModels,
  buildCiWorkflowFileMulti,
  buildConformWorkflowFileMulti,
  ciManagedBodyMulti,
  conformManagedBodyMulti,
  ciJobIds,
  ciModelsFromManifest,
  describeSetChange,
  fileBlockModels,
  type CiModel,
  planCiFile,
  applyCiFile,
  findUnsafeCiInitArg,
  CI_WORKFLOW_MARKER,
  CONFORM_WORKFLOW_MARKER,
} from "../src/cli/ciInit.js";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// MIL-205: the `em ci init <system.yaml>` CLI tests below spawn the real CLI (several spawns each,
// ~5-6 s cold on a GitHub runner), past vitest's 5 s default. File-level timeout, as test/cli.test.ts.
vi.setConfig({ testTimeout: 20_000 });

describe("buildCiWorkflowFile", () => {
  const content = buildCiWorkflowFile("order-fulfillment/order-fulfillment.em", "test", "1.9.0");

  it("names the workflow and wires the PR-triggered gate jobs plus a push-triggered badge job", () => {
    expect(content).toContain("name: em ci");
    expect(content).toContain("on:\n  pull_request:");
    expect(content).toContain("push:\n    branches: [main]");
    for (const job of ["validate:", "api-check:", "slice-index:", "coverage:", "ledger:", "skill-check:", "upgrade-check:", "glossary:", "status-badge:"]) {
      expect(content).toContain(`\n  ${job}\n`);
    }
  });

  it("embeds the model path and tests dir into the right commands", () => {
    expect(content).toContain('npx @milehimikey/em@1.9.0 slice index "order-fulfillment/order-fulfillment.em" --check');
    expect(content).toContain('npx @milehimikey/em@1.9.0 coverage "order-fulfillment/order-fulfillment.em" --tests "test" --strict');
    expect(content).toContain('npx @milehimikey/em@1.9.0 ledger "order-fulfillment/order-fulfillment.em" --from');
    expect(content).toContain('npx @milehimikey/em@1.9.0 status "order-fulfillment/order-fulfillment.em" --tests "test" --badge -o status-badge.svg');
    expect(content).toContain('npx @milehimikey/em@1.9.0 upgrade "order-fulfillment/order-fulfillment.em" --check');
  });

  it("wires `em api check --base` on the PR base sha right after validate (MIL-237), with full history", () => {
    expect(content).toContain(
      '          base="${{ github.event.pull_request.base.sha }}"\n' +
        '          npx @milehimikey/em@1.9.0 api check "order-fulfillment/order-fulfillment.em" --base "$base"\n',
    );
    expect(content.indexOf("\n  api-check:\n")).toBeGreaterThan(content.indexOf("\n  validate:\n"));
    expect(content.indexOf("\n  api-check:\n")).toBeLessThan(content.indexOf("\n  slice-index:\n"));
    expect(content).toMatch(/\n {2}api-check:\n(?:.*\n)*? {10}fetch-depth: 0\n/);
  });

  it("gates validate/slice-index/coverage/ledger/skill-check/upgrade-check/glossary on pull_request, and status-badge on push only", () => {
    const gateJobs = ["validate", "api-check", "slice-index", "coverage", "ledger", "skill-check", "upgrade-check", "glossary"];
    for (const job of gateJobs) {
      const re = new RegExp(`\\n  ${job}:\\n(?:.*\\n)*?    if: github\\.event_name == 'pull_request'`);
      expect(content).toMatch(re);
    }
    expect(content).toMatch(/\n {2}status-badge:\n(?:.*\n)*? {4}if: github\.event_name == 'push'/);
  });

  it("wraps the managed block in hash-style GENERATED:em-ci markers at column 0", () => {
    expect(content).toContain(`\n# GENERATED:${CI_WORKFLOW_MARKER}:start\n`);
    expect(content).toContain(`\n# GENERATED:${CI_WORKFLOW_MARKER}:end\n`);
  });

  it("is a pure function of its arguments — same inputs, byte-identical output", () => {
    expect(buildCiWorkflowFile("order-fulfillment/order-fulfillment.em", "test", "1.9.0")).toBe(content);
  });

  it("states in its own header that the file is generated once and owned by the repo after that", () => {
    expect(content).toContain("This file is yours from here: edit it, add jobs, remove ones you don't want.");
  });
});

describe("buildConformWorkflowFile", () => {
  const content = buildConformWorkflowFile("order-fulfillment/order-fulfillment.em", "1.9.0");

  it("names the workflow, schedules it, and never advances the state file's Last conformance marker", () => {
    expect(content).toContain("name: model-conformance");
    expect(content).toContain('cron: "0 6 * * 1"');
    expect(content).toContain("workflow_dispatch");
    // Advisory-only, stated explicitly in the header — this job never writes the state file.
    expect(content).toContain("never fails the build on drift");
    expect(content).toContain("only advances when a human ratifies");
  });

  it("points MODEL_DIR at the model file's own directory", () => {
    expect(content).toContain("MODEL_DIR: order-fulfillment");
  });

  it("wraps the managed block in hash-style GENERATED:em-conform markers", () => {
    expect(content).toContain(`\n# GENERATED:${CONFORM_WORKFLOW_MARKER}:start\n`);
    expect(content).toContain(`\n# GENERATED:${CONFORM_WORKFLOW_MARKER}:end\n`);
  });

  it("defaults MODEL_DIR to '.' for a model file at the repo root", () => {
    const rootContent = buildConformWorkflowFile("model.em", "1.9.0");
    expect(rootContent).toContain("MODEL_DIR: .");
  });
});

describe("findUnsafeCiInitArg", () => {
  it("flags '\"', backtick, '$', and newline — the shell-injection-relevant characters", () => {
    expect(findUnsafeCiInitArg('model".em')).toBe('model".em');
    expect(findUnsafeCiInitArg("model`.em")).toBe("model`.em");
    expect(findUnsafeCiInitArg("model$(rm -rf).em")).toBe("model$(rm -rf).em");
    expect(findUnsafeCiInitArg("model\n.em")).toBe("model\n.em");
  });

  it("passes an ordinary relative path through", () => {
    expect(findUnsafeCiInitArg("order-fulfillment/order-fulfillment.em")).toBeNull();
  });
});

describe("planCiFile / applyCiFile", () => {
  function tmpFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "em-ci-init-"));
    return join(dir, "em-ci.yml");
  }

  const generated = buildCiWorkflowFile("model.em", "test", "1.9.0");
  const body = ciManagedBody("model.em", "test", "1.9.0");

  it("plans 'create' for a missing file", () => {
    const path = tmpFile();
    try {
      const status = planCiFile(path, generated, body, CI_WORKFLOW_MARKER, false);
      expect(status).toEqual({ kind: "create", content: generated });
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("applyCiFile writes 'create', and re-planning the same inputs is 'ok' (idempotent)", () => {
    const path = tmpFile();
    try {
      const first = planCiFile(path, generated, body, CI_WORKFLOW_MARKER, false);
      applyCiFile(path, first);
      expect(readFileSync(path, "utf8")).toBe(generated);

      const second = planCiFile(path, generated, body, CI_WORKFLOW_MARKER, false);
      expect(second.kind).toBe("ok");
      applyCiFile(path, second); // a no-op write for "ok" — must not touch the file
      expect(readFileSync(path, "utf8")).toBe(generated);
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("plans 'stale' when the managed body changed, and preserves content the repo added around the markers", () => {
    const path = tmpFile();
    try {
      applyCiFile(path, planCiFile(path, generated, body, CI_WORKFLOW_MARKER, false));

      const withCustomJob = readFileSync(path, "utf8").replace(
        "jobs:\n",
        "jobs:\n  my-custom-job:\n    runs-on: ubuntu-latest\n    steps: []\n\n",
      );
      writeFileSync(path, withCustomJob, "utf8");

      const newBody = ciManagedBody("model.em", "other-tests", "1.9.0");
      const status = planCiFile(path, generated, newBody, CI_WORKFLOW_MARKER, false);
      expect(status.kind).toBe("stale");
      if (status.kind !== "stale") throw new Error("unreachable");
      expect(status.content).toContain("my-custom-job");
      expect(status.content).toContain('--tests "other-tests"');
      applyCiFile(path, status);
      const onDisk = readFileSync(path, "utf8");
      expect(onDisk).toContain("my-custom-job");
      expect(onDisk).toContain('--tests "other-tests"');
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("plans 'missing-markers' (and refuses to write) for a pre-existing file with no marker pair", () => {
    const path = tmpFile();
    try {
      writeFileSync(path, "name: my-hand-written-ci\n", "utf8");
      const status = planCiFile(path, generated, body, CI_WORKFLOW_MARKER, false);
      expect(status).toEqual({ kind: "missing-markers" });
      applyCiFile(path, status); // must be a no-op
      expect(readFileSync(path, "utf8")).toBe("name: my-hand-written-ci\n");
    } finally {
      rmSync(path, { force: true });
    }
  });

  it("plans 'would-replace' for the same file when force is true, and applying it overwrites wholesale", () => {
    const path = tmpFile();
    try {
      writeFileSync(path, "name: my-hand-written-ci\n", "utf8");
      const status = planCiFile(path, generated, body, CI_WORKFLOW_MARKER, true);
      expect(status).toEqual({ kind: "would-replace", content: generated });
      applyCiFile(path, status);
      expect(readFileSync(path, "utf8")).toBe(generated);
    } finally {
      rmSync(path, { force: true });
    }
  });
});

// ---- MIL-256 (#173): generated workflows are lint-clean and ASCII-only ----

type Job = { steps?: Array<{ name?: string; run?: string }> };

/** Every `run:` script in a generated workflow, parsed from the YAML rather than regex-scraped. */
function runScripts(content: string): Array<{ job: string; step: string; script: string }> {
  const doc = parseYaml(content) as { jobs: Record<string, Job> };
  const out: Array<{ job: string; step: string; script: string }> = [];
  for (const [job, def] of Object.entries(doc.jobs)) {
    for (const step of def.steps ?? []) {
      if (typeof step.run === "string") out.push({ job, step: step.name ?? "", script: step.run });
    }
  }
  return out;
}

/** actionlint (and GitHub) evaluate `${{ ... }}` before the shell sees the script; mirror that
 *  with a plain word so shellcheck lints the shell, not the expression syntax. */
function neutralizeExpressions(script: string): string {
  return script.replace(/\$\{\{[^}]*\}\}/g, "EXPR");
}

function onPath(cmd: string): boolean {
  return !spawnSync(cmd, ["--version"], { encoding: "utf8" }).error;
}

const SYSTEM_MODELS: CiModel[] = [
  { key: "checkout", path: "models/checkout/checkout.em" },
  { key: "fulfillment", path: "models/fulfillment/fulfillment.em" },
  { key: "storefront", path: "storefront.em" },
  { key: "orders~2", path: "legacy/orders.em" },
];

const generatedFiles: Array<[string, string]> = [
  ["em-ci.yml", buildCiWorkflowFile("orders/orders.em", "test", "1.13.0")],
  ["em-conform.yml", buildConformWorkflowFile("orders/orders.em", "1.13.0")],
  // MIL-233: the multi-model output goes through every lint below too.
  ["em-ci.yml (multi-model)", buildCiWorkflowFileMulti("system.yaml", SYSTEM_MODELS, "test", "1.13.0")],
  ["em-conform.yml (multi-model)", buildConformWorkflowFileMulti("system.yaml", SYSTEM_MODELS, "1.13.0")],
];

describe("generated workflows are lint-clean (MIL-256, #173)", () => {
  for (const [name, content] of generatedFiles) {
    it(`${name} is ASCII-only`, () => {
      // eslint-disable-next-line no-control-regex
      expect(content.match(/[^\x00-\x7F]/g)).toBeNull();
    });

    it(`${name}: no run: script has a backtick inside a double-quoted string (SC2006-style command substitution)`, () => {
      const scripts = runScripts(content);
      expect(scripts.length).toBeGreaterThan(0);
      for (const { script } of scripts) {
        for (const quoted of neutralizeExpressions(script).match(/"(?:[^"\\]|\\.)*"/g) ?? []) {
          expect(quoted).not.toContain("`");
        }
      }
    });
  }

  it.skipIf(!onPath("shellcheck"))("every generated run: script passes shellcheck at the default severity", () => {
    for (const [name, content] of generatedFiles) {
      for (const { job, step, script } of runScripts(content)) {
        const r = spawnSync("shellcheck", ["--shell=bash", "-"], { input: neutralizeExpressions(script), encoding: "utf8" });
        expect(r.stdout, `${name} ${job} / ${step}`).toBe("");
        expect(r.status, `${name} ${job} / ${step}`).toBe(0);
      }
    }
  });

  it.skipIf(!onPath("actionlint"))("actionlint accepts both generated workflow files", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-ci-actionlint-"));
    try {
      for (const [name, content] of generatedFiles) {
        const path = join(dir, name.replace(/ \(multi-model\)/, "-multi"));
        writeFileSync(path, content, "utf8");
        const r = spawnSync("actionlint", [path], { encoding: "utf8" });
        expect(r.stdout, name).toBe("");
        expect(r.status, name).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- MIL-256 (#174) + MIL-233: block identity is the SET of models ----

describe("block identity (MIL-256, MIL-233, #174)", () => {
  function setup(): { ci: string; conform: string } {
    const dir = mkdtempSync(join(tmpdir(), "em-ci-guard-"));
    return { ci: join(dir, "em-ci.yml"), conform: join(dir, "em-conform.yml") };
  }
  const gen = (model: string, ver = "1.14.0") => ({
    ci: [buildCiWorkflowFile(model, "test", ver), ciManagedBody(model, "test", ver)] as const,
    conform: [buildConformWorkflowFile(model, ver), conformManagedBody(model, ver)] as const,
  });
  const A: CiModel = { key: "orders", path: "orders/orders.em" };
  const B: CiModel = { key: "billing", path: "billing/billing.em" };
  const C: CiModel = { key: "shipping", path: "shipping/shipping.em" };
  const genMulti = (models: CiModel[], ver = "1.14.0") => ({
    ci: [buildCiWorkflowFileMulti("system.yaml", models, "test", ver), ciManagedBodyMulti(models, "test", ver)] as const,
    conform: [buildConformWorkflowFileMulti("system.yaml", models, ver), conformManagedBodyMulti(models, ver)] as const,
  });

  it("derives the model set from the block content, ignoring the version pin", () => {
    expect(managedBlockModels(CI_WORKFLOW_MARKER, ciManagedBody("orders/orders.em", "test", "1.13.0"))).toEqual(["orders/orders.em"]);
    expect(managedBlockModels(CI_WORKFLOW_MARKER, ciManagedBody("orders/orders.em", "test", "9.9.9"))).toEqual(["orders/orders.em"]);
    expect(managedBlockModels(CONFORM_WORKFLOW_MARKER, conformManagedBody("orders/orders.em", "1.13.0"))).toEqual(["orders"]);
  });

  it("derives every model of a multi-model block (em-ci: per-model slice index lines; em-conform: matrix entries)", () => {
    expect(managedBlockModels(CI_WORKFLOW_MARKER, ciManagedBodyMulti([A, B], "test", "1.14.0"))).toEqual(["billing/billing.em", "orders/orders.em"]);
    expect(managedBlockModels(CONFORM_WORKFLOW_MARKER, conformManagedBodyMulti([A, B], "1.14.0"))).toEqual(["billing", "orders"]);
    // A hand-edited flow-style matrix is read too; MODEL_DIR: ${{ matrix.model }} is not a model.
    const flow = "    strategy:\n      matrix:\n        model: [a, \"b/c\"]\n    env:\n      MODEL_DIR: ${{ matrix.model }}";
    expect(managedBlockModels(CONFORM_WORKFLOW_MARKER, flow)).toEqual(["a", "b/c"]);
    expect(managedBlockModels(CONFORM_WORKFLOW_MARKER, "    env:\n      MODEL_DIR: ${{ matrix.model }}")).toEqual([]);
  });

  it("refuses a disjoint model in em-ci.yml, naming the original, and leaves the file untouched", () => {
    const { ci } = setup();
    writeFileSync(ci, gen("orders/orders.em").ci[0], "utf8");
    const before = readFileSync(ci, "utf8");
    const status = planCiFile(ci, ...gen("billing/billing.em").ci, CI_WORKFLOW_MARKER, false);
    expect(status).toEqual({ kind: "other-models", previous: ["orders/orders.em"], requested: ["billing/billing.em"], narrowing: false });
    applyCiFile(ci, status);
    expect(readFileSync(ci, "utf8")).toBe(before);
  });

  it("refuses a disjoint model in em-conform.yml (named by its directory)", () => {
    const { conform } = setup();
    writeFileSync(conform, gen("orders/orders.em").conform[0], "utf8");
    const status = planCiFile(conform, ...gen("billing/billing.em").conform, CONFORM_WORKFLOW_MARKER, false);
    expect(status).toEqual({ kind: "other-models", previous: ["orders"], requested: ["billing"], narrowing: false });
  });

  it("a disjoint SET (manifest form) is refused too, and --force replaces it and retargets the header", () => {
    const { ci } = setup();
    writeFileSync(ci, genMulti([A, B]).ci[0].replace("jobs:\n", "jobs:\n  mine:\n    runs-on: ubuntu-latest\n    steps: []\n\n"), "utf8");
    const disjoint = [{ key: "x", path: "x/x.em" }, { key: "y", path: "y/y.em" }];
    const refused = planCiFile(ci, ...genMulti(disjoint).ci, CI_WORKFLOW_MARKER, false, true);
    expect(refused).toEqual({ kind: "other-models", previous: ["billing/billing.em", "orders/orders.em"], requested: ["x/x.em", "y/y.em"], narrowing: false });
    const status = planCiFile(ci, ...genMulti(disjoint).ci, CI_WORKFLOW_MARKER, true, true);
    expect(status.kind).toBe("replace-models");
    applyCiFile(ci, status);
    const after = readFileSync(ci, "utf8");
    expect(after).toContain("slice-index-x:");
    expect(after).not.toContain("orders/orders.em");
    expect(after).toContain("  mine:");
  });

  it("--force over another model retargets the generated header, keeping the repo's own jobs", () => {
    const { ci } = setup();
    writeFileSync(ci, gen("orders/orders.em").ci[0].replace("jobs:\n", "jobs:\n  mine:\n    runs-on: ubuntu-latest\n    steps: []\n\n"), "utf8");
    const status = planCiFile(ci, ...gen("billing/billing.em").ci, CI_WORKFLOW_MARKER, true);
    expect(status.kind).toBe("replace-models");
    applyCiFile(ci, status);
    const after = readFileSync(ci, "utf8");
    expect(after).toContain('slice index "billing/billing.em" --check');
    expect(after).not.toContain("orders/orders.em");
    expect(after).toContain("em ci init billing/billing.em");
    expect(after).toContain("  mine:");
  });

  it("superset, subset and overlap (manifest form) regenerate for the requested set - never a refusal", () => {
    const { ci, conform } = setup();
    for (const [existing, requested] of [
      [[A], [A, B]], // superset: a model was added
      [[A, B], [A]], // subset: a model was removed from the manifest
      [[A, B], [B, C]], // overlap
    ] as Array<[CiModel[], CiModel[]]>) {
      writeFileSync(ci, genMulti(existing).ci[0], "utf8");
      const status = planCiFile(ci, ...genMulti(requested).ci, CI_WORKFLOW_MARKER, false, true);
      expect(status.kind).toBe("stale");
      applyCiFile(ci, status);
      expect(readFileSync(ci, "utf8")).toBe(genMulti(requested).ci[0]);

      writeFileSync(conform, genMulti(existing).conform[0], "utf8");
      const cstatus = planCiFile(conform, ...genMulti(requested).conform, CONFORM_WORKFLOW_MARKER, false, true);
      expect(cstatus.kind).toBe("stale");
      applyCiFile(conform, cstatus);
      expect(readFileSync(conform, "utf8")).toBe(genMulti(requested).conform[0]);
    }
  });

  it("a single-model argument never silently narrows a multi-model block (needs --force), in both files", () => {
    const { ci, conform } = setup();
    writeFileSync(ci, genMulti([A, B]).ci[0], "utf8");
    writeFileSync(conform, genMulti([A, B]).conform[0], "utf8");
    const ciBefore = readFileSync(ci, "utf8");
    const ciStatus = planCiFile(ci, ...gen("orders/orders.em").ci, CI_WORKFLOW_MARKER, false);
    expect(ciStatus).toEqual({ kind: "other-models", previous: ["billing/billing.em", "orders/orders.em"], requested: ["orders/orders.em"], narrowing: true });
    applyCiFile(ci, ciStatus);
    expect(readFileSync(ci, "utf8")).toBe(ciBefore);
    const conformStatus = planCiFile(conform, ...gen("orders/orders.em").conform, CONFORM_WORKFLOW_MARKER, false);
    expect(conformStatus).toEqual({ kind: "other-models", previous: ["billing", "orders"], requested: ["orders"], narrowing: true });
    expect(planCiFile(ci, ...gen("orders/orders.em").ci, CI_WORKFLOW_MARKER, true).kind).toBe("replace-models");
  });

  it("the same manifest re-run is idempotent ('ok')", () => {
    const { ci } = setup();
    writeFileSync(ci, genMulti([A, B]).ci[0], "utf8");
    expect(planCiFile(ci, ...genMulti([B, A]).ci, CI_WORKFLOW_MARKER, false, true).kind).toBe("ok"); // manifest order is irrelevant
  });

  it("the same model still updates as 'stale' - an old pin or old non-ASCII text is not a different model", () => {
    const { ci } = setup();
    // A block as em 1.13.0 wrote it: older pin, an em dash in a job name.
    const old = gen("orders/orders.em", "1.13.0").ci[0].replace("rebuild status badge (advisory - publish", "rebuild status badge (advisory — publish");
    writeFileSync(ci, old, "utf8");
    const status = planCiFile(ci, ...gen("orders/orders.em", "1.14.0").ci, CI_WORKFLOW_MARKER, false);
    expect(status.kind).toBe("stale");
  });

  it("a block with no recognizable model (hand-edited) is treated as the same model, not refused", () => {
    const { ci } = setup();
    const edited = gen("orders/orders.em").ci[0].replace(/slice index "[^"]*" --check/, "slice index --check");
    writeFileSync(ci, edited, "utf8");
    expect(planCiFile(ci, ...gen("billing/billing.em").ci, CI_WORKFLOW_MARKER, false).kind).toBe("stale");
  });

  it("fileBlockModels / describeSetChange name what a --check should say about a stale set", () => {
    const prev = fileBlockModels(genMulti([A, B]).ci[0], CI_WORKFLOW_MARKER);
    const next = fileBlockModels(genMulti([B, C]).ci[0], CI_WORKFLOW_MARKER);
    expect(describeSetChange(prev, next)).toBe("no section for shipping/shipping.em; section for orders/orders.em is not in the manifest");
    expect(describeSetChange(prev, prev)).toBeNull();
  });
});

// ---- MIL-233: the multi-model generators ----

describe("multi-model workflow generation (MIL-233, #174)", () => {
  const models: CiModel[] = [
    { key: "fulfillment", path: "models/fulfillment/fulfillment.em" },
    { key: "checkout", path: "models/checkout/checkout.em" },
  ];
  const content = buildCiWorkflowFileMulti("system.yaml", models, "test", "1.14.0");
  const doc = parseYaml(content) as { jobs: Record<string, { if?: string; steps: Array<{ run?: string }> }> };

  it("emits per-model jobs for every model and shared glossary/skill-check once, in key order", () => {
    expect(Object.keys(doc.jobs)).toEqual([
      ...["checkout", "fulfillment"].flatMap((k) => ["validate", "api-check", "slice-index", "coverage", "ledger", "upgrade-check", "status-badge"].map((j) => `${j}-${k}`)),
      "skill-check",
      "glossary",
    ]);
  });

  it("each model's jobs point at that model's own path; badge path is under the model directory; badge is push-only", () => {
    const run = (job: string) => doc.jobs[job].steps.map((s) => s.run ?? "").join("\n");
    expect(run("api-check-checkout")).toContain('npx @milehimikey/em@1.14.0 api check "models/checkout/checkout.em" --base "$base"');
    expect(doc.jobs["api-check-fulfillment"].if).toBe("github.event_name == 'pull_request'");
    expect(run("slice-index-checkout")).toContain('npx @milehimikey/em@1.14.0 slice index "models/checkout/checkout.em" --check');
    expect(run("coverage-fulfillment")).toContain('coverage "models/fulfillment/fulfillment.em" --tests "test" --strict');
    expect(run("ledger-checkout")).toContain('ledger "models/checkout/checkout.em" --from');
    expect(run("upgrade-check-fulfillment")).toContain('upgrade "models/fulfillment/fulfillment.em" --check');
    expect(run("status-badge-checkout")).toContain('-o "models/checkout/status-badge.svg"');
    expect(run("validate-checkout")).toContain('-- "models/checkout/*.em"');
    expect(doc.jobs["status-badge-checkout"].if).toBe("github.event_name == 'push'");
    expect(doc.jobs["validate-checkout"].if).toBe("github.event_name == 'pull_request'");
    for (const line of content.split("\n").filter((l) => l.includes("npx "))) expect(line).toContain("@milehimikey/em@1.14.0");
  });

  it("is a pure function of the model SET - manifest order does not matter, markers sit at column 0", () => {
    expect(buildCiWorkflowFileMulti("system.yaml", [...models].reverse(), "test", "1.14.0")).toBe(content);
    expect(content).toContain("\n# GENERATED:em-ci:start\n");
    expect(content).toContain("\n# GENERATED:em-ci:end\n");
    expect(content).toContain("`em ci init system.yaml`");
  });

  it("a model at the repo root validates '*.em' and writes status-badge.svg at the root", () => {
    const root = ciManagedBodyMulti([{ key: "model", path: "model.em" }], "test", "1.14.0");
    expect(root).toContain("-- '*.em')");
    expect(root).toContain('-o "status-badge.svg"');
  });

  it("em-conform.yml fans the one conform job over a matrix of model directories", () => {
    const conform = parseYaml(buildConformWorkflowFileMulti("system.yaml", models, "1.14.0")) as {
      jobs: { conform: { strategy: { "fail-fast": boolean; matrix: { model: string[] } }; env: { MODEL_DIR: string } } };
    };
    expect(conform.jobs.conform.strategy.matrix.model).toEqual(["models/checkout", "models/fulfillment"]);
    expect(conform.jobs.conform.env.MODEL_DIR).toBe("${{ matrix.model }}");
  });

  it("job ids are valid Actions ids; '~2' collision keys are sanitized deterministically", () => {
    const ids = ciJobIds(["orders", "orders~2", "orders-2", "a~3"]);
    expect(Object.fromEntries(ids)).toEqual({ "a~3": "a-3", orders: "orders", "orders-2": "orders-2", "orders~2": "orders-2-2" });
    // order of input never changes the mapping
    expect(Object.fromEntries(ciJobIds(["a~3", "orders~2", "orders-2", "orders"]))).toEqual(Object.fromEntries(ids));
    const body = ciManagedBodyMulti([{ key: "orders", path: "o/orders.em" }, { key: "orders~2", path: "p/orders.em" }], "test", "1.14.0");
    const jobs = Object.keys((parseYaml(`jobs:\n${body}`) as { jobs: object }).jobs);
    for (const j of jobs) expect(j).toMatch(/^[A-Za-z_][A-Za-z0-9_-]*$/);
    expect(new Set(jobs).size).toBe(jobs.length);
    expect(jobs).toContain("validate-orders-2");
  });
});

describe("ciModelsFromManifest (MIL-233)", () => {
  function repo(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "em-ci-manifest-"));
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), text, "utf8");
    }
    return dir;
  }
  const MANIFEST = 'systemSchemaVersion: "2.0"\nname: S\nmodels:\n  b:\n    source: models/b/b.em\n  a:\n    source: models/a/a.em\n';

  it("reads a manifest file or its directory; paths are repo-root relative, in manifest order", () => {
    const dir = repo({ "system.yaml": MANIFEST });
    try {
      const expected = [{ key: "b", path: "models/b/b.em" }, { key: "a", path: "models/a/a.em" }];
      for (const target of [join(dir, "system.yaml"), dir]) {
        const r = ciModelsFromManifest(target, dir);
        expect(r).toMatchObject({ ok: true, models: expected });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolves sources relative to the manifest, not the working directory", () => {
    const dir = repo({ "estate/system.yaml": MANIFEST });
    try {
      const r = ciModelsFromManifest(join(dir, "estate"), dir);
      expect(r).toMatchObject({ ok: true, models: [{ key: "b", path: "estate/models/b/b.em" }, { key: "a", path: "estate/models/a/a.em" }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses unreadable and invalid manifests, non-.em sources, sources outside the repo, and unsafe paths", () => {
    const dir = repo({
      "bad/system.yaml": "not: [a manifest",
      "json/system.yaml": 'systemSchemaVersion: "2.0"\nmodels:\n  a:\n    source: a.json\n',
      "out/system.yaml": 'systemSchemaVersion: "2.0"\nmodels:\n  a:\n    source: ../../outside/a.em\n',
      "unsafe/system.yaml": 'systemSchemaVersion: "2.0"\nmodels:\n  a:\n    source: "we$ird/a.em"\n',
    });
    try {
      const msg = (t: string) => {
        const r = ciModelsFromManifest(join(dir, t), dir);
        return r.ok ? "ok" : r.message;
      };
      expect(msg("missing")).toBe(`cannot read ${join(dir, "missing")}`);
      expect(msg("bad")).toContain("is not a valid system manifest");
      expect(msg("json")).toBe(`${join(dir, "json", "system.yaml")}: model "a" source a.json is not a .em file - the CI jobs run em against .em sources`);
      expect(msg("out")).toContain('model "a" source ../../outside/a.em is outside the repository root');
      expect(msg("unsafe")).toContain("path must not contain");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- MIL-233: end to end through the CLI, and the committed example ----

describe("em ci init <system.yaml> (CLI, MIL-233)", () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
  const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const CLI = join(ROOT, "src", "cli.ts");
  const em = (args: string[], cwd: string) => {
    const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8" });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const MANIFEST = 'systemSchemaVersion: "2.0"\nname: S\nmodels:\n  checkout:\n    source: models/checkout/checkout.em\n  fulfillment:\n    source: models/fulfillment/fulfillment.em\n';
  let dir: string;
  const wf = (f: string) => join(dir, ".github", "workflows", f);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-ci-cli-"));
    writeFileSync(join(dir, "system.yaml"), MANIFEST, "utf8");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("installs one workflow pair for the whole system; re-running and --check are clean", () => {
    const r = em(["ci", "init", "system.yaml"], dir);
    expect(r.status).toBe(0);
    const ci = readFileSync(wf("em-ci.yml"), "utf8");
    expect(ci).toContain("slice-index-checkout:");
    expect(ci).toContain("slice-index-fulfillment:");
    expect(readFileSync(wf("em-conform.yml"), "utf8")).toContain('- "models/fulfillment"');
    expect(em(["ci", "init", ".", "--check"], dir)).toMatchObject({ status: 0 });
    const again = em(["ci", "init", "system.yaml"], dir);
    expect(again.stdout).toContain("already up to date");
    expect(readFileSync(wf("em-ci.yml"), "utf8")).toBe(ci);
  });

  it("a single-model argument against the multi-model block is refused before any write, --check says 'different models', --force narrows", () => {
    em(["ci", "init", "system.yaml"], dir);
    const before = [readFileSync(wf("em-ci.yml"), "utf8"), readFileSync(wf("em-conform.yml"), "utf8")];
    const refused = em(["ci", "init", "models/checkout/checkout.em"], dir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      "em-ci.yml covers 2 models (models/checkout/checkout.em, models/fulfillment/fulfillment.em) - re-run with the system manifest, or --force to narrow it to models/checkout/checkout.em",
    );
    expect([readFileSync(wf("em-ci.yml"), "utf8"), readFileSync(wf("em-conform.yml"), "utf8")]).toEqual(before);
    const check = em(["ci", "init", "models/checkout/checkout.em", "--check"], dir);
    expect(check.status).toBe(1);
    expect(check.stdout).toContain("different models:");
    expect(check.stdout).not.toContain("stale:");
    expect(em(["ci", "init", "models/checkout/checkout.em", "--force"], dir).status).toBe(0);
    expect(readFileSync(wf("em-ci.yml"), "utf8")).not.toContain("fulfillment");
  });

  it("--check reports a model added to / removed from the manifest as stale, naming it, without writing", () => {
    em(["ci", "init", "system.yaml"], dir);
    const before = readFileSync(wf("em-ci.yml"), "utf8");
    writeFileSync(join(dir, "system.yaml"), MANIFEST + "  shipping:\n    source: models/shipping/shipping.em\n", "utf8");
    const added = em(["ci", "init", "system.yaml", "--check"], dir);
    expect(added.status).toBe(1);
    expect(added.stdout).toContain("stale:");
    expect(added.stdout).toContain("(no section for models/shipping/shipping.em)");
    writeFileSync(join(dir, "system.yaml"), MANIFEST.replace(/  fulfillment:\n.*\n/, ""), "utf8");
    const removed = em(["ci", "init", "system.yaml", "--check"], dir);
    expect(removed.status).toBe(1);
    expect(removed.stdout).toContain("(section for models/fulfillment/fulfillment.em is not in the manifest)");
    expect(readFileSync(wf("em-ci.yml"), "utf8")).toBe(before);
    // ...and the manifest is authoritative: plain init regenerates (no refusal) for a subset.
    expect(em(["ci", "init", "system.yaml"], dir).status).toBe(0);
    expect(readFileSync(wf("em-ci.yml"), "utf8")).not.toContain("fulfillment");
  });

  it("a disjoint manifest is refused naming both sets; a bad manifest is a clean error", () => {
    em(["ci", "init", "models/old/old.em"], dir);
    const refused = em(["ci", "init", "system.yaml"], dir);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(
      "was generated for models/old/old.em, not models/checkout/checkout.em, models/fulfillment/fulfillment.em - re-run with --force to replace it",
    );
    writeFileSync(join(dir, "system.yaml"), "not: [valid", "utf8");
    const bad = em(["ci", "init", "system.yaml"], dir);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("em ci init:");
  });
});

describe("examples/multi-model workflows (MIL-233)", () => {
  const exampleDir = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "multi-model");
  const manifest = ciModelsFromManifest(exampleDir, exampleDir);
  if (!manifest.ok) throw new Error(manifest.message);

  it("the committed workflows are exactly what `em ci init system.yaml` generates (at the pin they carry)", () => {
    const ciFile = readFileSync(join(exampleDir, ".github", "workflows", "em-ci.yml"), "utf8");
    const pin = /npx @milehimikey\/em@(\S+) /.exec(ciFile)![1];
    expect(ciFile).toBe(buildCiWorkflowFileMulti("system.yaml", manifest.models, "test", pin));
    expect(readFileSync(join(exampleDir, ".github", "workflows", "em-conform.yml"), "utf8")).toBe(
      buildConformWorkflowFileMulti("system.yaml", manifest.models, pin),
    );
    expect(existsSync(join(exampleDir, ".github", "workflows", "em-ci.yml"))).toBe(true);
  });

  it("covers both models of the example", () => {
    const ciFile = readFileSync(join(exampleDir, ".github", "workflows", "em-ci.yml"), "utf8");
    expect(managedBlockModels(CI_WORKFLOW_MARKER, ciFile)).toEqual(["models/checkout/checkout.em", "models/fulfillment/fulfillment.em"]);
  });
});
