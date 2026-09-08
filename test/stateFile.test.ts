// SPDX-License-Identifier: MIT
// Coverage for `em state`'s pure module (src/cli/stateFile.ts):
// - parseState: a scaffolded state file (both "never" markers), a file with both markers
//   filled, and missing-bullet errors.
// - setPhase / setConformance / setReview: exact output line format, "Last updated:" refresh,
//   byte-identical elsewhere, missing-bullet errors.
// - isPhase / isValidDateString / resolveStateFilePath.
// - Round-trip: write then read back the same values.
// CLI wiring (src/cli.ts `em state ...`) gets its own coverage in test/cli.test.ts, spawning
// the real CLI, same split as em changelog (test/changelog.test.ts vs test/cli.test.ts).
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldStateFile } from "../src/templates.js";
import {
  PHASES,
  isPhase,
  isValidDateString,
  resolveStateFilePath,
  loadStateFile,
  parseState,
  setPhase,
  setConformance,
  setModelVersion,
  setCertified,
  setReview,
  modelPathMismatch,
  STATE_FILE_NAME,
} from "../src/cli/stateFile.js";

const SCAFFOLDED = scaffoldStateFile("Order Fulfillment", "order-fulfillment", "2026-08-20");

// A hand-built state file with both markers filled, mirroring what set-conformance/set-review
// would have written on a prior run — used to test parseState's "filled" path since
// scaffoldStateFile always writes "never" for both.
const FILLED = SCAFFOLDED.replace("- **Last conformance:** never", "- **Last conformance:** 2026-08-01 @ abc123f — report: conformance/2026-08-01-report.md").replace(
  "- **Last stakeholder review:** never",
  "- **Last stakeholder review:** 2026-08-02 — attendees: see Participants",
);

describe("PHASES / isPhase", () => {
  it("matches templates/state.md's Current phase placeholder list exactly", () => {
    expect(PHASES).toEqual(["discover", "extract", "model", "slice", "implement", "conform", "review", "validate"]);
  });

  it("accepts every canonical phase and rejects anything else, including watch", () => {
    for (const p of PHASES) expect(isPhase(p)).toBe(true);
    expect(isPhase("watch")).toBe(false);
    expect(isPhase("bogus")).toBe(false);
    expect(isPhase("")).toBe(false);
  });
});

describe("isValidDateString", () => {
  it("accepts well-formed YYYY-MM-DD", () => {
    expect(isValidDateString("2026-08-20")).toBe(true);
    expect(isValidDateString("2026-01-01")).toBe(true);
    expect(isValidDateString("2026-12-31")).toBe(true);
  });

  it("rejects malformed or out-of-range dates", () => {
    expect(isValidDateString("2026-8-20")).toBe(false);
    expect(isValidDateString("08-20-2026")).toBe(false);
    expect(isValidDateString("2026-13-01")).toBe(false);
    expect(isValidDateString("2026-00-01")).toBe(false);
    expect(isValidDateString("2026-01-32")).toBe(false);
    expect(isValidDateString("not-a-date")).toBe(false);
    expect(isValidDateString("")).toBe(false);
  });
});

describe("resolveStateFilePath", () => {
  it("joins a directory with the state filename", () => {
    expect(resolveStateFilePath("my-model")).toBe(join("my-model", STATE_FILE_NAME));
    expect(resolveStateFilePath(".")).toBe(join(".", STATE_FILE_NAME));
  });

  it("uses a direct path to the state file as-is", () => {
    const direct = join("my-model", STATE_FILE_NAME);
    expect(resolveStateFilePath(direct)).toBe(direct);
  });
});

