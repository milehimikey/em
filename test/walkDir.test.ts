// SPDX-License-Identifier: MIT
// Coverage for src/util/walkDir.ts — the recursive file-tree walker shared by
// em skill sync/check. The one behavior worth pinning down beyond "finds nested files": it
// must include non-`.md` files (e.g. templates/live.html-shaped entries), unlike
// test/skillExamples.test.ts's skillFiles(), which deliberately only walks `.md` files.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkDir } from "../src/util/walkDir.js";

describe("walkDir", () => {
  it("lists nested files as sorted, relative, POSIX-style paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-walkdir-"));
    try {
      writeFileSync(join(dir, "SKILL.md"), "a");
      mkdirSync(join(dir, "reference"));
      writeFileSync(join(dir, "reference", "em-dsl.md"), "b");
      mkdirSync(join(dir, "templates"));
      writeFileSync(join(dir, "templates", "live.html"), "c");
      writeFileSync(join(dir, "templates", "slice.md"), "d");

      expect(walkDir(dir)).toEqual(["SKILL.md", "reference/em-dsl.md", "templates/live.html", "templates/slice.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty list for an empty directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-walkdir-"));
    try {
      expect(walkDir(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
