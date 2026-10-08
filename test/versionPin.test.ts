// SPDX-License-Identifier: MIT
// Corepack-style per-project version pinning (src/cli/versionPin.ts, milehimikey/em#223). Covers the
// pure resolution logic (findVersionPin, resolveDispatch) over real tmp directories. The actual
// spawn (dispatchToPinnedVersion) is exercised separately below with a stubbed `npx` on PATH, since
// a real dispatch needs network access on a cache miss.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findVersionPin, resolveDispatch, dispatchToPinnedVersion, VERSION_PIN_FILENAME, SKIP_ENV_VAR } from "../src/cli/versionPin.js";

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
