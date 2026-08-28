// SPDX-License-Identifier: MIT
// Coverage for `em skill sync`'s core logic (src/cli/skillSync.ts): planSkillSync (pure diff)
// and applySkillSync (the fs mutation). Real tmpdir fixtures throughout — no git involved, so
// none of ledgerCheck.test.ts/skillVersionCheck.test.ts's fake-GitRunner machinery applies here
// (see skillSync.ts's header comment: both sides are directories on disk right now).
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planSkillSync, applySkillSync, planSkillSyncBundle, applySkillSyncBundle } from "../src/cli/skillSync.js";

function makePackagedDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "em-skillsync-packaged-"));
  writeFileSync(join(dir, "SKILL.md"), "---\nem-version: 1.7.0\n---\nbody\n");
  mkdirSync(join(dir, "reference"));
  writeFileSync(join(dir, "reference", "em-dsl.md"), "dsl reference");
  mkdirSync(join(dir, "templates"));
  writeFileSync(join(dir, "templates", "viewer-notes.html"), "<html></html>");
  return dir;
}

describe("planSkillSync", () => {
  it("plans every packaged file as added when nothing is vendored yet", () => {
    const packaged = makePackagedDir();
    const vendored = join(tmpdir(), "em-skillsync-nonexistent-" + Math.random().toString(36).slice(2));
    try {
      const plan = planSkillSync(packaged, vendored);
      expect(plan.unchangedCount).toBe(0);
      expect(plan.changes.map((c) => c.kind)).toEqual(["added", "added", "added"]);
      expect(plan.changes.map((c) => c.relPath).sort()).toEqual([
        "SKILL.md",
        "reference/em-dsl.md",
        "templates/viewer-notes.html",
      ]);
    } finally {
      rmSync(packaged, { recursive: true, force: true });
    }
  });

  it("plans no changes when the vendored copy already matches", () => {
    const packaged = makePackagedDir();
    const vendored = mkdtempSync(join(tmpdir(), "em-skillsync-vendored-"));
    try {
      applySkillSync(planSkillSync(packaged, vendored), packaged, vendored);
      const plan = planSkillSync(packaged, vendored);
      expect(plan.changes).toEqual([]);
      expect(plan.unchangedCount).toBe(3);
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(vendored, { recursive: true, force: true });
    }
  });

  it("plans a locally-edited file as modified", () => {
    const packaged = makePackagedDir();
    const vendored = mkdtempSync(join(tmpdir(), "em-skillsync-vendored-"));
    try {
      applySkillSync(planSkillSync(packaged, vendored), packaged, vendored);
      writeFileSync(join(vendored, "SKILL.md"), "hand-edited content");

      const plan = planSkillSync(packaged, vendored);
      expect(plan.changes).toEqual([{ relPath: "SKILL.md", kind: "modified" }]);
      expect(plan.unchangedCount).toBe(2);
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(vendored, { recursive: true, force: true });
    }
  });

  it("plans a vendored-only file as removed", () => {
    const packaged = makePackagedDir();
    const vendored = mkdtempSync(join(tmpdir(), "em-skillsync-vendored-"));
    try {
      applySkillSync(planSkillSync(packaged, vendored), packaged, vendored);
      writeFileSync(join(vendored, "stray.md"), "not part of the packaged skill");

      const plan = planSkillSync(packaged, vendored);
      expect(plan.changes).toEqual([{ relPath: "stray.md", kind: "removed" }]);
      expect(plan.unchangedCount).toBe(3);
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(vendored, { recursive: true, force: true });
    }
  });

  it("plans a missing packaged file as added even when other vendored files match", () => {
    const packaged = makePackagedDir();
    const vendored = mkdtempSync(join(tmpdir(), "em-skillsync-vendored-"));
    try {
      applySkillSync(planSkillSync(packaged, vendored), packaged, vendored);
      rmSync(join(vendored, "reference", "em-dsl.md"));

      const plan = planSkillSync(packaged, vendored);
      expect(plan.changes).toEqual([{ relPath: "reference/em-dsl.md", kind: "added" }]);
      expect(plan.unchangedCount).toBe(2);
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(vendored, { recursive: true, force: true });
    }
  });
});

