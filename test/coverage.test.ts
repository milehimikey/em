// SPDX-License-Identifier: MIT
// Coverage for `em coverage`'s underlying logic (src/cli/coverage.ts, MIL-130): ID extraction
// from a slice doc body, word-boundary citation scanning of a test tree, and full report
// assembly (in-scope filtering by joined doc status). Real fs fixtures via mkdtempSync, same
// convention as test/sliceReadyValidate.test.ts — doc resolution is note-bound (docJoin.ts),
// so every `.em` fixture below that expects a doc to be found declares
// `note "slices/<key>.md"` on an element.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { extractInvariantIds, scanTestCitations, buildCoverageReport } from "../src/cli/coverage.js";

describe("extractInvariantIds", () => {
  it("extracts the template's bare-numbered form", () => {
    const body = "## Invariants / Business Rules\n- **INV-1:** rule one\n- **INV-2:** rule two\n";
    expect(extractInvariantIds(body)).toEqual(["INV-1", "INV-2"]);
  });

  it("extracts the per-slice mnemonic form (reference/conform.md's own example)", () => {
    const body = "## Invariants\n- **INV-CHK-3:** must not exceed the limit\n- **INV-CHK-4:** must be positive\n";
    expect(extractInvariantIds(body)).toEqual(["INV-CHK-3", "INV-CHK-4"]);
  });

  it("dedupes repeated mentions, first occurrence wins for ordering", () => {
    const body = "## Invariants\n- **INV-1:** rule one\n## Delta\n#### Requirement: Rule One (INV-1)\nnow also covers X\n- **INV-2:** rule two\n";
    expect(extractInvariantIds(body)).toEqual(["INV-1", "INV-2"]);
  });

  it("does not merge INV-KEY-1 and INV-KEY-12 into one token", () => {
    const body = "## Invariants\n- **INV-KEY-1:** short\n- **INV-KEY-12:** long\n";
    expect(extractInvariantIds(body)).toEqual(["INV-KEY-1", "INV-KEY-12"]);
  });

  it("handles a rename target with a trailing letter (INV-CHK-3a)", () => {
    const body = "## Delta\n### Renamed\n- Old Title (INV-CHK-3) -> New Title (INV-CHK-3a)\n";
    expect(extractInvariantIds(body)).toEqual(["INV-CHK-3", "INV-CHK-3a"]);
  });

  it("returns an empty list when the body has no INV tokens", () => {
    expect(extractInvariantIds("## Intent\nJust prose, no invariants yet.\n")).toEqual([]);
  });

  it("doesn't false-positive on a word that merely contains INV as a substring", () => {
    expect(extractInvariantIds("## Invariants\nThis involves nothing invariant-shaped.\n")).toEqual([]);
  });

  // MIL-149: an ID mentioned only in another section's prose isn't this doc's own — it's a
  // citation of someone else's invariant, not a declaration of this slice's.
  it("does not attribute an ID mentioned only in a non-ownership section (e.g. Dependencies)", () => {
    const body =
      "## Invariants\n- **INV-A-1:** must hold\n\n## Dependencies & Read Models Affected\nRelies on checkout's INV-CHK-1 also holding.\n";
    expect(extractInvariantIds(body)).toEqual(["INV-A-1"]);
  });

  it("does not attribute an ID mentioned only in Open Questions prose", () => {
    const body = "## Open Questions\nDoes this need to re-check INV-OTHER-9 too?\n";
    expect(extractInvariantIds(body)).toEqual([]);
  });

  it("still attributes IDs declared under a `## Delta` Added/Modified subsection", () => {
    const body =
      "## Delta\n### Added\n#### Requirement: New step (INV-CHK-5)\n##### Scenario: happy path\ndetails\n### Modified\n- **INV-CHK-2:** now stricter\n\n## Invariants\n- **INV-CHK-2:** now stricter\n- **INV-CHK-5:** must hold\n";
    expect(extractInvariantIds(body)).toEqual(["INV-CHK-5", "INV-CHK-2"]);
  });

  it("stops collecting at the next top-level heading after Invariants", () => {
    const body = "## Invariants\n- **INV-1:** must hold\n\n## Scenarios (Given / When / Then)\nSee INV-2 covered elsewhere.\n";
    expect(extractInvariantIds(body)).toEqual(["INV-1"]);
  });

  // MIL-155: MIL-149 only gated on section heading, so a sibling ID cited *inside* the doc's own
  // Invariants/Delta section — not just in some other section entirely — was still cross-credited.
  // The real-world shape (confirmed against the Meridian Goods repo): a bulleted definition wraps
  // across multiple lines, and a later wrapped line cites a sibling slice's ID for context — e.g.
  // request-payment's INV-RP-1 bullet wrapping onto a line naming payments-to-request's INV-PTR-2.
  it("does not attribute a sibling ID cited in a wrapped continuation line of another bullet", () => {
    const body =
      "## Invariants\n- **INV-RP-1 (exactly-once liveness):** at most one event is ever recorded,\n" +
      "  which is also what lets `Payments To Request` — once removed via INV-PTR-2 — never retry.\n" +
      "- **INV-RP-2:** amount fidelity holds.\n";
    expect(extractInvariantIds(body)).toEqual(["INV-RP-1", "INV-RP-2"]);
  });

  it("does not attribute a sibling ID cited in a standalone prose paragraph inside Invariants", () => {
    const body =
      "## Invariants\n- **INV-CO-2:** idempotent cancel.\n\nUnlike place-order's INV-PO-1, there's no conflicting payload to reject.\n";
    expect(extractInvariantIds(body)).toEqual(["INV-CO-2"]);
  });

  it("does not attribute a sibling ID cited in a Requirement heading's unindented body paragraph", () => {
    const body =
      "## Delta\n### Added\n#### Requirement: New step (INV-CO-2)\nSame timing as place-order's INV-PO-1.\n";
    expect(extractInvariantIds(body)).toEqual(["INV-CO-2"]);
  });

  it("still attributes both IDs on a Renamed bullet even with a mnemonic label before the colon", () => {
    const body = "## Delta\n### Renamed\n- **MODIFIED (v1 -> v2):** INV-CO-1 supersedes nothing, just tightens scope.\n";
    expect(extractInvariantIds(body)).toEqual(["INV-CO-1"]);
  });
});