describe("parseState", () => {
  it("reads a freshly scaffolded state file (both markers 'never')", () => {
    const result = parseState(SCAFFOLDED);
    expect(result).toEqual({
      ok: true,
      state: {
        modelPath: "order-fulfillment.em",
        phase: "discover",
        step: "1",
        lastUpdated: "2026-08-20",
        lastConformance: null,
        modelVersion: null,
        certified: null,
        lastReview: null,
      },
    });
  });

  it("reads a state file with both markers filled", () => {
    const result = parseState(FILLED);
    expect(result).toEqual({
      ok: true,
      state: {
        modelPath: "order-fulfillment.em",
        phase: "discover",
        step: "1",
        lastUpdated: "2026-08-20",
        lastConformance: {
          date: "2026-08-01",
          revision: "abc123f",
          report: "conformance/2026-08-01-report.md",
          partial: false,
        },
        modelVersion: null,
        certified: null,
        lastReview: "2026-08-02",
      },
    });
  });

  it("reads the MIL-214 ` (partial)` suffix as partial: true", () => {
    const partialFilled = FILLED.replace(
      "- **Last conformance:** 2026-08-01 @ abc123f — report: conformance/2026-08-01-report.md",
      "- **Last conformance:** 2026-08-01 @ abc123f — report: conformance/2026-08-01-report.md (partial)",
    );
    const result = parseState(partialFilled);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.lastConformance).toEqual({
      date: "2026-08-01",
      revision: "abc123f",
      report: "conformance/2026-08-01-report.md",
      partial: true,
    });
  });

  it("errors clearly when a mechanical bullet is missing", () => {
    const withoutPhase = SCAFFOLDED.split("\n")
      .filter((l) => !l.startsWith("- **Current phase:**"))
      .join("\n");
    const result = parseState(withoutPhase);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('"- **Current phase:**"');
  });

  it("errors on a Last conformance: line that is neither 'never' nor the documented format", () => {
    const bad = SCAFFOLDED.replace("- **Last conformance:** never", "- **Last conformance:** garbage");
    const result = parseState(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Last conformance");
  });

  it("errors on a Last stakeholder review: line that is neither 'never' nor a leading date", () => {
    const bad = SCAFFOLDED.replace("- **Last stakeholder review:** never", "- **Last stakeholder review:** garbage");
    const result = parseState(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Last stakeholder review");
  });

  describe("MIL-218 migration tolerance", () => {
    // A state file predating Model version:/Certified: — both bullets stripped entirely,
    // simulating a file scaffolded before this feature existed.
    const PRE_MIGRATION = SCAFFOLDED.split("\n")
      .filter((l) => !l.startsWith("- **Model version:**") && !l.startsWith("- **Certified:**"))
      .join("\n");

    it("parses a state file missing both bullets as modelVersion: null, certified: null — not an error", () => {
      const result = parseState(PRE_MIGRATION);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.state.modelVersion).toBeNull();
      expect(result.state.certified).toBeNull();
    });

    it("parses a bumped Model version: N", () => {
      const withVersion = PRE_MIGRATION.replace("- **Last conformance:** never", "- **Last conformance:** never\n- **Model version:** 3");
      const result = parseState(withVersion);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.state.modelVersion).toBe(3);
    });

    it("parses a filled Certified: v<N> @ <rev> (date)", () => {
      const withCertified = PRE_MIGRATION.replace(
        "- **Last conformance:** never",
        "- **Last conformance:** never\n- **Certified:** v2 @ abc123f (2026-09-08)",
      );
      const result = parseState(withCertified);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.state.certified).toEqual({ version: 2, revision: "abc123f", date: "2026-09-08" });
    });

    it("errors on a Model version: line that is neither a bare integer nor 'none'", () => {
      const bad = SCAFFOLDED.replace("- **Model version:** none", "- **Model version:** garbage");
      const result = parseState(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("Model version");
    });

    it("errors on a Certified: line that matches neither the documented format nor 'never'", () => {
      const bad = SCAFFOLDED.replace("- **Certified:** never", "- **Certified:** garbage");
      const result = parseState(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("Certified");
    });
  });
});

