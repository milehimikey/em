// SPDX-License-Identifier: MIT
// Coverage for `em ci init`'s pure plumbing (src/cli/ciInit.ts, MIL-166): from-scratch content,
// the marker-delimited patch/idempotent/stale/missing-markers/force matrix (planCiFile), and the
// shell-injection guard. CLI-level coverage (real fs, `em ci init` end to end) lives in
// test/cli.test.ts, matching test/agentsMd.test.ts (pure) / test/cli.test.ts's AGENTS.md block
// (CLI) split for the marker-delimited AGENTS.md section this reuses the same convention from.
import { describe, it, expect } from "vitest";
import {
  buildCiWorkflowFile,
  buildConformWorkflowFile,
  ciManagedBody,
  conformManagedBody,
  managedBlockModel,
  planCiFile,
  applyCiFile,
  findUnsafeCiInitArg,
  CI_WORKFLOW_MARKER,
  CONFORM_WORKFLOW_MARKER,
} from "../src/cli/ciInit.js";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const generatedFiles: Array<[string, string]> = [
  ["em-ci.yml", buildCiWorkflowFile("orders/orders.em", "test", "1.13.0")],
  ["em-conform.yml", buildConformWorkflowFile("orders/orders.em", "1.13.0")],
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
        const path = join(dir, name);
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

// ---- MIL-256 (#174): a second model never silently replaces the first model's block ----

describe("single-model guard (MIL-256, #174)", () => {
  function setup(): { ci: string; conform: string } {
    const dir = mkdtempSync(join(tmpdir(), "em-ci-guard-"));
    return { ci: join(dir, "em-ci.yml"), conform: join(dir, "em-conform.yml") };
  }
  const gen = (model: string, ver = "1.14.0") => ({
    ci: [buildCiWorkflowFile(model, "test", ver), ciManagedBody(model, "test", ver)] as const,
    conform: [buildConformWorkflowFile(model, ver), conformManagedBody(model, ver)] as const,
  });

  it("derives the model from the block content, ignoring the version pin", () => {
    expect(managedBlockModel(CI_WORKFLOW_MARKER, ciManagedBody("orders/orders.em", "test", "1.13.0"))).toBe("orders/orders.em");
    expect(managedBlockModel(CI_WORKFLOW_MARKER, ciManagedBody("orders/orders.em", "test", "9.9.9"))).toBe("orders/orders.em");
    expect(managedBlockModel(CONFORM_WORKFLOW_MARKER, conformManagedBody("orders/orders.em", "1.13.0"))).toBe("orders");
  });

  it("refuses a different model in em-ci.yml, naming the original, and leaves the file untouched", () => {
    const { ci } = setup();
    writeFileSync(ci, gen("orders/orders.em").ci[0], "utf8");
    const before = readFileSync(ci, "utf8");
    const status = planCiFile(ci, ...gen("billing/billing.em").ci, CI_WORKFLOW_MARKER, false);
    expect(status).toEqual({ kind: "other-model", previous: "orders/orders.em" });
    applyCiFile(ci, status);
    expect(readFileSync(ci, "utf8")).toBe(before);
  });

  it("refuses a different model in em-conform.yml (named by its directory)", () => {
    const { conform } = setup();
    writeFileSync(conform, gen("orders/orders.em").conform[0], "utf8");
    const status = planCiFile(conform, ...gen("billing/billing.em").conform, CONFORM_WORKFLOW_MARKER, false);
    expect(status).toEqual({ kind: "other-model", previous: "orders" });
  });

  it("--force replaces the block and retargets the generated header, keeping the repo's own jobs", () => {
    const { ci } = setup();
    writeFileSync(ci, gen("orders/orders.em").ci[0].replace("jobs:\n", "jobs:\n  mine:\n    runs-on: ubuntu-latest\n    steps: []\n\n"), "utf8");
    const status = planCiFile(ci, ...gen("billing/billing.em").ci, CI_WORKFLOW_MARKER, true);
    expect(status.kind).toBe("replace-model");
    applyCiFile(ci, status);
    const after = readFileSync(ci, "utf8");
    expect(after).toContain('slice index "billing/billing.em" --check');
    expect(after).not.toContain("orders/orders.em");
    expect(after).toContain("em ci init billing/billing.em");
    expect(after).toContain("  mine:");
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
});
