// SPDX-License-Identifier: MIT
// Coverage for `em validate --slice-ready <key>`'s underlying check
// (src/catalog/sliceReadyValidate.ts, MIL-87): the handoff gate without the bridge. Real fs
// fixtures via mkdtempSync, same convention as test/lineageValidate.test.ts and
// test/frontmatterCoherenceValidate.test.ts. Doc resolution is note-bound (docJoin.ts, MIL-91),
// unlike lineage/frontmatter-coherence's filename-only readSliceDoc — every `.em` fixture below
// that expects a doc to be found declares `note "slices/<key>.md"` on an element.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { validateSliceReady, computeSliceReadyGates } from "../src/catalog/sliceReadyValidate.js";
import { generateContract } from "../src/cli/api.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "em-slice-ready-validate-"));
  mkdirSync(join(dir, "slices"), { recursive: true });
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeDoc(sliceKey: string, extraFrontmatter: string, body = "body\n"): void {
  writeFileSync(
    join(dir, "slices", `${sliceKey}.md`),
    `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\n${extraFrontmatter}---\n${body}`,
  );
}

function readyDiagsOf(src: string, sliceKey: string) {
  const { model, refs, diagnostics } = compile(src);
  return validateSliceReady(model, refs, dir, sliceKey, { file: join(dir, "model.em"), source: src, diagnostics });
}

describe("slice-ready-unknown-slice", () => {
  it("errors when the given key names no slice in the model", () => {
    const diags = readyDiagsOf(`slice "Place" {\n  command Do Thing\n}`, "no-such-slice");
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "slice-ready-unknown-slice",
        refs: ["no-such-slice"],
      }),
    ]);
  });
});

describe("slice-ready-no-doc-bound", () => {
  it("warns when no element declares a note binding to the conventional doc path", () => {
    const diags = readyDiagsOf(`slice "Unbound" {\n  command Do Thing\n}`, "unbound");
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "slice-ready-no-doc-bound",
        refs: ["unbound"],
      }),
    ]);
  });
});

describe("binding-missing-file (reused from docJoin, not re-coded)", () => {
  it("warns when the note names a path but no file exists there", () => {
    const diags = readyDiagsOf(
      `slice "Ghost" {\n  command Do Thing note "slices/ghost.md"\n}`,
      "ghost",
    );
    expect(diags).toEqual([expect.objectContaining({ severity: "warning", code: "binding-missing-file" })]);
  });
});

describe("frontmatter-invalid (reused from docJoin, not re-coded)", () => {
  it("warns when the doc exists but has no frontmatter block", () => {
    writeFileSync(join(dir, "slices", "no-frontmatter.md"), "# Slice: No Frontmatter\n\nbody\n");
    const diags = readyDiagsOf(
      `slice "No Frontmatter" {\n  command Do Thing note "slices/no-frontmatter.md"\n}`,
      "no-frontmatter",
    );
    expect(diags).toEqual([expect.objectContaining({ severity: "warning", code: "frontmatter-invalid" })]);
  });
});

describe("slice-ready-status-not-ready", () => {
  it("warns when the doc is bound and usable but status isn't ready-to-implement", () => {
    writeDoc("draft-slice", "status: draft\nversion: 1\n");
    const diags = readyDiagsOf(
      `slice "Draft Slice" {\n  command Do Thing note "slices/draft-slice.md"\n}`,
      "draft-slice",
    );
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "slice-ready-status-not-ready",
        refs: ["draft-slice"],
      }),
    ]);
  });
});

describe("slice-ready-open-questions-unchecked", () => {
  it("warns with the unchecked/total count when Open Questions remain", () => {
    writeDoc(
      "unresolved",
      "status: ready-to-implement\nversion: 1\nratifiedBy: Alex Rivera\n",
      "## Open Questions\n- [ ] who validates this?\n- [x] already answered\n",
    );
    const diags = readyDiagsOf(
      `slice "Unresolved" {\n  command Do Thing note "slices/unresolved.md"\n}`,
      "unresolved",
    );
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "slice-ready-open-questions-unchecked",
        message: expect.stringContaining("1 of 2"),
        refs: ["unresolved"],
      }),
    ]);
  });

  it("combines with slice-ready-status-not-ready when both are true", () => {
    writeDoc("both-wrong", "status: draft\nversion: 1\n", "## Open Questions\n- [ ] unresolved\n");
    const diags = readyDiagsOf(
      `slice "Both Wrong" {\n  command Do Thing note "slices/both-wrong.md"\n}`,
      "both-wrong",
    );
    expect(diags.map((d) => d.code).sort()).toEqual([
      "slice-ready-open-questions-unchecked",
      "slice-ready-status-not-ready",
    ]);
  });
});

