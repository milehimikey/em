// SPDX-License-Identifier: MIT
import { describe, it, expect, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noteHref } from "../src/render/render.js";

describe("noteHref", () => {
  it("is unchanged when the SVG sits beside the .em (note relative to both)", () => {
    expect(noteHref("notes/order-placed.md", "/proj/src", "/proj/src")).toBe(
      "notes/order-placed.md",
    );
  });

  it("rewrites relative to the output directory when they differ", () => {
    // .em + notes/ in /proj/src, SVG written to /proj/docs
    expect(noteHref("notes/order-placed.md", "/proj/src", "/proj/docs")).toBe(
      "../src/notes/order-placed.md",
    );
  });

  it("uses posix separators in the href", () => {
    const href = noteHref("a/b/note.md", "/proj/src", "/proj/out");
    expect(href).not.toContain("\\");
    expect(href).toBe("../src/a/b/note.md");
  });

  it("passes through URLs and absolute paths untouched", () => {
    expect(noteHref("https://wiki/x", "/a", "/b")).toBe("https://wiki/x");
    expect(noteHref("/abs/note.md", "/a", "/b")).toBe("/abs/note.md");
  });
});

// MIL-141 atomic writes, failure side (the success side — no *.tmp sibling after a
// clean render — lives in render.e2e.test.ts). RSVG_BIN is captured from EM_RSVG at
// module load, so each test stubs the env and re-imports a fresh render module.
describe("writeRendered failure paths", () => {
  let dir: string;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("an unsupported format without rsvg rejects and leaves the out dir empty", async () => {
    vi.stubEnv("EM_RSVG", "em-test-no-such-binary");
    vi.resetModules();
    const { writeRendered } = await import("../src/render/render.js");
    dir = mkdtempSync(join(tmpdir(), "em-atomic-fail-"));

    await expect(writeRendered("<svg/>", join(dir, "out.eps"), "eps")).rejects.toThrow(
      /not built in/,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a converter that dies after writing output leaves neither the tmp nor the target", async () => {
    dir = mkdtempSync(join(tmpdir(), "em-atomic-crash-"));
    // Fake rsvg-convert: passes the hasBin probe, writes junk to -o's path (argv:
    // --format=<fmt> -o <path>), then exits nonzero — the mid-conversion crash the
    // tmp+rename design exists for. stdin is drained so the writer never sees EPIPE.
    const fake = join(dir, "fake-rsvg");
    writeFileSync(
      fake,
      '#!/bin/sh\n[ "$1" = "--version" ] && exit 0\ncat > /dev/null\necho junk > "$3"\nexit 1\n',
    );
    chmodSync(fake, 0o755);
    vi.stubEnv("EM_RSVG", fake);
    vi.resetModules();
    const { writeRendered } = await import("../src/render/render.js");

    const out = join(dir, "out.eps");
    await expect(writeRendered("<svg/>", out, "eps")).rejects.toThrow(/exited with code 1/);
    // junk went to out.eps.tmp and was unlinked; out.eps itself was never created
    expect(readdirSync(dir)).toEqual(["fake-rsvg"]);
  });
});