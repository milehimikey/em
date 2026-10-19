// SPDX-License-Identifier: MIT
// GH #293: the three scenario-quality advisories (src/catalog/scenarioQualityValidate.ts), run
// through validateDocModelConsistency over real fs fixtures.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { validateDocModelConsistency } from "../src/catalog/docModelConsistencyValidate.js";
import { RULES } from "../src/model/rules.js";
import { computeSliceReadiness } from "../src/catalog/sliceReadyValidate.js";
import { buildSliceReadyJson } from "../src/emit/validateJson.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "em-scenario-quality-"));
  mkdirSync(join(dir, "slices"), { recursive: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeDoc(key: string, body: string): void {
  writeFileSync(
    join(dir, "slices", `${key}.md`),
    `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: draft\nversion: 1\n---\n${body}`,
  );
}

const MODEL = (key: string, extra = "") =>
  [
    `slice "${key}" {`,
    `  command Place Order note "slices/${key}.md"`,
    `  event Order Placed @Order`,
    extra,
    "}",
  ].join("\n");

function codes(src: string): string[] {
  const { model, refs } = compile(src);
  return validateDocModelConsistency(model, refs, dir)
    .map((d) => d.code)
    .filter((c) => c.startsWith("scenario-") || c === "invariant-without-scenario");
}

const scenario = (title: string, when: string, then: string) =>
  `### Scenario: ${title}\n- **Given:**\n  - a basket\n- **When:**\n  - ${when}\n- **Then:**\n  - ${then}\n`;

describe("scenario-quality rules", () => {
  it("are registered as warnings", () => {
    for (const c of ["scenario-when-not-command", "scenario-then-not-outcome", "invariant-without-scenario"] as const) {
      expect(RULES[c].severity).toBe("warning");
    }
  });

  it("scenario-when-not-command fires when When names no command, with doc line and model refs", () => {
    writeDoc("sq-when", `## Scenarios (Given / When / Then)\n${scenario("x", "the customer submits", "Order Placed is recorded")}`);
    const { model, refs } = compile(MODEL("sq-when"));
    const d = validateDocModelConsistency(model, refs, dir).filter((x) => x.code === "scenario-when-not-command");
    expect(d).toHaveLength(1);
    expect(d[0].message).toContain("slices/sq-when.md:9");
    expect(d[0].refs?.[0]).toBe("sq-when");
    expect(d[0].refs?.length).toBe(2);
  });

  it("scenario-when-not-command is silent when When names the command (spacing/case-insensitive)", () => {
    writeDoc("sq-when-ok", `## Scenarios (Given / When / Then)\n${scenario("x", "`PlaceOrder` is issued", "Order Placed is recorded")}`);
    expect(codes(MODEL("sq-when-ok"))).toEqual([]);
  });

  it("scenario-then-not-outcome fires when Then names neither an event nor a rejection", () => {
    writeDoc("sq-then", `## Scenarios (Given / When / Then)\n${scenario("x", "Place Order", "the basket is emptied")}`);
    expect(codes(MODEL("sq-then"))).toEqual(["scenario-then-not-outcome"]);
  });

  it("scenario-then-not-outcome accepts a rejection phrase and any event of the slice", () => {
    writeDoc(
      "sq-then-ok",
      `## Scenarios (Given / When / Then)\n${scenario("a", "Place Order", "the command is rejected")}\n${scenario("b", "Place Order", "Order Placed")}`,
    );
    expect(codes(MODEL("sq-then-ok"))).toEqual([]);
  });

  it("invariant-without-scenario fires for a model invariant no scenario cites", () => {
    writeDoc("sq-inv", `## Scenarios (Given / When / Then)\n${scenario("x", "Place Order", "Order Placed")}`);
    expect(codes(MODEL("sq-inv", '  invariant INV-SQ-1 "total is positive"'))).toEqual(["invariant-without-scenario"]);
  });

  it("invariant-without-scenario is silent once a scenario cites the id (title or bullet)", () => {
    writeDoc("sq-inv-ok", `## Scenarios (Given / When / Then)\n${scenario("x (INV-SQ-1)", "Place Order", "Order Placed")}`);
    expect(codes(MODEL("sq-inv-ok", '  invariant INV-SQ-1 "total is positive"'))).toEqual([]);
    writeDoc("sq-inv-ok2", `## Scenarios (Given / When / Then)\n${scenario("x", "Place Order", "Order Placed; INV-SQ-1 holds")}`);
    expect(codes(MODEL("sq-inv-ok2", '  invariant INV-SQ-1 "total is positive"'))).toEqual([]);
  });

  it("invariant-without-scenario also covers doc-declared invariants", () => {
    writeDoc(
      "sq-inv-doc",
      `## Invariants / Business Rules\n- **INV-SQD-1:** total is positive\n\n## Scenarios (Given / When / Then)\n${scenario("x", "Place Order", "Order Placed")}`,
    );
    expect(codes(MODEL("sq-inv-doc"))).toEqual(["invariant-without-scenario"]);
  });

  it("is silent on a doc with no ### Scenario: blocks", () => {
    writeDoc("sq-none", "## Scenarios (Given / When / Then)\n- **Happy path**\n  - Given x\n");
    expect(codes(MODEL("sq-none", '  invariant INV-SQN-1 "r"'))).toEqual([]);
  });

  it("marks the three rules advisory", () => {
    for (const c of ["scenario-when-not-command", "scenario-then-not-outcome", "invariant-without-scenario"] as const) {
      expect((RULES[c] as { advisory?: true }).advisory).toBe(true);
    }
  });

  describe("--slice-ready", () => {
    const src = MODEL("sq-ready");
    const readiness = (strict: boolean) => {
      writeFileSync(
        join(dir, "slices", "sq-ready.md"),
        `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ready-to-implement\nversion: 1\nratifiedBy: Alex\n---\n## Scenarios (Given / When / Then)\n${scenario("x", "the customer submits", "Order Placed")}`,
      );
      const { model, refs, diagnostics } = compile(src);
      const all = validateDocModelConsistency(model, refs, dir);
      return computeSliceReadiness(model, refs, dir, "sq-ready", { file: join(dir, "m.em"), source: src, diagnostics }, all, { strict });
    };

    it("an advisory warning does not block readiness, but is listed under advisories", () => {
      const r = readiness(false);
      expect(r.ready).toBe(true);
      expect(r.scoped).toEqual([]);
      expect(r.advisories.map((d) => d.code)).toEqual(["scenario-when-not-command"]);
      const json = JSON.parse(buildSliceReadyJson("m.em", "sq-ready", r.result?.gates ?? null, r.scoped, r.ready, null, null, r.advisories));
      expect(json.validateSliceReadySchemaVersion).toBe("1.4");
      expect(json.advisories).toHaveLength(1);
      expect(json.ready).toBe(true);
    });

    it("--strict promotes it to a blocking error", () => {
      const r = readiness(true);
      expect(r.ready).toBe(false);
      expect(r.advisories).toEqual([]);
      expect(r.scoped.map((d) => [d.code, d.severity])).toEqual([["scenario-when-not-command", "error"]]);
    });
  });
});
