// SPDX-License-Identifier: MIT
// Coverage for src/render/watch.ts's multi-path support — added so `em watch`
// can watch the slices/ directory alongside the .em file (see cli.ts's watch command) —
// and for serializeBuilds, the coalescing wrapper the watch command runs builds through.
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeBuilds, watchFile } from "../src/render/watch.js";

describe("watchFile", () => {
  let dir: string;
  let watcher: ReturnType<typeof watchFile> | undefined;
  // chokidar 4 reports `ready` a beat before a watched file is actually armed on macOS;
  // a write in that window is dropped. Not a product concern (a human edits seconds later),
  // but the tests write immediately, so give the watcher a moment first.
  const settle = () => new Promise<void>((r) => setTimeout(r, 150));

  afterEach(async () => {
    await watcher?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("accepts an array of files/directories and rebuilds on a change to any of them", async () => {
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

    watcher = watchFile([modelFile, join(dir, "slices")], onChange, 20);
    await new Promise<void>((r) => watcher!.on("ready", () => r()));
    await settle();
    calls = 0; // same startup-event guard as above

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

  it("an `only` filter narrows a watched directory to the files that count, and a doc authored after start still fires", async () => {
    dir = mkdtempSync(join(tmpdir(), "em-watch-only-"));
    const modelFile = join(dir, "model.em");
    writeFileSync(modelFile, "slice \"X\" {\n  command X\n}\n");
    const slicesDir = join(dir, "slices");
    mkdirSync(slicesDir, { recursive: true });

    let calls = 0;
    let resolveCall: (() => void) | undefined;
    const onChange = () => {
      calls++;
      resolveCall?.();
    };
    watcher = watchFile([modelFile, slicesDir], onChange, 20, (p) => p === modelFile || p.endsWith(".md"));
    await new Promise<void>((r) => watcher!.on("ready", () => r()));
    await settle();
    calls = 0; // drop the one spurious startup `change` chokidar 4 can report for a just-written fixture
    const waitForCall = () => new Promise<void>((resolve) => (resolveCall = resolve));

    // a non-.md file in slices/ is ignored; the .md created afterwards is not
    writeFileSync(join(slicesDir, "notes.txt"), "ignored\n");
    const first = waitForCall();
    writeFileSync(join(slicesDir, "new.md"), "- **Status:** draft\n");
    await first;
    expect(calls).toBe(1);
  });

  it("still works with a single string path (back-compat)", async () => {
    dir = mkdtempSync(join(tmpdir(), "em-watch-single-"));
    const modelFile = join(dir, "model.em");
    writeFileSync(modelFile, "slice \"X\" {\n  command X\n}\n");

    let resolveCall: (() => void) | undefined;
    watcher = watchFile(modelFile, () => resolveCall?.(), 20);
    await new Promise<void>((r) => watcher!.on("ready", () => r()));
    await settle();

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