describe("setPhase", () => {
  it("rewrites Current phase: and Last updated: in the exact bullet format", () => {
    const result = setPhase(SCAFFOLDED, "slice", "2026-08-21");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("- **Current phase:** slice");
    expect(result.text).toContain("- **Last updated:** 2026-08-21");
    expect(result.text).not.toContain("- **Current phase:** discover");
  });

  it("also rewrites Current step: when given", () => {
    const result = setPhase(SCAFFOLDED, "slice", "2026-08-21", "3");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("- **Current step:** 3");
  });

  it("leaves every other line byte-identical", () => {
    const result = setPhase(SCAFFOLDED, "model", "2026-08-21");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const before = SCAFFOLDED.split("\n");
    const after = result.text.split("\n");
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) {
      if (before[i].startsWith("- **Current phase:**") || before[i].startsWith("- **Last updated:**")) continue;
      expect(after[i]).toBe(before[i]);
    }
  });

  it("errors clearly when Current phase: is missing, without writing anything", () => {
    const withoutPhase = SCAFFOLDED.split("\n")
      .filter((l) => !l.startsWith("- **Current phase:**"))
      .join("\n");
    const result = setPhase(withoutPhase, "model", "2026-08-21");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('"- **Current phase:**"');
  });
});

describe("setConformance", () => {
  it("writes the exact format reference/conform.md documents", () => {
    const result = setConformance(SCAFFOLDED, "abc123f", "conformance/2026-08-21-report.md", "2026-08-21");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain(
      "- **Last conformance:** 2026-08-21 @ abc123f — report: conformance/2026-08-21-report.md",
    );
    expect(result.text).toContain("- **Last updated:** 2026-08-21");
  });

  it("leaves every other line byte-identical", () => {
    const result = setConformance(SCAFFOLDED, "abc123f", "conformance/2026-08-21-report.md", "2026-08-21");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const before = SCAFFOLDED.split("\n");
    const after = result.text.split("\n");
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) {
      if (before[i].startsWith("- **Last conformance:**") || before[i].startsWith("- **Last updated:**")) continue;
      expect(after[i]).toBe(before[i]);
    }
  });

  it("errors clearly when Last conformance: is missing", () => {
    const stripped = SCAFFOLDED.split("\n")
      .filter((l) => !l.startsWith("- **Last conformance:**"))
      .join("\n");
    const result = setConformance(stripped, "abc123f", "report.md", "2026-08-21");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('"- **Last conformance:**"');
  });

  it("MIL-214: appends ` (partial)` when partial is true", () => {
    const result = setConformance(SCAFFOLDED, "abc123f", "conformance/2026-08-21-report.md", "2026-08-21", true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain(
      "- **Last conformance:** 2026-08-21 @ abc123f — report: conformance/2026-08-21-report.md (partial)",
    );
  });

  it("omits the suffix when partial is false (the default)", () => {
    const result = setConformance(SCAFFOLDED, "abc123f", "conformance/2026-08-21-report.md", "2026-08-21", false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain(
      "- **Last conformance:** 2026-08-21 @ abc123f — report: conformance/2026-08-21-report.md",
    );
    expect(result.text).not.toContain("(partial)");
  });
});

describe("setModelVersion (MIL-218)", () => {
  it("updates Model version: in place when already present", () => {
    const result = setModelVersion(SCAFFOLDED, 1, "2026-09-08");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("- **Model version:** 1");
    expect(result.text).toContain("- **Last updated:** 2026-09-08");
    expect(result.text).not.toContain("- **Model version:** none");
  });

  it("inserts Model version: right after Last conformance: on a pre-migration file", () => {
    const preMigration = SCAFFOLDED.split("\n")
      .filter((l) => !l.startsWith("- **Model version:**") && !l.startsWith("- **Certified:**"))
      .join("\n");
    const result = setModelVersion(preMigration, 1, "2026-09-08");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.text.split("\n");
    const idx = lines.findIndex((l) => l.startsWith("- **Last conformance:**"));
    expect(lines[idx + 1]).toBe("- **Model version:** 1");
  });

  it("round-trips through parseState", () => {
    const written = setModelVersion(SCAFFOLDED, 2, "2026-09-08");
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const read = parseState(written.text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.state.modelVersion).toBe(2);
  });
});

describe("setCertified (MIL-218)", () => {
  it("updates Certified: in place when already present", () => {
    const result = setCertified(SCAFFOLDED, 1, "abc123f", "2026-09-08", "2026-09-08");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("- **Certified:** v1 @ abc123f (2026-09-08)");
    expect(result.text).not.toContain("- **Certified:** never");
  });

  it("inserts Certified: right after Model version: when that bullet is already present", () => {
    const withVersion = setModelVersion(SCAFFOLDED, 1, "2026-09-08");
    expect(withVersion.ok).toBe(true);
    if (!withVersion.ok) return;
    const preMigrationButVersioned = withVersion.text
      .split("\n")
      .filter((l) => !l.startsWith("- **Certified:**"))
      .join("\n");
    const result = setCertified(preMigrationButVersioned, 1, "abc123f", "2026-09-08", "2026-09-08");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.text.split("\n");
    const idx = lines.findIndex((l) => l.startsWith("- **Model version:**"));
    expect(lines[idx + 1]).toBe("- **Certified:** v1 @ abc123f (2026-09-08)");
  });

  it("falls back to inserting right after Last conformance: when Model version: is absent", () => {
    const preMigration = SCAFFOLDED.split("\n")
      .filter((l) => !l.startsWith("- **Model version:**") && !l.startsWith("- **Certified:**"))
      .join("\n");
    const result = setCertified(preMigration, 1, "abc123f", "2026-09-08", "2026-09-08");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.text.split("\n");
    const idx = lines.findIndex((l) => l.startsWith("- **Last conformance:**"));
    expect(lines[idx + 1]).toBe("- **Certified:** v1 @ abc123f (2026-09-08)");
  });

  it("round-trips through parseState", () => {
    const written = setCertified(SCAFFOLDED, 3, "deadbeef", "2026-09-08", "2026-09-08");
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const read = parseState(written.text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.state.certified).toEqual({ version: 3, revision: "deadbeef", date: "2026-09-08" });
  });
});

describe("setReview", () => {
  it("writes the exact format templates/state.md documents", () => {
    const result = setReview(SCAFFOLDED, "2026-08-21", "2026-08-21");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("- **Last stakeholder review:** 2026-08-21 — attendees: see Participants");
    expect(result.text).toContain("- **Last updated:** 2026-08-21");
  });

  it("leaves every other line byte-identical", () => {
    const result = setReview(SCAFFOLDED, "2026-08-21", "2026-08-21");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const before = SCAFFOLDED.split("\n");
    const after = result.text.split("\n");
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) {
      if (before[i].startsWith("- **Last stakeholder review:**") || before[i].startsWith("- **Last updated:**")) continue;
      expect(after[i]).toBe(before[i]);
    }
  });

  it("errors clearly when Last stakeholder review: is missing", () => {
    const stripped = SCAFFOLDED.split("\n")
      .filter((l) => !l.startsWith("- **Last stakeholder review:**"))
      .join("\n");
    const result = setReview(stripped, "2026-08-21", "2026-08-21");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('"- **Last stakeholder review:**"');
  });
});

