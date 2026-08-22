// SPDX-License-Identifier: MIT
// Coverage for src/render/watch.ts's multi-path support — added so `em watch`
// can watch a slice doc glob alongside the .em file (see cli.ts's watch command) —
// and for serializeBuilds, the coalescing wrapper the watch command runs builds through.
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeBuilds, watchFile } from "../src/render/watch.js";

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

describe("serializeBuilds", () => {
  // Builds that only finish when the test says so, exposing in-flight overlap.
  const controllable = () => {
    const releases: (() => void)[] = [];
    let runs = 0;
    const fn = () =>
      new Promise<void>((resolve) => {
        runs++;
        releases.push(resolve);
      });
    return { fn, releases, runs: () => runs };
  };

  // Ticks past the awaited-fn continuation so a scheduled trailing run has started.
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("never runs two builds concurrently; triggers during a build coalesce into one trailing run", async () => {
    const { fn, releases, runs } = controllable();
    const build = serializeBuilds(fn);

    const first = build();
    // three more triggers land while the first build is still in flight
    void build();
    void build();
    void build();
    expect(runs()).toBe(1); // none of them started a second build

    releases[0]();
    await tick();
    expect(runs()).toBe(2); // the three triggers collapsed into one trailing run
    releases[1]();
    await first; // the original call's promise spans the trailing run too
    expect(runs()).toBe(2); // nothing left pending
  });

  it("a trigger after everything settled starts a fresh build", async () => {
    const { fn, releases, runs } = controllable();
    const build = serializeBuilds(fn);

    const first = build();
    releases[0]();
    await first;
    expect(runs()).toBe(1);

    const second = build();
    expect(runs()).toBe(2);
    releases[1]();
    await second;
  });

  it("a trigger during the trailing run schedules exactly one more", async () => {
    const { fn, releases, runs } = controllable();
    const build = serializeBuilds(fn);

    const first = build();
    void build(); // dirty → trailing run
    releases[0]();
    await tick(); // let the trailing run start
    expect(runs()).toBe(2);

    void build(); // dirty again, mid-trailing-run
    releases[1]();
    await tick();
    expect(runs()).toBe(3);
    releases[2]();
    await first;
    expect(runs()).toBe(3);
  });
});