describe("scanTestCitations", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-coverage-scan-"));
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "a.test.ts"), `// cites INV-1\nit("rejects", () => {\n  // INV-KEY-12 only\n});\n`);
    writeFileSync(join(dir, "nested", "b.test.ts"), `// INV-1 again, and INV-2\nconst x = 1; // INV-1\n`);
    writeFileSync(join(dir, "empty.test.ts"), `no citations here\n`);
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.ts"), `// INV-1 (should never be scanned)\n`);
    writeFileSync(join(dir, "binary.bin"), Buffer.from([0x00, 0x01, 0x02, 0x49, 0x4e, 0x56, 0x2d, 0x31]));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds every citing file:line for a cited ID, across nested dirs", () => {
    const result = scanTestCitations(dir, ["INV-1"]);
    const citations = result.get("INV-1")!;
    expect(citations).toContainEqual({ file: "a.test.ts", line: 1 });
    expect(citations).toContainEqual({ file: "nested/b.test.ts", line: 1 });
    expect(citations).toContainEqual({ file: "nested/b.test.ts", line: 2 });
    expect(citations).toHaveLength(3);
  });

  it("records multiple citations on the same ID from different files", () => {
    const result = scanTestCitations(dir, ["INV-2"]);
    expect(result.get("INV-2")).toEqual([{ file: "nested/b.test.ts", line: 1 }]);
  });

  it("returns an empty array (not a missing key) for an ID with zero citations", () => {
    const result = scanTestCitations(dir, ["INV-999"]);
    expect(result.has("INV-999")).toBe(true);
    expect(result.get("INV-999")).toEqual([]);
  });

  it("word-boundary matches: INV-KEY-1 does not match inside INV-KEY-12", () => {
    const result = scanTestCitations(dir, ["INV-KEY-1"]);
    expect(result.get("INV-KEY-1")).toEqual([]);
  });

  it("still finds INV-KEY-12 itself as its own citation", () => {
    const result = scanTestCitations(dir, ["INV-KEY-12"]);
    expect(result.get("INV-KEY-12")).toEqual([{ file: "a.test.ts", line: 3 }]);
  });

  it("skips node_modules", () => {
    const result = scanTestCitations(dir, ["INV-1"]);
    expect(result.get("INV-1")!.some((c) => c.file.includes("node_modules"))).toBe(false);
  });

  it("skips binary files even when they happen to contain the ID bytes", () => {
    const result = scanTestCitations(dir, ["INV-1"]);
    expect(result.get("INV-1")!.some((c) => c.file === "binary.bin")).toBe(false);
  });

  it("returns an empty map with no work done when ids is empty", () => {
    expect(scanTestCitations(dir, [])).toEqual(new Map());
  });
});

