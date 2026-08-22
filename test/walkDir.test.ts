// SPDX-License-Identifier: MIT
// Coverage for src/util/walkDir.ts — the recursive file-tree walker shared by
// em skill sync/check. The one behavior worth pinning down beyond "finds nested files": it
// must include non-`.md` files (e.g. templates/*.html-shaped entries), unlike
// test/skillExamples.test.ts's skillFiles(), which deliberately only walks `.md` files.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
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
      writeFileSync(join(dir, "templates", "viewer-notes.html"), "c");
      writeFileSync(join(dir, "templates", "slice.md"), "d");

      expect(walkDir(dir)).toEqual([
        "SKILL.md",
        "reference/em-dsl.md",
        "templates/slice.md",
        "templates/viewer-notes.html",
      ]);
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

  it("prunes a directory before descending when skipDir matches, rather than filtering after", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-walkdir-"));
    try {
      writeFileSync(join(dir, "kept.txt"), "a");
      mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
      writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "b");

      const result = walkDir(dir, { skipDir: (name) => name === "node_modules" });
      expect(result).toEqual(["kept.txt"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never calls readdirSync on a pruned directory — an unreadable node_modules doesn't throw", () => {
    // Proves pruning happens BEFORE descent (not walked-then-filtered): if walkDir ever tried
    // to readdirSync a chmod-000 directory, this would throw EACCES. Skipped when running as
    // root (e.g. some CI containers), which bypasses directory permission checks entirely.
    if (process.getuid && process.getuid() === 0) return;
    const dir = mkdtempSync(join(tmpdir(), "em-walkdir-"));
    try {
      writeFileSync(join(dir, "kept.txt"), "a");
      const nodeModules = join(dir, "node_modules");
      mkdirSync(nodeModules);
      chmodSync(nodeModules, 0o000);

      expect(() => walkDir(dir, { skipDir: (name) => name === "node_modules" })).not.toThrow();
      expect(walkDir(dir, { skipDir: (name) => name === "node_modules" })).toEqual(["kept.txt"]);
    } finally {
      chmodSync(join(dir, "node_modules"), 0o755);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
