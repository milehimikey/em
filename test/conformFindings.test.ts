// SPDX-License-Identifier: MIT
// Coverage for src/cli/findings.ts (MIL-214): the conformance findings record — deterministic
// serialization, shape validation (`em conform-findings check`), the sibling-path lookup
// (`lookupFindingsBesideReport`), the shared unruled-in-scope predicate every consumer (`em
// slice conform`, `em state set-conformance`, `em status`) reuses, the `--findings` spec parser,
// and the pure ruling transform `em conform-supersede --locus --by` applies.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyFindingsRuling,
  buildCheckFindingsJson,
  checkFindingsFile,
  findingsPathForReport,
  Finding,
  FindingsDoc,
  listAllFindingsFiles,
  lookupFindingsBesideReport,
  parseFindingsSpec,
  serializeFindingsDoc,
  unruledFindingsInScope,
  validateFindingsShape,
} from "../src/cli/findings.js";

function sampleFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: 1,
    surface: "structural",
    class: "Real drift",
    slice: "checkout",
    evidence: "code shows X at path/to/File.kt:42",
    locus: null,
    resolvedBy: null,
    resolvedOn: null,
    ...overrides,
  };
}

function sampleDoc(findings: Finding[] = [sampleFinding()]): FindingsDoc {
  return {
    findingsSchemaVersion: "1.0",
    model: "checkout.em",
    report: "conformance/2026-09-01-report.md",
    revision: "8f12ed8",
    findings,
  };
}

describe("serializeFindingsDoc", () => {
  it("sorts findings by id and produces alphabetically-keyed, 2-space, trailing-newline JSON", () => {
    const doc = sampleDoc([sampleFinding({ id: 2, slice: "billing" }), sampleFinding({ id: 1 })]);
    const text = serializeFindingsDoc(doc);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    const parsed = JSON.parse(text);
    expect(parsed.findings.map((f: Finding) => f.id)).toEqual([1, 2]);
    // Top-level keys in alphabetical order.
    expect(Object.keys(parsed)).toEqual(["findings", "findingsSchemaVersion", "model", "report", "revision"]);
    // Per-finding keys in alphabetical order.
    expect(Object.keys(parsed.findings[0])).toEqual([
      "class",
      "evidence",
      "id",
      "locus",
      "resolvedBy",
      "resolvedOn",
      "slice",
      "surface",
    ]);
  });

  it("is deterministic: the same doc serializes to byte-identical text every time", () => {
    const doc = sampleDoc();
    expect(serializeFindingsDoc(doc)).toBe(serializeFindingsDoc(doc));
  });
});

