// SPDX-License-Identifier: MIT
// Coverage for `em slice new`'s pure logic (src/cli/sliceNew.ts): the frontmatter/body content
// builder, the pattern enum guard, and the display-name -> filename-key slug. CLI-level
// exit-code/process coverage (writing the file, --force, the printed `note` line, directory
// creation) lives in test/cli.test.ts, same split as `em slice index`.
import { describe, it, expect } from "vitest";
import { buildSliceDocContent, isSlicePattern, sliceDocKey, SLICE_PATTERNS } from "../src/cli/sliceNew.js";

describe("SLICE_PATTERNS / isSlicePattern", () => {
  it("is exactly the 4-value enum from docs/slice-doc-schema.md", () => {
    expect(SLICE_PATTERNS).toEqual(["state-change", "state-view", "automation", "translation"]);
  });

  it("accepts each of the 4 canonical values", () => {
    for (const p of SLICE_PATTERNS) expect(isSlicePattern(p)).toBe(true);
  });

  it("rejects anything else, including display-label casing and near-misses", () => {
    expect(isSlicePattern("State Change")).toBe(false);
    expect(isSlicePattern("state_change")).toBe(false);
    expect(isSlicePattern("bogus")).toBe(false);
    expect(isSlicePattern("")).toBe(false);
  });
});

describe("sliceDocKey", () => {
  it("kebab-slugs a display name the same way em scaffold slugs a model name", () => {
    expect(sliceDocKey("Request Payment")).toBe("request-payment");
    expect(sliceDocKey("Weird!! Name_2")).toBe("weird-name-2");
    expect(sliceDocKey("already-a-slug")).toBe("already-a-slug");
  });
});

describe("buildSliceDocContent", () => {
  it("writes exactly the 5 frontmatter keys required at status: draft, no more", () => {
    const content = buildSliceDocContent("Request Payment", "request-payment", "automation", "System → Payment");
    const fence = content.match(/^---\n([\s\S]*?)\n---\n/);
    expect(fence).not.toBeNull();
    const keys = fence![1]
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.split(":")[0]);
    expect(keys).toEqual(["schemaVersion", "pattern", "swimlane", "status", "version"]);
  });

  it("fills schemaVersion/pattern/swimlane/status/version with the correct values", () => {
    const content = buildSliceDocContent("Request Payment", "request-payment", "automation", "System → Payment");
    expect(content).toContain("schemaVersion: 1\n");
    expect(content).toContain("pattern: automation\n");
    expect(content).toContain("swimlane: System → Payment\n");
    expect(content).toContain("status: draft\n");
    expect(content).toContain("version: 1\n");
  });

  it("body is the # Slice: heading plus the diagram-image stub, nothing else", () => {
    const content = buildSliceDocContent("Request Payment", "request-payment", "automation", "System → Payment");
    const body = content.slice(content.indexOf("---\n", 4) + 4);
    expect(body).toBe("# Slice: Request Payment\n\n![Diagram](./request-payment.svg)\n");
  });

  it("carries no commented-out lineage/implementedIn cruft anywhere in the file", () => {
    const content = buildSliceDocContent("Request Payment", "request-payment", "automation", "System → Payment");
    expect(content).not.toContain("implementedIn");
    expect(content).not.toContain("split-from");
    expect(content).not.toContain("merged-from");
    expect(content).not.toContain("superseded-by");
    // Only the `# Slice: ...` heading line may start with `#` — no `#`-prefixed guidance
    // comment lines (the frontmatter template's lineage-key comments) anywhere else.
    const commentLines = content.split("\n").filter((line) => line.startsWith("#") && !line.startsWith("# Slice:"));
    expect(commentLines).toEqual([]);
  });
});
