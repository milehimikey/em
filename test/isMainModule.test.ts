// SPDX-License-Identifier: MIT
// Regression coverage for the symlink bug a code review caught on MIL-92 PR #85: the original
// `resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? "")` guard in
// src/cli.ts broke `em` completely for every `npm i -g` install, because the global bin entry
// is a symlink — Node's ESM loader resolves it when loading the module (so import.meta.url is
// always the real file), but process.argv[1] keeps the literal symlink path, so the two never
// matched and the guarded parseAsync() call silently never ran. Confirmed manually: built
// dist/cli.js, symlinked it the way npm's global install does, ran `em --version` through the
// symlink — zero output, exit 0, nothing happened.
//
// Two layers here: a fast, deterministic unit test of isMainModule() itself (the primary
// regression guard — exercises real fs symlink resolution, no build required), plus an
// end-to-end test that builds and spawns the real dist/cli.js through an actual symlink, since
// test/cli.test.ts's spawnSync(tsx, src/cli.ts, ...) structurally can never hit this path (it
// always invokes src/cli.ts's own real, non-symlinked location).
import { describe, it, expect, beforeAll } from "vitest";
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainModule } from "../src/util/isMainModule.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("isMainModule", () => {
  it("returns true when process.argv[1] is a symlink to the real module file", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-is-main-"));
    try {
      const real = join(dir, "real.js");
      const link = join(dir, "em"); // no .js extension — matches npm's global bin entry shape
      writeFileSync(real, "// fixture\n");
      symlinkSync(real, link);

      // Node fully realpath-resolves the entry module's import.meta.url — including any
      // symlinked *ancestor* directory, not just the final path component (confirmed
      // empirically: os.tmpdir() itself sits behind a symlink on macOS, /var -> /private/var).
      // Simulating import.meta.url from the literal `real` path without this step would test
      // a URL shape Node never actually produces.
      const realpathUrl = pathToFileURL(realpathSync(real)).href;

      const originalArgv1 = process.argv[1];
      process.argv[1] = link;
      try {
        expect(isMainModule(realpathUrl)).toBe(true);
      } finally {
        process.argv[1] = originalArgv1;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false when argv[1] resolves to a different file (imported, not invoked)", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-is-main-"));
    try {
      const real = join(dir, "real.js");
      const other = join(dir, "other.js");
      writeFileSync(real, "// fixture\n");
      writeFileSync(other, "// fixture\n");

      const originalArgv1 = process.argv[1];
      process.argv[1] = other;
      try {
        expect(isMainModule(pathToFileURL(real).href)).toBe(false);
      } finally {
        process.argv[1] = originalArgv1;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns false rather than throwing when argv[1] doesn't exist on disk", () => {
    const originalArgv1 = process.argv[1];
    process.argv[1] = join(tmpdir(), "em-is-main-nonexistent", "nope.js");
    try {
      expect(() => isMainModule(import.meta.url)).not.toThrow();
      expect(isMainModule(import.meta.url)).toBe(false);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });

  it("returns false when argv[1] is unset", () => {
    const originalArgv1 = process.argv[1];
    // @ts-expect-error -- simulating an argv shape with no script path
    process.argv[1] = undefined;
    try {
      expect(isMainModule(import.meta.url)).toBe(false);
    } finally {
      process.argv[1] = originalArgv1;
    }
  });
});

describe("em CLI through a real symlink (end-to-end, npm i -g shape)", () => {
  const distCli = join(ROOT, "dist", "cli.js");

  beforeAll(() => {
    if (!existsSync(distCli)) {
      execSync("npm run build", { cwd: ROOT, stdio: "inherit" });
    }
  }, 60_000);

  it("runs normally when invoked directly through a symlink, not just the real path", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-symlink-bin-"));
    try {
      const link = join(dir, "em");
      symlinkSync(distCli, link);
      const res = spawnSync(process.execPath, [link, "--version"], { encoding: "utf8" });
      expect(res.status).toBe(0);
      expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