describe("validateFindingsShape", () => {
  it("accepts a well-formed document, unruled findings included", () => {
    const result = validateFindingsShape(JSON.parse(serializeFindingsDoc(sampleDoc())));
    expect(result.ok).toBe(true);
  });

  it("accepts a ruled finding carrying resolvedBy/resolvedOn", () => {
    const ruled = sampleFinding({ locus: "code", resolvedBy: "Alex Rivera", resolvedOn: "2026-09-02" });
    const result = validateFindingsShape(JSON.parse(serializeFindingsDoc(sampleDoc([ruled]))));
    expect(result.ok).toBe(true);
  });

  it("refuses a non-object top level", () => {
    expect(validateFindingsShape(null)).toEqual({ ok: false, errors: ["top-level value must be a JSON object"] });
    expect(validateFindingsShape([1, 2])).toEqual({ ok: false, errors: ["top-level value must be a JSON object"] });
    expect(validateFindingsShape("nope").ok).toBe(false);
  });

  it("reports every missing top-level string field", () => {
    const result = validateFindingsShape({ findings: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('"findingsSchemaVersion" must be a non-empty string');
    expect(result.errors).toContain('"model" must be a non-empty string');
    expect(result.errors).toContain('"report" must be a non-empty string');
    expect(result.errors).toContain('"revision" must be a non-empty string');
  });

  it("refuses a non-array findings field", () => {
    const result = validateFindingsShape({ ...sampleDoc([]), findings: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain('"findings" must be an array');
  });

  it("refuses a non-integer id", () => {
    const result = validateFindingsShape(sampleDoc([sampleFinding({ id: 1.5 as unknown as number })]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("findings[0].id must be an integer");
  });

  it("refuses duplicate ids", () => {
    const result = validateFindingsShape(sampleDoc([sampleFinding({ id: 1 }), sampleFinding({ id: 1, slice: "billing" })]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("duplicate"))).toBe(true);
  });

  it("refuses out-of-order ids", () => {
    const result = validateFindingsShape(sampleDoc([sampleFinding({ id: 2 }), sampleFinding({ id: 1, slice: "billing" })]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.includes("out of order"))).toBe(true);
  });

  it("refuses an unknown surface", () => {
    const result = validateFindingsShape(sampleDoc([sampleFinding({ surface: "bogus" as Finding["surface"] })]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("findings[0].surface must be one of: structural, spec, internal, other");
  });

  it("refuses an unknown locus", () => {
    const result = validateFindingsShape(sampleDoc([sampleFinding({ locus: "bogus" as Finding["locus"] })]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("findings[0].locus must be null or one of: model, doc, code, none");
  });

  it("requires resolvedBy AND resolvedOn once locus is set", () => {
    const missingBy = validateFindingsShape(sampleDoc([sampleFinding({ locus: "code", resolvedOn: "2026-09-02" })]));
    expect(missingBy.ok).toBe(false);
    if (missingBy.ok) return;
    expect(missingBy.errors).toContain("findings[0].resolvedBy is required once locus is set");

    const missingOn = validateFindingsShape(sampleDoc([sampleFinding({ locus: "code", resolvedBy: "Alex" })]));
    expect(missingOn.ok).toBe(false);
    if (missingOn.ok) return;
    expect(missingOn.errors).toContain("findings[0].resolvedOn is required once locus is set");
  });

  it("refuses an invalid resolvedOn date shape even when present", () => {
    const result = validateFindingsShape(
      sampleDoc([sampleFinding({ locus: "code", resolvedBy: "Alex", resolvedOn: "not-a-date" })]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("findings[0].resolvedOn must be a YYYY-MM-DD string or null");
  });

  it("accepts slice: null (a whole-model finding)", () => {
    const result = validateFindingsShape(sampleDoc([sampleFinding({ slice: null })]));
    expect(result.ok).toBe(true);
  });

  it("refuses an empty evidence/class string", () => {
    const result = validateFindingsShape(sampleDoc([sampleFinding({ evidence: "", class: "" })]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toContain("findings[0].evidence must be a non-empty string");
    expect(result.errors).toContain("findings[0].class must be a non-empty string");
  });
});

describe("findingsPathForReport", () => {
  it("swaps -report.md for -findings.json", () => {
    expect(findingsPathForReport("conformance/2026-09-01-report.md")).toBe("conformance/2026-09-01-findings.json");
  });

  it("returns null for a report path that doesn't follow the convention", () => {
    expect(findingsPathForReport("conformance/report.md")).toBeNull();
    expect(findingsPathForReport("r.md")).toBeNull();
  });
});

describe("unruledFindingsInScope", () => {
  const findings: Finding[] = [
    sampleFinding({ id: 1, slice: "checkout" }), // unruled, in scope
    sampleFinding({ id: 2, slice: "billing" }), // unruled, NOT in scope
    sampleFinding({ id: 3, slice: null }), // unruled, slice: null — always in scope
    sampleFinding({ id: 4, slice: "checkout", locus: "code", resolvedBy: "Alex", resolvedOn: "2026-09-02" }), // ruled
  ];

  it("counts an in-scope slice's unruled finding and every slice:null finding, excludes out-of-scope/ruled", () => {
    const result = unruledFindingsInScope(findings, new Set(["checkout"]));
    expect(result.map((f) => f.id)).toEqual([1, 3]);
  });

  it("returns [] when nothing is in scope but there's also no slice:null finding", () => {
    const result = unruledFindingsInScope(
      [sampleFinding({ id: 1, slice: "checkout" })],
      new Set(["billing"]),
    );
    expect(result).toEqual([]);
  });
});

describe("parseFindingsSpec", () => {
  it("parses a single number", () => {
    expect(parseFindingsSpec("1")).toEqual([1]);
  });
  it("parses a comma-separated list", () => {
    expect(parseFindingsSpec("1, 2, 4")).toEqual([1, 2, 4]);
  });
  it("parses a range", () => {
    expect(parseFindingsSpec("1-3")).toEqual([1, 2, 3]);
  });
  it("parses a range with an en-dash", () => {
    expect(parseFindingsSpec("1–3")).toEqual([1, 2, 3]);
  });
  it("dedupes and sorts", () => {
    expect(parseFindingsSpec("3, 1-2, 2")).toEqual([1, 2, 3]);
  });
  it("returns null for an empty spec", () => {
    expect(parseFindingsSpec("")).toBeNull();
    expect(parseFindingsSpec("   ")).toBeNull();
  });
  it("returns null for a reversed range", () => {
    expect(parseFindingsSpec("3-1")).toBeNull();
  });
  it("returns null for a stray non-numeric token", () => {
    expect(parseFindingsSpec("1, abc")).toBeNull();
  });
});

describe("applyFindingsRuling", () => {
  it("records locus/resolvedBy/resolvedOn on the named finding(s), leaves others untouched", () => {
    const doc = sampleDoc([sampleFinding({ id: 1 }), sampleFinding({ id: 2, slice: "billing" })]);
    const result = applyFindingsRuling(doc, [1], "code", "Alex Rivera", "2026-09-02");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.doc.findings[0]).toEqual({
      ...sampleFinding({ id: 1 }),
      locus: "code",
      resolvedBy: "Alex Rivera",
      resolvedOn: "2026-09-02",
    });
    expect(result.doc.findings[1]).toEqual(sampleFinding({ id: 2, slice: "billing" })); // untouched
  });

  it("is idempotent on the exact same ruling (changed: false)", () => {
    const doc = sampleDoc([sampleFinding({ id: 1, locus: "code", resolvedBy: "Alex Rivera", resolvedOn: "2026-09-02" })]);
    const result = applyFindingsRuling(doc, [1], "code", "Alex Rivera", "2026-09-02");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
  });

  it("refuses to overwrite an already-different locus", () => {
    const doc = sampleDoc([sampleFinding({ id: 1, locus: "code", resolvedBy: "Alex Rivera", resolvedOn: "2026-09-02" })]);
    const result = applyFindingsRuling(doc, [1], "doc", "Jordan Lee", "2026-09-03");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('finding 1 already has locus "code"');
  });

  it("refuses when a named id doesn't exist", () => {
    const doc = sampleDoc([sampleFinding({ id: 1 })]);
    const result = applyFindingsRuling(doc, [99], "code", "Alex Rivera", "2026-09-02");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("no finding(s) with id 99");
  });

  it("refuses a blank resolver name", () => {
    const doc = sampleDoc([sampleFinding({ id: 1 })]);
    const result = applyFindingsRuling(doc, [1], "code", "   ", "2026-09-02");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe("a resolver name is required (--by)");
  });

  it("refuses a malformed date", () => {
    const doc = sampleDoc([sampleFinding({ id: 1 })]);
    const result = applyFindingsRuling(doc, [1], "code", "Alex Rivera", "nope");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe('invalid date "nope" — expected YYYY-MM-DD');
  });
});

describe("lookupFindingsBesideReport / listAllFindingsFiles / checkFindingsFile (real fs)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "em-conform-findings-"));
    mkdirSync(join(dir, "conformance"), { recursive: true });
    writeFileSync(join(dir, "conformance", "2026-09-01-report.md"), "# Report\n\nClean.\n");
    writeFileSync(join(dir, "conformance", "2026-09-01-findings.json"), serializeFindingsDoc(sampleDoc()));
    writeFileSync(join(dir, "conformance", "2026-08-15-findings.json"), serializeFindingsDoc(sampleDoc([sampleFinding({ id: 5 })])));
    writeFileSync(join(dir, "conformance", "legacy-notes.md"), "# Legacy\n\nClean.\n");
    writeFileSync(join(dir, "conformance", "broken-findings.json"), "not json at all");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("found: parses and shape-validates the sibling findings JSON", () => {
    const result = lookupFindingsBesideReport(dir, "conformance/2026-09-01-report.md");
    expect(result.kind).toBe("found");
    if (result.kind !== "found") return;
    expect(result.path).toBe("conformance/2026-09-01-findings.json");
    expect(result.doc.findings).toHaveLength(1);
  });

  it("absent: report path doesn't follow the <date>-report.md convention", () => {
    expect(lookupFindingsBesideReport(dir, "conformance/legacy-notes.md")).toEqual({ kind: "absent" });
  });

  it("absent: no sibling findings file exists at all", () => {
    writeFileSync(join(dir, "conformance", "2026-09-05-report.md"), "# Report\n");
    expect(lookupFindingsBesideReport(dir, "conformance/2026-09-05-report.md")).toEqual({ kind: "absent" });
  });

  it("invalid: sibling exists but isn't valid JSON", () => {
    writeFileSync(join(dir, "conformance", "2026-09-06-report.md"), "# Report\n");
    writeFileSync(join(dir, "conformance", "2026-09-06-findings.json"), "not json");
    const result = lookupFindingsBesideReport(dir, "conformance/2026-09-06-report.md");
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.message).toContain("not valid JSON");
  });

  it("listAllFindingsFiles returns every valid findings file, newest filename first, skipping malformed ones", () => {
    const files = listAllFindingsFiles(dir);
    const paths = files.map((f) => f.path);
    expect(paths).toContain("conformance/2026-09-01-findings.json");
    expect(paths).toContain("conformance/2026-08-15-findings.json");
    expect(paths).not.toContain("conformance/broken-findings.json");
    expect(paths.indexOf("conformance/2026-09-01-findings.json")).toBeLessThan(paths.indexOf("conformance/2026-08-15-findings.json"));
  });

  it("checkFindingsFile: ok with a findings count for a valid file", () => {
    const result = checkFindingsFile(join(dir, "conformance", "2026-09-01-findings.json"));
    expect(result).toEqual({ ok: true, path: join(dir, "conformance", "2026-09-01-findings.json"), findingsCount: 1 });
  });

  it("checkFindingsFile: reports errors for an invalid file", () => {
    const result = checkFindingsFile(join(dir, "conformance", "broken-findings.json"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toContain("not valid JSON");
  });

  it("checkFindingsFile: reports a clear error for a missing file", () => {
    const result = checkFindingsFile(join(dir, "conformance", "no-such-file.json"));
    expect(result).toEqual({ ok: false, path: join(dir, "conformance", "no-such-file.json"), errors: [`no such file: ${join(dir, "conformance", "no-such-file.json")}`] });
  });

  it("buildCheckFindingsJson mirrors the ok/error shape", () => {
    const ok = checkFindingsFile(join(dir, "conformance", "2026-09-01-findings.json"));
    const okJson = JSON.parse(buildCheckFindingsJson(ok));
    expect(okJson).toEqual({ ok: true, path: join(dir, "conformance", "2026-09-01-findings.json"), findingsCount: 1, errors: [] });

    const bad = checkFindingsFile(join(dir, "conformance", "broken-findings.json"));
    const badJson = JSON.parse(buildCheckFindingsJson(bad));
    expect(badJson.ok).toBe(false);
    expect(badJson.findingsCount).toBeNull();
    expect(badJson.errors.length).toBeGreaterThan(0);
  });
});

describe("round-trip: serializeFindingsDoc -> readFileSync -> validateFindingsShape", () => {
  it("a written-then-read document validates and matches the original content", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-conform-findings-roundtrip-"));
    try {
      const path = join(dir, "findings.json");
      const doc = sampleDoc([sampleFinding({ id: 2, slice: "billing" }), sampleFinding({ id: 1 })]);
      writeFileSync(path, serializeFindingsDoc(doc));
      const raw = readFileSync(path, "utf8");
      const parsed = validateFindingsShape(JSON.parse(raw));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.doc.findings.map((f) => f.id)).toEqual([1, 2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