describe("round-trip: set then read", () => {
  it("setPhase's output parses back to the values just written", () => {
    const written = setPhase(SCAFFOLDED, "implement", "2026-08-21", "5");
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const read = parseState(written.text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.state.phase).toBe("implement");
    expect(read.state.step).toBe("5");
    expect(read.state.lastUpdated).toBe("2026-08-21");
  });

  it("setConformance's output parses back to the values just written", () => {
    const written = setConformance(SCAFFOLDED, "deadbeef", "conformance/2026-08-21-report.md", "2026-08-21");
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const read = parseState(written.text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.state.lastConformance).toEqual({
      date: "2026-08-21",
      revision: "deadbeef",
      report: "conformance/2026-08-21-report.md",
      partial: false,
    });
  });

  it("setConformance's partial marker round-trips through parseState", () => {
    const written = setConformance(SCAFFOLDED, "deadbeef", "conformance/2026-08-21-report.md", "2026-08-21", true);
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const read = parseState(written.text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.state.lastConformance).toEqual({
      date: "2026-08-21",
      revision: "deadbeef",
      report: "conformance/2026-08-21-report.md",
      partial: true,
    });
  });

  it("a revision containing regex-replacement patterns ($&, $$, $') round-trips literally", () => {
    // Regression: applyBulletUpdates used to pass the value through String.replace's pattern
    // string, where $&/$$/$' etc. expand against the match instead of being inserted literally.
    const revision = "feat/$&x";
    const written = setConformance(SCAFFOLDED, revision, "report.md", "2026-08-21");
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.text).toContain(`- **Last conformance:** 2026-08-21 @ ${revision} — report: report.md`);
    const read = parseState(written.text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.state.lastConformance).toEqual({
      date: "2026-08-21",
      revision,
      report: "report.md",
      partial: false,
    });
  });

  it("setReview's output parses back to the value just written", () => {
    const written = setReview(SCAFFOLDED, "2026-08-21", "2026-08-21");
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const read = parseState(written.text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.state.lastReview).toBe("2026-08-21");
  });
});