describe("cross-slice binding (MIL-121)", () => {
  // The ticket's own repro shape: a view-only slice ("Detect Unpaid Orders") with no doc of its
  // own, covered instead by the reaction slice's doc ("Request Payment") via a ratifying
  // `covers:` entry naming the view slice's key back.
  it("passes the view-only slice through to a ready, no-open-questions covering doc", () => {
    writeDoc(
      "request-payment",
      "status: ready-to-implement\nversion: 1\nratifiedBy: Alex Rivera\ncovers: detect-unpaid-orders\n",
      "## Open Questions\n- [x] resolved before ratification\n",
    );
    const diags = readyDiagsOf(
      [
        'slice "Detect Unpaid Orders" {',
        '  view Unpaid Orders from "Order Placed" note "slices/request-payment.md"',
        "}",
        'slice "Request Payment" {',
        "  processor Payment Request Policy from \"Unpaid Orders\" note \"slices/request-payment.md\"",
        "  command Request Payment",
        "  event Payment Requested",
        "}",
      ].join("\n"),
      "detect-unpaid-orders",
    );
    expect(diags).toEqual([]);
  });

  it("reports status-not-ready from the covering doc when it isn't ready-to-implement", () => {
    writeDoc("draft-covering-doc", "status: draft\nversion: 1\ncovers: covered-by-draft\n");
    const diags = readyDiagsOf(
      `slice "Covered By Draft" {\n  view Covered By Draft from "Something" note "slices/draft-covering-doc.md"\n}`,
      "covered-by-draft",
    );
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "slice-ready-status-not-ready",
        refs: ["covered-by-draft"],
      }),
    ]);
  });

  it("a cross-note not ratified by the target doc's `covers` is still no-doc-bound", () => {
    writeDoc("uncovering-doc", "status: ready-to-implement\nversion: 1\n"); // no `covers:` at all
    const diags = readyDiagsOf(
      `slice "Not Covered" {\n  view Not Covered from "Something" note "slices/uncovering-doc.md"\n}`,
      "not-covered",
    );
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "slice-ready-no-doc-bound",
        refs: ["not-covered"],
      }),
    ]);
  });
});

describe("ready: the all-clear case", () => {
  it("produces zero diagnostics for a bound, usable, ready-to-implement doc with no open questions", () => {
    writeDoc(
      "ready-slice",
      "status: ready-to-implement\nversion: 1\nratifiedBy: Alex Rivera\n",
      "## Open Questions\n- [x] resolved before ratification\n",
    );
    const diags = readyDiagsOf(
      `slice "Ready Slice" {\n  command Do Thing note "slices/ready-slice.md"\n}`,
      "ready-slice",
    );
    expect(diags).toEqual([]);
  });

  it("produces zero diagnostics for a ready doc with no Open Questions section at all", () => {
    writeDoc("ready-no-questions", "status: ready-to-implement\nversion: 1\nratifiedBy: Alex Rivera\n");
    const diags = readyDiagsOf(
      `slice "Ready No Questions" {\n  command Do Thing note "slices/ready-no-questions.md"\n}`,
      "ready-no-questions",
    );
    expect(diags).toEqual([]);
  });
});

describe("slice-ready-not-ratified (MIL-259)", () => {
  it("errors on a ready-to-implement doc with no ratifiedBy, with the exact message", () => {
    writeDoc("reratified-slice", "status: ready-to-implement\nversion: 2\n");
    const diags = readyDiagsOf(
      `slice "Reratified Slice" {\n  command Do Thing note "slices/reratified-slice.md"\n}`,
      "reratified-slice",
    );
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "slice-ready-not-ratified",
        message:
          'slice "reratified-slice" is ready-to-implement but carries no ratifiedBy — record the sign-off with `em slice ratify --by <name>`',
        refs: ["reratified-slice"],
      }),
    ]);
  });

  it("does not add the finding when the status is already not-ready (one blocker, not two)", () => {
    writeDoc("draft-unsigned", "status: draft\nversion: 1\n");
    const diags = readyDiagsOf(
      `slice "Draft Unsigned" {\n  command Do Thing note "slices/draft-unsigned.md"\n}`,
      "draft-unsigned",
    );
    expect(diags.map((d) => d.code)).toEqual(["slice-ready-status-not-ready"]);
  });
});

