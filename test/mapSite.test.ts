// SPDX-License-Identifier: MIT
// `em render --map` as a static site: the storyline canvas as the root, one viewer page per
// storyline that a canvas frame opens, the slice docs inside each page — and no server.
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { storylineMap } from "../src/model/storylineMap.js";
import { buildStorylineDiagram } from "../src/render/storylineDiagram.js";
import { layoutDot, composeSvg } from "../src/render/render.js";
import { buildStaticViewerHtml } from "../src/render/staticViewer.js";
import { VIEWER_HTML } from "../src/render/viewerHtml.js";
import { FULL_MODEL_PAGE, MapSiteStoryline, buildMapSite } from "../src/cli/mapSite.js";
import { kebabSlug } from "../src/util/slug.js";

const SRC = `
model "Shed"
persona Neighbor
context Loans
storyline "Borrow a tool" {
  slice "Check Out Tool" {
    ui Checkout @Neighbor
    command Check Out Tool { loanId: LoanId } note "slices/check-out-tool.md"
    event Tool Checked Out @Loans { loanId: LoanId }
  }
}
storyline "Chase" after "Borrow a tool" {
  slice "Overdue Loans" {
    view Overdue Loans from "Tool Checked Out" { loanId: LoanId }
    ui Overdue @Neighbor
  }
}
`;

/** The config a static page carries, read back the way the browser would. */
function configOf(html: string): { svg: string; title: string; mapHref: string; variants: { name: string; file: string; current: boolean }[]; stamp: string } {
  const m = /<script>window\.EM_STATIC = (.*);<\/script>\n<\/head>/.exec(html);
  if (!m) throw new Error("no EM_STATIC config in the page");
  return JSON.parse(m[1]);
}

async function site(opts: { mapFile?: string; fullModel?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "em-mapsite-"));
  mkdirSync(join(dir, "slices"));
  writeFileSync(join(dir, "slices", "check-out-tool.md"), "# Check Out Tool\n\nA neighbor borrows a tool: THE-DOC-BODY.\n");
  const { model, dot, grid } = compile(SRC);
  const storylines: MapSiteStoryline[] = [];
  for (const st of model.storylines!) {
    const sub = buildStorylineDiagram(model, st);
    const svg = composeSvg(await layoutDot(sub.dot), sub.model, sub.grid, dir, dir);
    storylines.push({ name: st.name, slug: kebabSlug(st.name), sliceCount: st.sliceIndexes.length, svg });
  }
  const fullModelSvg = opts.fullModel ? composeSvg(await layoutDot(dot), model, grid, dir, dir) : undefined;
  return buildMapSite({ model, map: storylineMap(model), storylines, mapFile: opts.mapFile ?? "map.html", fullModelSvg });
}

describe("buildStaticViewerHtml()", () => {
  it("is the live viewer page with its diagram and config baked in ahead of the viewer's own script", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><text>a</script><!-- $& b</text></svg>';
    const html = buildStaticViewerHtml({ svg, title: "Shed — A & <B>", mapHref: "./map.html" });
    expect(html).toContain("<title>Shed — A &amp; &lt;B&gt;</title>");
    // Nothing in the diagram can end the config script early or open a comment in it.
    const script = /<script>window\.EM_STATIC = (.*);<\/script>/.exec(html)![1];
    expect(script).not.toContain("<");
    const config = configOf(html);
    expect(config.svg).toBe(svg); // round-trips exactly, `$&` and all
    expect(config).toMatchObject({ title: "Shed — A & <B>", mapHref: "./map.html", variants: [], stamp: "" });
    // Otherwise byte-for-byte the one viewer: same script, same styles.
    expect(html.length).toBeGreaterThan(VIEWER_HTML.length);
    expect(html.indexOf("window.EM_STATIC =")).toBeLessThan(html.indexOf("const STATIC = window.EM_STATIC"));
  });

  it("the viewer's static mode fetches nothing and opens no event stream", () => {
    // The page's one fetch and its one EventSource both sit behind the STATIC switch.
    expect(VIEWER_HTML).toContain("if (STATIC) { loadText(id, STATIC.svg); return; }");
    expect(VIEWER_HTML).toContain("if (!STATIC) startLive();");
    expect((VIEWER_HTML.match(/new EventSource\(/g) ?? []).length).toBe(1);
    expect(VIEWER_HTML.indexOf("function startLive()")).toBeLessThan(VIEWER_HTML.indexOf("new EventSource("));
  });

  it("the static picker navigates only to a bare sibling .html filename", () => {
    // Same allowlist ?svg= gets: no path separator, no scheme colon — so never off the folder,
    // never a javascript: URL. Every page name the site writes passes it.
    const allow = /^[^/\\:]+\.html$/;
    expect(VIEWER_HTML).toContain(`if (${allow}.test(page)) location.assign("./" + encodeURIComponent(page));`);
    for (const ok of ["chase.html", "borrow-a-tool.html", FULL_MODEL_PAGE]) expect(allow.test(ok)).toBe(true);
    for (const bad of ["javascript:alert(1)", "//evil.example/x.html", "../x.html", "https://evil.example/x.html", "a.svg"]) expect(allow.test(bad)).toBe(false);
  });
});