describe("buildCoverageReport", () => {
  let dir: string, testsDir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-coverage-report-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    testsDir = mkdtempSync(join(tmpdir(), "em-coverage-report-tests-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(testsDir, { recursive: true, force: true });
  });

  function writeDoc(key: string, status: string, body: string): void {
    writeFileSync(
      join(dir, "slices", `${key}.md`),
      `---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nstatus: ${status}\nversion: 1\n---\n${body}`,
    );
  }

  function reportFor(src: string, tests: string = testsDir) {
    const { model, refs } = compile(src);
    return buildCoverageReport(model, refs, dir, tests);
  }

  it("marks a ready-to-implement slice with a bound doc as in scope", () => {
    writeDoc("place", "ready-to-implement", "## Invariants\n- **INV-1:** must hold\n");
    const report = reportFor(`slice "Place" {\n  command Do Thing note "slices/place.md"\n}`);
    const entry = report.slices.find((s) => s.key === "place")!;
    expect(entry.inScope).toBe(true);
    expect(entry.status).toBe("ready-to-implement");
    expect(entry.invariants).toEqual([{ id: "INV-1", cited: false, citations: [] }]);
  });

  it("marks an implemented slice with a bound doc as in scope", () => {
    writeDoc("ship", "implemented", "- **INV-1:** must hold\n");
    const report = reportFor(`slice "Ship" {\n  command Do Thing note "slices/ship.md"\n}`);
    expect(report.slices.find((s) => s.key === "ship")!.inScope).toBe(true);
  });

  it("marks a draft slice as out of scope, invariants empty, docReason null (doc joined cleanly)", () => {
    writeDoc("draft-slice", "draft", "- **INV-1:** must hold\n");
    const report = reportFor(`slice "Draft Slice" {\n  command Do Thing note "slices/draft-slice.md"\n}`);
    const entry = report.slices.find((s) => s.key === "draft-slice")!;
    expect(entry.inScope).toBe(false);
    expect(entry.status).toBe("draft");
    expect(entry.docReason).toBeNull();
    expect(entry.invariants).toEqual([]);
  });

  it("marks a slice with no doc bound as out of scope with null status and docReason no-doc-bound", () => {
    const report = reportFor(`slice "Unbound" {\n  command Do Thing\n}`);
    const entry = report.slices.find((s) => s.key === "unbound")!;
    expect(entry.inScope).toBe(false);
    expect(entry.status).toBeNull();
    expect(entry.docReason).toBe("no-doc-bound");
  });

  it("marks a bound-but-missing-file slice as out of scope with docReason binding-missing-file", () => {
    const report = reportFor(`slice "Ghost" {\n  command Do Thing note "slices/ghost.md"\n}`);
    const entry = report.slices.find((s) => s.key === "ghost")!;
    expect(entry.inScope).toBe(false);
    expect(entry.status).toBeNull();
    expect(entry.docReason).toBe("binding-missing-file");
  });

  it("marks a bound-but-unusable-frontmatter slice as out of scope with docReason frontmatter-invalid", () => {
    writeFileSync(join(dir, "slices", "invalid.md"), "---\nschemaVersion: 1\npattern: state-change\nswimlane: order\nversion: 1\n---\nbody\n");
    const report = reportFor(`slice "Invalid" {\n  command Do Thing note "slices/invalid.md"\n}`);
    const entry = report.slices.find((s) => s.key === "invalid")!;
    expect(entry.inScope).toBe(false);
    expect(entry.status).toBeNull();
    expect(entry.docReason).toBe("frontmatter-invalid");
  });

  it("reports cited: true with citations once a test file mentions the ID", () => {
    writeDoc("cited-slice", "implemented", "## Invariants\n- **INV-1:** must hold\n");
    writeFileSync(join(testsDir, "cited.test.ts"), `// covers INV-1\n`);
    const report = reportFor(`slice "Cited Slice" {\n  command Do Thing note "slices/cited-slice.md"\n}`);
    const entry = report.slices.find((s) => s.key === "cited-slice")!;
    expect(entry.invariants).toEqual([{ id: "INV-1", cited: true, citations: [{ file: "cited.test.ts", line: 1 }] }]);
    expect(report.totalInvariants).toBeGreaterThanOrEqual(1);
    expect(report.uncoveredCount).toBe(report.slices.flatMap((s) => s.invariants).filter((i) => !i.cited).length);
  });

  // MIL-149: a doc's prose narratively citing another slice's invariant ID must not have that ID
  // cross-credited into its own coverage ledger — only the slice whose own Invariants section
  // declares the ID should list it.
  it("does not cross-credit an ID another slice's doc only mentions in prose", () => {
    writeDoc("origin", "implemented", "## Invariants\n- **INV-A-1:** must hold\n");
    writeDoc(
      "mentioner",
      "implemented",
      "## Dependencies & Read Models Affected\nRelies on origin's INV-A-1 also holding.\n",
    );
    const report = reportFor(
      `slice "Origin" {\n  command Do Thing note "slices/origin.md"\n}\nslice "Mentioner" {\n  command Do Other note "slices/mentioner.md"\n}`,
    );
    const origin = report.slices.find((s) => s.key === "origin")!;
    const mentioner = report.slices.find((s) => s.key === "mentioner")!;
    expect(origin.invariants.map((i) => i.id)).toEqual(["INV-A-1"]);
    expect(mentioner.invariants).toEqual([]);
  });
});