describe("modelPathMismatch (MIL-179)", () => {
  it("returns null when modelPath matches file's basename", () => {
    expect(modelPathMismatch("checkout.em", "/models/checkout/checkout.em")).toBeNull();
  });

  it("returns null when modelPath matches, ignoring the file argument's own directory", () => {
    expect(modelPathMismatch("checkout.em", "checkout.em")).toBeNull();
  });

  it("returns the exact non-fatal message when modelPath names a different sibling file", () => {
    expect(modelPathMismatch("checkout.em", "/models/checkout/checkout-asis.em")).toBe(
      'state file describes "checkout.em", not "checkout-asis.em" — not attributing its conformance record',
    );
  });

  it("returns null for an empty modelPath (nothing to compare against)", () => {
    expect(modelPathMismatch("", "/models/checkout/checkout.em")).toBeNull();
  });
});

describe("loadStateFile", () => {
  let dir: string;

  it("reads a state file from a model directory", () => {
    dir = mkdtempSync(join(tmpdir(), "em-state-"));
    writeFileSync(join(dir, STATE_FILE_NAME), SCAFFOLDED);
    const result = loadStateFile(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.path).toBe(join(dir, STATE_FILE_NAME));
      expect(result.text).toBe(SCAFFOLDED);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads a state file given a direct path to it", () => {
    dir = mkdtempSync(join(tmpdir(), "em-state-"));
    const path = join(dir, STATE_FILE_NAME);
    writeFileSync(path, SCAFFOLDED);
    const result = loadStateFile(path);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path).toBe(path);
    rmSync(dir, { recursive: true, force: true });
  });

  it("errors clearly when the file is missing", () => {
    dir = mkdtempSync(join(tmpdir(), "em-state-"));
    const result = loadStateFile(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain(join(dir, STATE_FILE_NAME));
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("scaffoldStateFile compatibility", () => {
  it("still reads correctly after a byte-identical round-trip through readFileSync", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-state-"));
    const path = join(dir, STATE_FILE_NAME);
    writeFileSync(path, SCAFFOLDED);
    const text = readFileSync(path, "utf8");
    expect(parseState(text)).toEqual(parseState(SCAFFOLDED));
    rmSync(dir, { recursive: true, force: true });
  });
});