describe("buildMapSite()", () => {
  it("writes the canvas plus one page per storyline; frames open the pages in the same tab", async () => {
    const result = await site();
    if ("error" in result) throw new Error(result.error);
    expect([...result.files.keys()].sort()).toEqual(["borrow-a-tool.html", "chase.html", "map.html"]);
    const map = result.files.get("map.html")!;
    expect(map).toContain('href="./borrow-a-tool.html"');
    expect(map).toContain('href="./chase.html"');
    expect(map).not.toContain('target="_blank"');
    expect((map.match(/class="frame drill"/g) ?? []).length).toBe(2);
    expect(map).toContain("click a storyline to open it");
    expect(map).not.toContain("EventSource"); // still no server to talk to
  });

  it("a storyline page holds that storyline's diagram and slice docs, links back to the canvas and lists its siblings — never the full model", async () => {
    const result = await site();
    if ("error" in result) throw new Error(result.error);
    const config = configOf(result.files.get("borrow-a-tool.html")!);
    expect(config.title).toBe("Shed — Borrow a tool");
    expect(config.mapHref).toBe("./map.html");
    expect(config.variants).toEqual([
      { name: "Borrow a tool", file: "borrow-a-tool.html", current: true },
      { name: "Chase", file: "chase.html", current: false },
    ]);
    // The slice doc rides in the diagram's own metadata, as in the live viewer.
    expect(config.svg).toContain("THE-DOC-BODY");
    expect(config.svg).toContain("Check Out Tool");
    expect(config.svg).not.toContain("Overdue Loans"); // the other storyline's slice
    // Deterministic: models commit this folder, so a re-render of an unchanged model is no diff.
    expect(config.stamp).toBe("");
  });

  it("--full-model adds the full model as one more page and picker entry, still not the root", async () => {
    const result = await site({ fullModel: true });
    if ("error" in result) throw new Error(result.error);
    expect(result.files.has(FULL_MODEL_PAGE)).toBe(true);
    const full = configOf(result.files.get(FULL_MODEL_PAGE)!);
    expect(full.title).toBe("Shed — full model");
    expect(full.svg).toContain("Overdue Loans");
    expect(full.variants[0]).toEqual({ name: "Full model", file: FULL_MODEL_PAGE, current: true });
    expect(configOf(result.files.get("chase.html")!).variants.map((v) => v.name)).toEqual(["Full model", "Borrow a tool", "Chase"]);
    expect(result.files.get("map.html")).not.toContain(FULL_MODEL_PAGE);
  });

  it("-o names the canvas page, and the storyline pages follow it back", async () => {
    const result = await site({ mapFile: "index.html" });
    if ("error" in result) throw new Error(result.error);
    expect(result.files.has("index.html")).toBe(true);
    expect(configOf(result.files.get("chase.html")!).mapHref).toBe("./index.html");
  });

  it("refuses a canvas filename a storyline's own page would overwrite", async () => {
    const result = await site({ mapFile: "chase.html" });
    expect(result).toEqual({ error: expect.stringContaining('storyline "Chase" has its page at chase.html') });
  });
});
