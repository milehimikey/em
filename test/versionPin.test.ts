// SPDX-License-Identifier: MIT
// Corepack-style per-project version pinning (src/cli/versionPin.ts, milehimikey/em#223). Covers the
// pure resolution logic (findVersionPin, resolveDispatch) over real tmp directories. The actual
// spawn (dispatchToPinnedVersion) is exercised separately below with a stubbed `npx` on PATH, since
// a real dispatch needs network access on a cache miss.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findVersionPin,
  resolveDispatch,
  dispatchToPinnedVersion,
  dispatchExempt,
  rewriteVersionPin,
  checkVersionPin,
  VERSION_PIN_FILENAME,
  SKIP_ENV_VAR,
} from "../src/cli/versionPin.js";
import type { PluginDeclaration } from "../src/cli/pluginPin.js";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

function pinFile(dir: string, contents: string): void {
  writeFileSync(join(dir, VERSION_PIN_FILENAME), contents);
}

describe("findVersionPin", () => {
  it("is null with no .em-version anywhere up the tree", () => {
    const d = tmp("em-versionpin-none-");
    expect(findVersionPin(d)).toBeNull();
  });

  it("finds a pin in the starting directory itself", () => {
    const d = tmp("em-versionpin-here-");
    pinFile(d, "1.14.0\n");
    expect(findVersionPin(d)).toEqual({ version: "1.14.0", source: join(d, VERSION_PIN_FILENAME) });
  });

  it("walks up to find a pin in an ancestor directory", () => {
    const root = tmp("em-versionpin-ancestor-");
    pinFile(root, "1.13.0");
    const nested = join(root, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    expect(findVersionPin(nested)).toEqual({ version: "1.13.0", source: join(root, VERSION_PIN_FILENAME) });
  });

  it("prefers the closest pin over a further ancestor's", () => {
    const root = tmp("em-versionpin-closest-");
    pinFile(root, "1.10.0");
    const nested = join(root, "nested");
    mkdirSync(nested, { recursive: true });
    pinFile(nested, "1.14.0");
    expect(findVersionPin(nested)?.version).toBe("1.14.0");
  });

  it("trims whitespace from the pinned version", () => {
    const d = tmp("em-versionpin-whitespace-");
    pinFile(d, "  1.14.0  \n\n");
    expect(findVersionPin(d)?.version).toBe("1.14.0");
  });

  it("treats an empty or whitespace-only pin file as absent, not an error", () => {
    const d = tmp("em-versionpin-empty-");
    pinFile(d, "   \n  ");
    expect(findVersionPin(d)).toBeNull();
  });
});

describe("resolveDispatch", () => {
  it("is null when no pin exists", () => {
    const d = tmp("em-resolvedispatch-none-");
    expect(resolveDispatch(d, "1.14.0")).toBeNull();
  });

  it("is null when the pin matches the installed version (no recursion)", () => {
    const d = tmp("em-resolvedispatch-match-");
    pinFile(d, "1.14.0");
    expect(resolveDispatch(d, "1.14.0")).toBeNull();
  });

  it("returns the pin when it differs from the installed version", () => {
    const d = tmp("em-resolvedispatch-diff-");
    pinFile(d, "1.13.0");
    expect(resolveDispatch(d, "1.14.0")).toEqual({ version: "1.13.0", source: join(d, VERSION_PIN_FILENAME) });
  });

  it("is null when the skip env var is set, even with a differing pin", () => {
    const d = tmp("em-resolvedispatch-skip-");
    pinFile(d, "1.13.0");
    expect(resolveDispatch(d, "1.14.0", { [SKIP_ENV_VAR]: "1" })).toBeNull();
  });
});

describe("dispatchToPinnedVersion", () => {
  it("spawns npx with the pinned version and forwards args, stdio, and exit code", async () => {
    const binDir = tmp("em-dispatch-bin-");
    const marker = join(binDir, "called.json");
    // A stub `npx` that records its argv and exits with a known code, standing in for the real
    // network-dependent binary so this test runs offline and fast.
    const stub = join(binDir, "npx");
    writeFileSync(
      stub,
      `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));\nprocess.exit(7);\n`,
    );
    chmodSync(stub, 0o755);

    const code = await dispatchToPinnedVersion("1.13.0", ["validate", "model.em", "--json"], {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
    });

    expect(code).toBe(7);
    const recorded = JSON.parse(readFileSync(marker, "utf8"));
    expect(recorded).toEqual(["-y", "@milehimikey/em@1.13.0", "validate", "model.em", "--json"]);
  });

  it("rejects when the spawn itself cannot start (e.g. npx missing)", async () => {
    await expect(
      dispatchToPinnedVersion("1.13.0", ["validate"], { ...process.env, PATH: "/nonexistent-path-for-test" }),
    ).rejects.toThrow();
  });
});

describe("dispatchExempt: em upgrade always runs as the installed em", () => {
  it("exempts `upgrade`, with or without options before it", () => {
    expect(dispatchExempt(["upgrade", "model.em", "--apply"])).toBe(true);
    expect(dispatchExempt(["--no-color", "upgrade", "model.em"])).toBe(true);
  });

  it("does not exempt any other command, or an argument that merely says upgrade", () => {
    expect(dispatchExempt(["validate", "model.em"])).toBe(false);
    expect(dispatchExempt(["skill", "check"])).toBe(false);
    expect(dispatchExempt(["status", "upgrade"])).toBe(false);
    expect(dispatchExempt([])).toBe(false);
  });

  it("resolveDispatch is null for `em upgrade` even when the pin differs", () => {
    const d = tmp("em-versionpin-exempt-");
    pinFile(d, "1.14.0\n");
    expect(resolveDispatch(d, "1.24.0", {}, ["upgrade", "model.em"])).toBeNull();
    expect(resolveDispatch(d, "1.24.0", {}, ["validate", "model.em"])?.version).toBe("1.14.0");
  });
});

describe("findVersionPin with stopAt", () => {
  it("does not look above stopAt", () => {
    const root = tmp("em-versionpin-stop-");
    const repo = join(root, "repo");
    mkdirSync(join(repo, "models"), { recursive: true });
    pinFile(root, "1.14.0\n");
    expect(findVersionPin(join(repo, "models"), repo)).toBeNull();
    expect(findVersionPin(join(repo, "models"))?.version).toBe("1.14.0");
    pinFile(repo, "1.20.0\n");
    expect(findVersionPin(join(repo, "models"), repo)?.version).toBe("1.20.0");
  });
});

describe("rewriteVersionPin", () => {
  it("replaces the version and keeps the surrounding whitespace, LF or CRLF", () => {
    expect(rewriteVersionPin("1.14.0\n", "1.24.0")).toBe("1.24.0\n");
    expect(rewriteVersionPin("1.14.0\r\n", "1.24.0")).toBe("1.24.0\r\n");
    expect(rewriteVersionPin("  1.14.0", "1.24.0")).toBe("  1.24.0");
  });

  it("is null for a file that holds no version", () => {
    expect(rewriteVersionPin("  \n", "1.24.0")).toBeNull();
  });
});

describe("checkVersionPin (em skill check)", () => {
  const plugin: PluginDeclaration = { name: "em-1-23-0", ref: "v1.23.0", enabled: true } as PluginDeclaration;

  it("is null when no .em-version is found", () => {
    expect(checkVersionPin(tmp("em-versionpin-check-none-"), "1.23.0", null)).toBeNull();
  });

  it("compares against the installed em when the repo declares no plugin", () => {
    const d = tmp("em-versionpin-check-installed-");
    pinFile(d, "1.14.0\n");
    expect(checkVersionPin(d, "1.14.0", null)?.finding).toBeNull();
    const f = checkVersionPin(d, "1.23.0", null)!.finding!;
    expect(f.code).toBe("em-version-pin-mismatch");
    expect(f.emVersionPin).toBe("1.14.0");
    expect(f.emVersionFile).toBe(VERSION_PIN_FILENAME);
    expect(f.message).toContain("installed em 1.23.0");
  });

  it("compares against the plugin pin when the repo declares the plugin", () => {
    const d = tmp("em-versionpin-check-plugin-");
    pinFile(d, "1.23.0\n");
    expect(checkVersionPin(d, "1.24.0", plugin)?.finding).toBeNull();
    pinFile(d, "1.22.0\n");
    expect(checkVersionPin(d, "1.24.0", plugin)?.finding?.message).toContain("the em plugin pin (em-1-23-0 at v1.23.0) is 1.23.0");
  });
});
