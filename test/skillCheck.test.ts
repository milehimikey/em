// SPDX-License-Identifier: MIT
// Coverage for `em skill check`'s core logic (src/cli/skillCheck.ts): the two independent
// findings (em-version: stamp mismatch, content drift against the packaged skill) and their
// interaction. Real tmpdir fixtures — no git, same rationale as skillSync.test.ts.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSkillSync } from "../src/cli/skillCheck.js";
import { planSkillSync, applySkillSync } from "../src/cli/skillSync.js";
import { buildSkillCheckJson } from "../src/emit/skillCheckJson.js";

function makePackagedDir(version = "1.7.0"): string {
  const dir = mkdtempSync(join(tmpdir(), "em-skillcheck-packaged-"));
  writeFileSync(join(dir, "SKILL.md"), `---\nem-version: ${version}\n---\nbody\n`);
  mkdirSync(join(dir, "reference"));
  writeFileSync(join(dir, "reference", "em-dsl.md"), "dsl reference");
  return dir;
}

function syncedVendoredDir(packaged: string): string {
  const vendored = mkdtempSync(join(tmpdir(), "em-skillcheck-vendored-"));
  applySkillSync(planSkillSync(packaged, vendored), packaged, vendored);
  return vendored;
}

describe("checkSkillSync", () => {
  it("reports skill-check-not-installed when nothing is vendored", () => {
    const packaged = makePackagedDir();
    const vendored = join(tmpdir(), "em-skillcheck-missing-" + Math.random().toString(36).slice(2));
    try {
      const result = checkSkillSync(packaged, vendored, "1.7.0");
      expect(result.ok).toBe(false);
      expect(result.findings).toEqual([
        {
          code: "skill-check-not-installed",
          message: `no vendored skill found at ${vendored} — run \`em skill sync\` first`,
        },
      ]);
    } finally {
      rmSync(packaged, { recursive: true, force: true });
    }
  });

  it("is clean when a freshly synced copy matches the installed version", () => {
    const packaged = makePackagedDir("1.7.0");
    const vendored = syncedVendoredDir(packaged);
    try {
      const result = checkSkillSync(packaged, vendored, "1.7.0");
      expect(result).toEqual({ ok: true, findings: [] });
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(vendored, { recursive: true, force: true });
    }
  });

  it("reports skill-check-stamp-missing when SKILL.md has no em-version: frontmatter", () => {
    const packaged = makePackagedDir("1.7.0");
    const vendored = syncedVendoredDir(packaged);
    try {
      writeFileSync(join(vendored, "SKILL.md"), "---\nname: event-modeling\n---\nbody\n");
      const result = checkSkillSync(packaged, vendored, "1.7.0");
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.code)).toContain("skill-check-stamp-missing");
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(vendored, { recursive: true, force: true });
    }
  });

  it("reports skill-check-stamp-mismatch when the vendored stamp is stale", () => {
    const packaged = makePackagedDir("1.8.0");
    // vendored copy was synced against an older packaged skill (1.7.0), installed em is 1.8.0
    const stalePackaged = makePackagedDir("1.7.0");
    const staleVendored = syncedVendoredDir(stalePackaged);
    try {
      const result = checkSkillSync(packaged, staleVendored, "1.8.0");
      expect(result.ok).toBe(false);
      expect(result.findings).toContainEqual({
        code: "skill-check-stamp-mismatch",
        message: "vendored skill's em-version: stamp (1.7.0) doesn't match installed em (1.8.0) — run `em skill sync`",
        vendoredStamp: "1.7.0",
        installedVersion: "1.8.0",
      });
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(stalePackaged, { recursive: true, force: true });
      rmSync(staleVendored, { recursive: true, force: true });
    }
  });

  it("reports skill-check-content-drift when a file was hand-edited even though the stamp still matches", () => {
    const packaged = makePackagedDir("1.7.0");
    const vendored = syncedVendoredDir(packaged);
    try {
      writeFileSync(join(vendored, "reference", "em-dsl.md"), "a hand edit, stamp untouched");
      const result = checkSkillSync(packaged, vendored, "1.7.0");
      expect(result.ok).toBe(false);
      expect(result.findings).toEqual([
        {
          code: "skill-check-content-drift",
          message: "vendored skill differs from the packaged skill in 1 file(s) — run `em skill sync`",
          driftedFiles: ["reference/em-dsl.md"],
        },
      ]);
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(vendored, { recursive: true, force: true });
    }
  });

  it("reports both stamp mismatch and content drift together, not short-circuited", () => {
    const packaged = makePackagedDir("1.8.0");
    const stalePackaged = makePackagedDir("1.7.0");
    const vendored = syncedVendoredDir(stalePackaged);
    try {
      writeFileSync(join(vendored, "reference", "em-dsl.md"), "hand-edited on top of a stale sync");
      const result = checkSkillSync(packaged, vendored, "1.8.0");
      expect(result.ok).toBe(false);
      expect(result.findings.map((f) => f.code).sort()).toEqual(["skill-check-content-drift", "skill-check-stamp-mismatch"]);
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(stalePackaged, { recursive: true, force: true });
      rmSync(vendored, { recursive: true, force: true });
    }
  });

  it("--json shape: buildSkillCheckJson wraps the result in the documented envelope", () => {
    const packaged = makePackagedDir("1.7.0");
    const vendored = syncedVendoredDir(packaged);
    try {
      const result = checkSkillSync(packaged, vendored, "1.7.0");
      const json = JSON.parse(buildSkillCheckJson(result, vendored, "1.7.0"));
      expect(json).toMatchObject({
        skillCheckSchemaVersion: "1.0",
        generator: { name: "@milehimikey/em" },
        installedVersion: "1.7.0",
        vendoredDir: vendored,
        findings: [],
        ok: true,
      });
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(vendored, { recursive: true, force: true });
    }
  });
});