describe("applySkillSync", () => {
  it("fresh sync leaves vendoredDir byte-identical to packagedDir", () => {
    const packaged = makePackagedDir();
    const vendored = join(tmpdir(), "em-skillsync-fresh-" + Math.random().toString(36).slice(2));
    try {
      applySkillSync(planSkillSync(packaged, vendored), packaged, vendored);
      expect(planSkillSync(packaged, vendored).changes).toEqual([]);
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(vendored, { recursive: true, force: true });
    }
  });

  it("re-sync overwrites a local edit rather than merging it", () => {
    const packaged = makePackagedDir();
    const vendored = mkdtempSync(join(tmpdir(), "em-skillsync-vendored-"));
    try {
      applySkillSync(planSkillSync(packaged, vendored), packaged, vendored);
      writeFileSync(join(vendored, "SKILL.md"), "a local edit that must not survive");

      applySkillSync(planSkillSync(packaged, vendored), packaged, vendored);
      expect(planSkillSync(packaged, vendored).changes).toEqual([]);
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(vendored, { recursive: true, force: true });
    }
  });

  it("deletes a vendored-only extra file", () => {
    const packaged = makePackagedDir();
    const vendored = mkdtempSync(join(tmpdir(), "em-skillsync-vendored-"));
    try {
      applySkillSync(planSkillSync(packaged, vendored), packaged, vendored);
      writeFileSync(join(vendored, "stray.md"), "not part of the packaged skill");

      applySkillSync(planSkillSync(packaged, vendored), packaged, vendored);
      expect(existsSync(join(vendored, "stray.md"))).toBe(false);
    } finally {
      rmSync(packaged, { recursive: true, force: true });
      rmSync(vendored, { recursive: true, force: true });
    }
  });
});

// MIL-157: the em skill ships as several sibling directories under a shared root rather than
// one — these cover the aggregating loop, not per-file diffing (already covered above).
describe("planSkillSyncBundle / applySkillSyncBundle", () => {
  function makeBundleRoot(dirNames: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "em-skillsync-bundleroot-"));
    for (const name of dirNames) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\nbody\n`);
    }
    return root;
  }

  it("plans one directory-scoped SkillSyncPlan per named directory, unrelated sibling directories untouched", () => {
    const packagedRoot = makeBundleRoot(["alpha", "beta"]);
    const vendoredRoot = mkdtempSync(join(tmpdir(), "em-skillsync-bundlevendored-"));
    // A directory that isn't part of the bundle at all — must survive every bundle operation.
    mkdirSync(join(vendoredRoot, "unrelated-skill"), { recursive: true });
    writeFileSync(join(vendoredRoot, "unrelated-skill", "SKILL.md"), "not part of the em bundle");
    try {
      const bundlePlan = planSkillSyncBundle(packagedRoot, vendoredRoot, ["alpha", "beta"]);
      expect(bundlePlan.map((p) => p.dirName)).toEqual(["alpha", "beta"]);
      expect(bundlePlan.every((p) => p.plan.changes.length === 1 && p.plan.changes[0].kind === "added")).toBe(true);

      applySkillSyncBundle(bundlePlan, packagedRoot, vendoredRoot);
      expect(existsSync(join(vendoredRoot, "alpha", "SKILL.md"))).toBe(true);
      expect(existsSync(join(vendoredRoot, "beta", "SKILL.md"))).toBe(true);
      expect(existsSync(join(vendoredRoot, "unrelated-skill", "SKILL.md"))).toBe(true);

      // Re-planning after apply reports no further changes for the bundle's own directories.
      const replanned = planSkillSyncBundle(packagedRoot, vendoredRoot, ["alpha", "beta"]);
      expect(replanned.every((p) => p.plan.changes.length === 0)).toBe(true);
    } finally {
      rmSync(packagedRoot, { recursive: true, force: true });
      rmSync(vendoredRoot, { recursive: true, force: true });
    }
  });
});
