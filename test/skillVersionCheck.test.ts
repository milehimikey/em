// SPDX-License-Identifier: MIT
// Coverage for MIL-92's version-stamp release gate (src/cli/skillVersionCheck.ts): does
// package.json's version and SKILL.md's em-version: stamp move together across two revisions.
// Same fake-GitRunner convention as test/ledgerCheck.test.ts — every branch exercised without a
// subprocess or a real repository. `to` is always a concrete revision here (never null/working
// tree); the working-tree form is covered separately below via a real temp-file fixture.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSkillVersionStamp } from "../src/cli/skillVersionCheck.js";
import { GitResult, GitRunner } from "../src/cli/diff-inputs.js";

const fakeGit = (responses: GitResult[]): GitRunner => {
  let i = 0;
  return () => responses[i++] ?? { status: 1, stdout: "", stderr: "unexpected extra git call" };
};
const ok = (stdout: string): GitResult => ({ status: 0, stdout, stderr: "" });

const pkgJson = (version: string): string => JSON.stringify({ name: "@milehimikey/em", version });
const skillMd = (emVersion: string | null): string =>
  emVersion === null
    ? `---\nname: event-modeling\ndescription: x\n---\nbody\n`
    : `---\nname: event-modeling\nem-version: ${emVersion}\ndescription: x\n---\nbody\n`;

/** The 6-call sequence `readAt` makes for one path resolved at one revision (rev-parse +
 *  ls-tree + show), doubled for from+to, doubled again for pkgJson+skillMd = 12 calls total
 *  when every read succeeds. */
function responses(oldPkg: string, newPkg: string, oldSkill: string, newSkill: string): GitResult[] {
  const at = (relPath: string, content: string): GitResult[] => [ok("/repo\n"), ok(`${relPath}\n`), ok(content)];
  return [
    ...at("package.json", oldPkg), // pkgJson @ from
    ...at("package.json", newPkg), // pkgJson @ to
    ...at(".claude/skills/event-modeling/SKILL.md", oldSkill), // skillMd @ from
    ...at(".claude/skills/event-modeling/SKILL.md", newSkill), // skillMd @ to
  ];
}

describe("checkSkillVersionStamp", () => {
  it("reports no finding when package.json and the stamp bump together", () => {
    const result = checkSkillVersionStamp(
      "package.json",
      "SKILL.md",
      "HEAD~1",
      "HEAD",
      fakeGit(responses(pkgJson("1.7.0"), pkgJson("1.8.0"), skillMd("1.7.0"), skillMd("1.8.0"))),
    );
    expect(result).toEqual({ finding: null, skipped: null });
  });

  it("reports no finding when neither changed", () => {
    const result = checkSkillVersionStamp(
      "package.json",
      "SKILL.md",
      "HEAD~1",
      "HEAD",
      fakeGit(responses(pkgJson("1.7.0"), pkgJson("1.7.0"), skillMd("1.7.0"), skillMd("1.7.0"))),
    );
    expect(result).toEqual({ finding: null, skipped: null });
  });

  it("flags a package.json bump with no matching stamp move", () => {
    const result = checkSkillVersionStamp(
      "package.json",
      "SKILL.md",
      "HEAD~1",
      "HEAD",
      fakeGit(responses(pkgJson("1.7.0"), pkgJson("1.8.0"), skillMd("1.7.0"), skillMd("1.7.0"))),
    );
    expect(result.skipped).toBeNull();
    expect(result.finding).toEqual({
      code: "skill-version-stamp-not-bumped",
      message: "package.json bumped 1.7.0 -> 1.8.0 but SKILL.md's em-version: stamp stayed at 1.7.0",
      oldPkgVersion: "1.7.0",
      newPkgVersion: "1.8.0",
      oldStamp: "1.7.0",
      newStamp: "1.7.0",
    });
  });

  it("flags a stamp bump with no matching package.json move", () => {
    const result = checkSkillVersionStamp(
      "package.json",
      "SKILL.md",
      "HEAD~1",
      "HEAD",
      fakeGit(responses(pkgJson("1.7.0"), pkgJson("1.7.0"), skillMd("1.7.0"), skillMd("1.8.0"))),
    );
    expect(result.skipped).toBeNull();
    expect(result.finding).toEqual({
      code: "skill-version-stamp-stray-bump",
      message: "SKILL.md's em-version: stamp changed (1.7.0 -> 1.8.0) but package.json's version didn't move (still 1.7.0)",
      oldPkgVersion: "1.7.0",
      newPkgVersion: "1.7.0",
      oldStamp: "1.7.0",
      newStamp: "1.8.0",
    });
  });

  it("treats the stamp's first-ever introduction (none -> a value) as clean, not a stray bump — nothing to compare it against", () => {
    const result = checkSkillVersionStamp(
      "package.json",
      "SKILL.md",
      "HEAD~1",
      "HEAD",
      fakeGit(responses(pkgJson("1.7.0"), pkgJson("1.7.0"), skillMd(null), skillMd("1.7.0"))),
    );
    expect(result).toEqual({ finding: null, skipped: null });
  });

  it("skips with stamp-missing when the target revision's SKILL.md has no em-version: at all", () => {
    const result = checkSkillVersionStamp(
      "package.json",
      "SKILL.md",
      "HEAD~1",
      "HEAD",
      fakeGit(responses(pkgJson("1.7.0"), pkgJson("1.7.0"), skillMd(null), skillMd(null))),
    );
    expect(result).toEqual({ finding: null, skipped: "stamp-missing" });
  });

  it("skips with package-json-unreadable when a revision can't be resolved", () => {
    const runGit = fakeGit([{ status: 128, stdout: "", stderr: "fatal: bad revision" }]);
    const result = checkSkillVersionStamp("package.json", "SKILL.md", "not-a-rev", "HEAD", runGit);
    expect(result).toEqual({ finding: null, skipped: "package-json-unreadable" });
  });
});

describe("checkSkillVersionStamp: working-tree form (to: null)", () => {
  it("reads the current on-disk files directly, no git call for the `to` side", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-skill-version-"));
    try {
      const pkgPath = join(dir, "package.json");
      const skillPath = join(dir, "SKILL.md");
      writeFileSync(pkgPath, pkgJson("1.8.0"));
      writeFileSync(skillPath, skillMd("1.7.0"));

      // Only the `from` side hits git (2 paths x 3 calls); `to: null` reads pkgPath/skillPath
      // straight off disk.
      const runGit = fakeGit([...atFrom("package.json", pkgJson("1.7.0")), ...atFrom("SKILL.md", skillMd("1.7.0"))]);
      const result = checkSkillVersionStamp(pkgPath, skillPath, "HEAD~1", null, runGit);
      expect(result.finding?.code).toBe("skill-version-stamp-not-bumped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function atFrom(relPath: string, content: string): GitResult[] {
  return [ok("/repo\n"), ok(`${relPath}\n`), ok(content)];
}
