// SPDX-License-Identifier: MIT
// Coverage for the rule registry itself (src/model/rules.ts, MIL-92). The core invariant —
// every code a validator actually pushes is registered — is already enforced twice over by the
// production code, not just asserted here: TypeScript's RuleCode type rejects an unregistered
// code literal at compile time (npm run typecheck), and makeDiag()/pushDiag() throw at runtime
// as defense-in-depth for any non-literal code. This file covers what those two mechanisms
// don't: registry-level sanity (no drift between the opt-in set and sliceReadyValidate.ts,
// no malformed docAnchor, no empty title/fix), and that the runtime guard actually fires.
import { describe, it, expect } from "vitest";
import { makeDiag, pushDiag, RULES, RuleCode, RuleDef } from "../src/model/rules.js";

// `RULES`'s inferred type (from `as const satisfies Record<...>`) is a union of each entry's
// own narrow literal shape, not `RuleDef` — fine for the registry's own call sites (each key
// access narrows correctly), but iterating with Object.entries() loses that per-key narrowing.
// Widen once here rather than casting at every access below.
const RULE_ENTRIES = Object.entries(RULES) as Array<[RuleCode, RuleDef]>;

const KNOWN_DOC_ANCHORS = new Set([
  "connection-legality",
  "lineage",
  "both-ends-of-a-flow",
  "fields-completeness",
  "frontmatter-coherence",
  "slice-readiness",
]);

const SLICE_READY_CODES = [
  "slice-ready-unknown-slice",
  "slice-ready-no-doc-bound",
  "slice-ready-status-not-ready",
  "slice-ready-open-questions-unchecked",
].sort();

describe("RULES registry", () => {
  it("finds every registered rule (guards against a silently empty/truncated table)", () => {
    expect(Object.keys(RULES).length).toBe(40);
  });

  it("marks exactly sliceReadyValidate.ts's 4 codes as optIn — nothing else", () => {
    const optInCodes = RULE_ENTRIES
      .filter(([, r]) => r.optIn)
      .map(([code]) => code)
      .sort();
    expect(optInCodes).toEqual(SLICE_READY_CODES);
  });

  it("every rule has a non-empty title and fix hint", () => {
    for (const [code, rule] of RULE_ENTRIES) {
      expect(rule.title.trim(), `${code}'s title`).not.toBe("");
      expect(rule.fix.trim(), `${code}'s fix`).not.toBe("");
    }
  });

  it("every rule has a non-empty usageCategory (docs/usage-data.md's fixed vocabulary, MIL-97)", () => {
    for (const [code, rule] of RULE_ENTRIES) {
      expect(rule.usageCategory.trim(), `${code}'s usageCategory`).not.toBe("");
    }
  });

  it("every docAnchor (when present) names a real docs/validation.md section", () => {
    for (const [code, rule] of RULE_ENTRIES) {
      if (rule.docAnchor) expect(KNOWN_DOC_ANCHORS.has(rule.docAnchor), `${code}'s docAnchor "${rule.docAnchor}"`).toBe(true);
    }
  });

  it("every code's severity matches error|warning (RuleDef contract)", () => {
    for (const [code, rule] of RULE_ENTRIES) {
      expect(["error", "warning"], code).toContain(rule.severity);
    }
  });
});

describe("makeDiag / pushDiag", () => {
  it("builds a diagnostic with severity looked up from the registry", () => {
    const d = makeDiag("grid-collision", { message: "test message", line: 5, refs: ["a", "b"] });
    expect(d).toEqual({ severity: "error", code: "grid-collision", message: "test message", line: 5, refs: ["a", "b"] });
  });

  it("pushDiag appends the same shape makeDiag returns", () => {
    const diags: ReturnType<typeof makeDiag>[] = [];
    pushDiag(diags, "open-issue", { message: "an open question" });
    expect(diags).toEqual([{ severity: "warning", code: "open-issue", message: "an open question" }]);
  });

  it("throws on an unregistered code — the runtime defense-in-depth net for a non-literal code", () => {
    // Bypasses RuleCode's compile-time guard on purpose, simulating what a dynamically-built
    // (not string-literal) code could still let through the type system.
    const bogus = "not-a-real-code" as unknown as RuleCode;
    expect(() => makeDiag(bogus, { message: "x" })).toThrow(/unknown rule code "not-a-real-code"/);
  });
});
