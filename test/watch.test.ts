// SPDX-License-Identifier: MIT
// Coverage for src/render/watch.ts's multi-path support — added so `em watch`
// can watch a slice doc glob alongside the .em file (see cli.ts's watch command).
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchFile } from "../src/render/watch.js";

describe("watchFile", () => {
  let dir: string;
  let watcher: ReturnType<typeof watchFile> | undefined;

  afterEach(async () => {
    await watcher?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("accepts an array of paths/globs and rebuilds on a change to any of them", async () => {
    dir = mkdtempSync(join(tmpdir(), "em-watch-"));
    const modelFile = join(dir, "model.em");
    writeFileSync(modelFile, "slice \"X\" {\n  command X\n}\n");
    mkdirSync(join(dir, "slices"), { recursive: true });
    const docFile = join(dir, "slices", "x.md");
    writeFileSync(docFile, "- **Status:** draft\n");

    let calls = 0;
    let resolveCall: (() => void) | undefined;
    const onChange = () => {
      calls++;
      resolveCall?.();
    };

    watcher = watchFile([modelFile, join(dir, "slices", "*.md")], onChange, 20);
    await new Promise((r) => watcher!.on("ready", r));

    const waitForCall = () => new Promise<void>((resolve) => (resolveCall = resolve));

    // change the slice doc, NOT the .em file
    const first = waitForCall();
    appendFileSync(docFile, "edited\n");
    await first;
    expect(calls).toBe(1);

    // change the .em file too
    const second = waitForCall();
    appendFileSync(modelFile, "\n");
    await second;
    expect(calls).toBe(2);
  });

  it("still works with a single string path (back-compat)", async () => {
    dir = mkdtempSync(join(tmpdir(), "em-watch-single-"));
    const modelFile = join(dir, "model.em");
    writeFileSync(modelFile, "slice \"X\" {\n  command X\n}\n");

    let resolveCall: (() => void) | undefined;
    watcher = watchFile(modelFile, () => resolveCall?.(), 20);
    await new Promise((r) => watcher!.on("ready", r));

    const called = new Promise<void>((resolve) => (resolveCall = resolve));
    appendFileSync(modelFile, "\n");
    await called;
  });
});
