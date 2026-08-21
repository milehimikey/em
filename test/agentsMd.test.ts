// SPDX-License-Identifier: MIT
// Coverage for the AGENTS.md managed section (src/cli/agentsMd.ts, MIL-129): fresh create,
// idempotent re-sync, user content outside the markers preserved, and an existing
// AGENTS.md-without-markers gets the section appended. Same marker-discipline coverage shape as
// test/sliceIndex.test.ts (MIL-98's README Slices table). CLI-level (`em skill install`/
// `em skill sync`) coverage lives in test/cli.test.ts.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncAgentsMd, AGENTS_MD_MARKER } from "../src/cli/agentsMd.js";

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "em-agents-md-"));
}

describe("syncAgentsMd", () => {
  it("creates AGENTS.md with just the managed section when none exists", () => {
    const dir = tmpRepo();
    try {
      const result = syncAgentsMd(dir);
      expect(result).toMatchObject({ created: true, wrote: true, path: join(dir, "AGENTS.md") });

      const content = readFileSync(result.path, "utf8");
      expect(content).toContain(`<!-- GENERATED:${AGENTS_MD_MARKER}:start -->`);
      expect(content).toContain(`<!-- GENERATED:${AGENTS_MD_MARKER}:end -->`);
      expect(content).toContain("em contract");
      expect(content).toContain("em validate <model>.em --slice-ready <slice-key> --json");
      expect(content).toContain("em export <model>.em --slice <slice-key>");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a second run is byte-identical (idempotent) when nothing else changed", () => {
    const dir = tmpRepo();
    try {
      syncAgentsMd(dir);
      const path = join(dir, "AGENTS.md");
      const first = readFileSync(path, "utf8");

      const second = syncAgentsMd(dir);
      expect(second).toMatchObject({ created: false, wrote: false });
      expect(readFileSync(path, "utf8")).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("updates the section in place, leaving user content outside the markers untouched", () => {
    const dir = tmpRepo();
    try {
      const path = join(dir, "AGENTS.md");
      writeFileSync(
        path,
        `# My Project\n\nHand-written intro paragraph.\n\n` +
          `<!-- GENERATED:${AGENTS_MD_MARKER}:start -->\nstale content from an older em\n` +
          `<!-- GENERATED:${AGENTS_MD_MARKER}:end -->\n\n## Other section\nHand-written outro.\n`,
      );

      const result = syncAgentsMd(dir);
      expect(result).toMatchObject({ created: false, wrote: true });

      const content = readFileSync(path, "utf8");
      expect(content).toContain("# My Project");
      expect(content).toContain("Hand-written intro paragraph.");
      expect(content).toContain("## Other section");
      expect(content).toContain("Hand-written outro.");
      expect(content).not.toContain("stale content from an older em");
      expect(content).toContain("em contract");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends the managed section when AGENTS.md exists but has no markers", () => {
    const dir = tmpRepo();
    try {
      const path = join(dir, "AGENTS.md");
      writeFileSync(path, "# My Project\n\nSome hand-maintained notes.\n");

      const result = syncAgentsMd(dir);
      expect(result).toMatchObject({ created: false, wrote: true });

      const content = readFileSync(path, "utf8");
      expect(content.startsWith("# My Project\n\nSome hand-maintained notes.\n")).toBe(true);
      expect(content).toContain(`<!-- GENERATED:${AGENTS_MD_MARKER}:start -->`);
      expect(content).toContain(`<!-- GENERATED:${AGENTS_MD_MARKER}:end -->`);
      expect(content).toContain("em contract");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a re-sync after appending is idempotent too", () => {
    const dir = tmpRepo();
    try {
      const path = join(dir, "AGENTS.md");
      writeFileSync(path, "# My Project\n\nSome hand-maintained notes.\n");

      syncAgentsMd(dir);
      const afterAppend = readFileSync(path, "utf8");

      const second = syncAgentsMd(dir);
      expect(second).toMatchObject({ wrote: false });
      expect(readFileSync(path, "utf8")).toBe(afterAppend);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
