// SPDX-License-Identifier: MIT
// GH #309 (deferred from #277): `em watch --serve --storyline <name>` — the live server's
// subset endpoint. Exercises the real pipeline `em watch`'s build step composes (buildStorylineDiagram
// + layoutDot/composeSvg, the same `em render --storyline` subset — plus embedStorylinePicker and
// the storyline-variants list), served by the real startLiveServer, so this is the "Viewer test for
// the subset endpoint" the issue's acceptance asks for without spawning a long-running watcher.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { compile } from "../src/pipeline.js";
import { composeSvg, layoutDot, writeRendered } from "../src/render/render.js";
import { buildStorylineDiagram } from "../src/render/storylineDiagram.js";
import { embedStorylinePicker } from "../src/render/storylinePicker.js";
import { resolveWatchStoryline, storylineFileFor, storylineVariants } from "../src/cli/watchStoryline.js";
import { startLiveServer, LiveServer } from "../src/render/serve.js";

const SRC = readFileSync(join("examples", "storylines.em"), "utf8");

/** Renders one output exactly the way `em watch --serve`'s build step does: the full model to
 *  `outFile`, or (when `name` is given) a storyline's own subset — both carrying the same
 *  em-storylines picker metadata. */
async function renderVariant(dir: string, outFile: string, name: string | undefined) {
  const { dot, model, grid } = compile(SRC);
  const resolved = resolveWatchStoryline(model, name);
  if ("error" in resolved) throw new Error(resolved.error);
  const currentFile = "storyline" in resolved ? storylineFileFor(resolved.storyline.name) : outFile;
  const variants = storylineVariants(model, outFile, currentFile);

  const fullRaw = await layoutDot(dot);
  const fullSvg = embedStorylinePicker(composeSvg(fullRaw, model, grid, "examples", dir), variants);
  await writeRendered(fullSvg, join(dir, outFile), "svg");

  for (const st of model.storylines ?? []) {
    const sub = buildStorylineDiagram(model, st);
    const subFile = storylineFileFor(st.name);
    const subRaw = await layoutDot(sub.dot);
    const subSvg = embedStorylinePicker(
      composeSvg(subRaw, sub.model, sub.grid, "examples", dir),
      storylineVariants(model, outFile, subFile),
    );
    await writeRendered(subSvg, join(dir, subFile), "svg");
  }
  return currentFile;
}

function metadataOf(svg: string, id: string): unknown {
  const m = new RegExp(`<metadata id="${id}">([\\s\\S]*?)</metadata>`).exec(svg);
  if (!m) return null;
  const entities: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"' };
  return JSON.parse(m[1].replace(/&(?:lt|gt|amp|quot);/g, (e) => entities[e]));
}

describe("em watch --serve --storyline: the subset endpoint", () => {
  let dir: string;
  let server: LiveServer;

  afterEach(async () => {
    await server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("serves the full model and every declared storyline's own subset side by side, each carrying the picker metadata", async () => {
    dir = mkdtempSync(join(tmpdir(), "em-watch-storyline-"));
    await renderVariant(dir, "model.svg", undefined);
    server = await startLiveServer({ dir, port: 0 });
    const base = `http://127.0.0.1:${server.port}`;

    const full = await (await fetch(`${base}/model.svg`)).text();
    const fullPicker = metadataOf(full, "em-storylines") as { name: string; file: string; current: boolean }[];
    expect(fullPicker.map((v) => v.name)).toEqual([
      "Full model",
      "Bring a product to market",
      "Extend an attribute",
      "Retire a product",
    ]);
    expect(fullPicker.find((v) => v.name === "Full model")!.current).toBe(true);
    expect(fullPicker.every((v) => v.name === "Full model" || !v.current)).toBe(true);

    // Every storyline's subset file the picker links to is actually reachable.
    for (const v of fullPicker.slice(1)) {
      const res = await fetch(`${base}/${v.file}`);
      expect(res.status).toBe(200);
    }
  });

  it("a storyline's subset holds the storyline's own slices only — nothing from outside it is drawn (2026-11-03 ruling)", async () => {
    dir = mkdtempSync(join(tmpdir(), "em-watch-storyline-"));
    const currentFile = await renderVariant(dir, "model.svg", "Retire a product");
    expect(currentFile).toBe("storyline-retire-a-product.svg");
    server = await startLiveServer({ dir, port: 0 });
    const base = `http://127.0.0.1:${server.port}`;

    const sub = await (await fetch(`${base}/${currentFile}`)).text();
    const subSlices = metadataOf(sub, "em-slices") as { slices: { name: string }[] };
    // "Retire a product"'s own two slices only — the main storyline's end state ("List Published
    // Products") is not drawn at all: a storyline render shows nothing from outside the storyline.
    expect(subSlices.slices.map((s) => s.name)).toEqual(["Archive Product", "List Active Products"]);
    expect(sub).not.toContain("List Published");
    expect(sub).not.toMatch(/opacity="0\.4"/);

    const subPicker = metadataOf(sub, "em-storylines") as { name: string; file: string; current: boolean }[];
    expect(subPicker.find((v) => v.name === "Retire a product")!.current).toBe(true);
    expect(subPicker.find((v) => v.name === "Full model")!.current).toBe(false);
  });

  it("an unknown --storyline errors, listing the declared storylines, instead of throwing", async () => {
    const { model } = compile(SRC);
    const resolved = resolveWatchStoryline(model, "Nope");
    expect("error" in resolved && resolved.error).toContain('"Bring a product to market", "Extend an attribute", "Retire a product"');
  });
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TSX = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = join(ROOT, "src", "cli.ts");

describe("CLI: em watch --storyline", () => {
  it("--storyline without --serve refuses immediately rather than silently doing nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "em-watch-storyline-cli-"));
    try {
      writeFileSync(join(dir, "m.em"), SRC);
      const res = spawnSync(process.execPath, [TSX, CLI, "watch", "m.em", "--storyline", "Main"], {
        cwd: dir,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      expect(res.status).toBe(1);
      expect(res.stderr).toContain("--storyline applies only with --serve");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