// MIL-238 — the API-first gate. Each case gets its own model directory so one case's contract
// file never satisfies another's.
describe("slice-ready-contract-stale (MIL-238)", () => {
  const PUBLIC_SRC =
    `model "Shop"\n` +
    `slice "Place Order" {\n  command Place Order public { orderId: uuid } note "slices/place-order.md"\n  event Order Placed public { orderId: uuid, total: decimal }\n}\n` +
    `slice "Audit" {\n  command Record Audit { note: free text } note "slices/audit.md"\n  event Audit Recorded\n}\n`;
  const READY = "status: ready-to-implement\nversion: 1\nratifiedBy: Alex Rivera\n";

  function modelDir(name: string): string {
    const d = join(dir, name);
    mkdirSync(join(d, "slices"), { recursive: true });
    for (const key of ["place-order", "audit"]) {
      writeFileSync(join(d, "slices", `${key}.md`), `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\n${READY}---\nbody\n`);
    }
    return d;
  }

  function check(d: string, src: string, key: string) {
    const compiled = compile(src);
    const input = { file: join(d, "shop.em"), source: src, diagnostics: compiled.diagnostics };
    return {
      diags: validateSliceReady(compiled.model, compiled.refs, d, key, input),
      gates: computeSliceReadyGates(compiled.model, compiled.refs, d, key, input)!.gates,
    };
  }

  function writeContract(d: string, src: string): string {
    const compiled = compile(src);
    const generated = generateContract(join(d, "shop.em"), src, compiled);
    mkdirSync(join(d, "contracts"), { recursive: true });
    writeFileSync(generated.contractPath, generated.text);
    return generated.contractPath;
  }

  it("errors with the exact message when a public-touching slice's contract is missing", () => {
    const d = modelDir("contract-missing");
    const { diags, gates } = check(d, PUBLIC_SRC, "place-order");
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "slice-ready-contract-stale",
        message: `slice "place-order" touches the public surface but the contract ${join(d, "contracts", "shop.tsp")} is missing — run: em api generate ${join(d, "shop.em")}`,
        refs: ["place-order"],
      }),
    ]);
    expect(gates.contractCurrent).toBe(false);
  });

  it("passes once the contract is generated, and reports stale (exact message) after a public-surface edit", () => {
    const d = modelDir("contract-stale");
    writeContract(d, PUBLIC_SRC);
    expect(check(d, PUBLIC_SRC, "place-order")).toEqual({
      diags: [],
      gates: { docBound: true, frontmatterUsable: true, statusReady: true, noUncheckedOpenQuestions: true, ratified: true, contractCurrent: true },
    });
    const edited = PUBLIC_SRC.replace("total: decimal", "total: decimal, currency: string");
    const { diags, gates } = check(d, edited, "place-order");
    expect(diags.map((x) => x.message)).toEqual([
      `slice "place-order" touches the public surface but the contract ${join(d, "contracts", "shop.tsp")} is stale — run: em api generate ${join(d, "shop.em")}`,
    ]);
    expect(gates.contractCurrent).toBe(false);
  });

  it("an internal-only edit keeps the contract current (no source hash, R12)", () => {
    const d = modelDir("contract-internal-edit");
    writeContract(d, PUBLIC_SRC);
    const edited = PUBLIC_SRC.replace("note: free text", "note: free text, actor: who did it");
    expect(check(d, edited, "place-order").diags).toEqual([]);
  });

  it("leaves a slice with no public element alone, even with no contract at all", () => {
    const d = modelDir("contract-non-public");
    const { diags, gates } = check(d, PUBLIC_SRC, "audit");
    expect(diags).toEqual([]);
    expect(gates.contractCurrent).toBe(true);
  });

  it("is reported alongside the doc findings, even when the doc is not ready", () => {
    const d = modelDir("contract-with-doc-findings");
    writeFileSync(join(d, "slices", "place-order.md"), "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: draft\nversion: 1\n---\nbody\n");
    const { diags, gates } = check(d, PUBLIC_SRC, "place-order");
    expect(diags.map((x) => x.code)).toEqual(["slice-ready-status-not-ready", "slice-ready-contract-stale"]);
    expect(gates.statusReady).toBe(false);
    expect(gates.contractCurrent).toBe(false);
  });
});

describe("slice-ready-structured-section-malformed (MIL-266)", () => {
  it("blocks a ready, ratified doc whose generated region is malformed, with the exact message", () => {
    writeDoc(
      "ready-malformed",
      "status: ready-to-implement\nversion: 1\nratifiedBy: Alex Rivera\n",
      "<!-- GENERATED:em-slice-command:start -->\n**Command:** `Do Thing`\n",
    );
    const diags = readyDiagsOf(
      `slice "Ready Malformed" {\n  command Do Thing note "slices/ready-malformed.md"\n}`,
      "ready-malformed",
    );
    expect(diags).toEqual([
      expect.objectContaining({
        severity: "error",
        code: "slice-ready-structured-section-malformed",
        message: 'slice "ready-malformed"\'s doc slices/ready-malformed.md: region "em-slice-command" has no end marker',
        refs: ["ready-malformed"],
      }),
    ]);
  });

  it("leaves a 1.13-style free-prose ready doc ready (no markers, no `### Scenario:`)", () => {
    writeDoc(
      "ready-legacy",
      "status: ready-to-implement\nversion: 1\nratifiedBy: Alex Rivera\n",
      "## Scenarios (Given / When / Then)\n- **Happy path**\n  - **Given:** a\n  - **When:** b\n  - **Then:** c\n## Open Questions\n- [x] done\n",
    );
    const diags = readyDiagsOf(
      `slice "Ready Legacy" {\n  command Do Thing note "slices/ready-legacy.md"\n}`,
      "ready-legacy",
    );
    expect(diags).toEqual([]);
  });
});
