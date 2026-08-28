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
  planCiFile,
  applyCiFile,
  findUnsafeCiInitArg,
  CI_WORKFLOW_MARKER,
  CONFORM_WORKFLOW_MARKER,
} from "../src/cli/ciInit.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("buildCiWorkflowFile", () => {
  const content = buildCiWorkflowFile("order-fulfillment/order-fulfillment.em", "test", "1.9.0");

  it("names the workflow and wires the PR-triggered gate jobs plus a push-triggered badge job", () => {
    expect(content).toContain("name: em ci");
    expect(content).toContain("on:\n  pull_request:");
    expect(content).toContain("push:\n    branches: [main]");
    for (const job of ["validate:", "slice-index:", "coverage:", "ledger:", "skill-check:", "glossary:", "status-badge:"]) {
      expect(content).toContain(`\n  ${job}\n`);
    }
  });

  it("embeds the model path and tests dir into the right commands", () => {
    expect(content).toContain('npx @milehimikey/em slice index "order-fulfillment/order-fulfillment.em" --check');
    expect(content).toContain('npx @milehimikey/em coverage "order-fulfillment/order-fulfillment.em" --tests "test" --strict');
    expect(content).toContain('npx @milehimikey/em ledger "order-fulfillment/order-fulfillment.em" --from');
    expect(content).toContain('npx @milehimikey/em status "order-fulfillment/order-fulfillment.em" --tests "test" --badge -o status-badge.svg');
  });

  it("gates validate/slice-index/coverage/ledger/skill-check/glossary on pull_request, and status-badge on push only", () => {
    const gateJobs = ["validate", "slice-index", "coverage", "ledger", "skill-check", "glossary"];
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
  const body = ciManagedBody("model.em", "test");

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

      const newBody = ciManagedBody("model.em", "other-tests");
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
