// SPDX-License-Identifier: MIT
// Orchestrates `em catalog`'s static-site build — the only I/O in
// src/catalog/*. One output directory per input model (so slice keys from
// different files can never collide, even without a cross-file dedup pass):
//
//   <outDir>/
//     index.html
//     <model-key>/
//       diagram.svg (or .png)
//       slices/
//         <slice-key>.html

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { Grid } from "../layout/grid.js";
import { renderDot } from "../render/render.js";
import { computeRefs } from "../emit/json.js";
import { Diagnostic } from "../model/validate.js";
import { dedupe, kebabSlug } from "../util/slug.js";
import { classifySlicePattern } from "./classify.js";
import { parseSliceDoc } from "./sliceDoc.js";
import { renderIndexPage, renderSlicePage, CatalogModelSummary, CatalogSliceSummary } from "./pages.js";

export interface CatalogModelInput {
  /** The .em file as given on the command line — used for the doc-discovery path and display. */
  file: string;
  model: NormalizedModel;
  grid: Grid;
  dot: string;
}

export interface CatalogOptions {
  outDir: string;
  format?: "svg" | "png";
  title?: string;
}

export interface CatalogBuildResult {
  models: number;
  slices: number;
  /** Ref-collision warnings raised while assigning slice/element keys (same diagnostics
   *  `em export`/`em diff` surface via computeRefs), tagged by the input file they came from —
   *  a duplicate slice/element name still gets a stable `~2` key here, but the caller should
   *  print these the same way every other command does rather than build silently. */
  diagnostics: { file: string; diagnostics: Diagnostic[] }[];
}

export async function buildCatalog(
  inputs: CatalogModelInput[],
  opts: CatalogOptions,
): Promise<CatalogBuildResult> {
  const format = opts.format ?? "svg";
  const title = opts.title ?? "Event Model Catalog";
  const outDir = opts.outDir;

  await mkdir(outDir, { recursive: true });

  const usedModelKeys = new Set<string>();
  const modelSummaries: CatalogModelSummary[] = [];
  const diagnostics: { file: string; diagnostics: Diagnostic[] }[] = [];
  let sliceCount = 0;

  for (const { file, model, grid, dot } of inputs) {
    const modelKey = dedupe(kebabSlug(basename(file, extname(file))), usedModelKeys, "~");
    const modelDir = join(outDir, modelKey);
    const slicesDir = join(modelDir, "slices");
    await mkdir(slicesDir, { recursive: true });

    const diagramFile = `diagram.${format}`;
    // baseDir = dirname(file), same as `em render`/`em watch` — this is why note hrefs
    // embedded in the diagram still resolve correctly from the catalog's output location.
    await renderDot(dot, model, grid, join(modelDir, diagramFile), format, dirname(file));

    const refs = computeRefs(model);
    if (refs.diagnostics.length > 0) diagnostics.push({ file, diagnostics: refs.diagnostics });
    const sliceSummaries: CatalogSliceSummary[] = [];

    for (let i = 0; i < model.slices.length; i++) {
      const slice = model.slices[i];
      const sliceKey = refs.sliceKeys[i];
      const pattern = classifySlicePattern(slice);

      // Look up the doc at the *deduped* key, not a fresh kebabSlug(slice.name): for the
      // (overwhelmingly common) case of a unique slice name they're identical, but if two
      // slices share a name (see the diagnostics above), only the first gets sliceKey ==
      // kebabSlug(name) — the doc a human actually authored on disk. The second slice's key
      // carries a "~2" suffix no doc file will ever match, so it honestly reports "no doc"
      // instead of silently rendering the first slice's doc content on both pages.
      const docRelPath = join("slices", `${sliceKey}.md`);
      const docPath = join(dirname(file), docRelPath);
      const doc = existsSync(docPath) ? parseSliceDoc(readFileSync(docPath, "utf8")) : null;

      const elementRefs = new Map<string, string>();
      for (const el of slice.elements) {
        const ref = refs.refById.get(el.id);
        if (ref) elementRefs.set(el.id, ref);
      }

      const page = renderSlicePage({
        modelName: model.name,
        diagramFile: `../${diagramFile}`,
        format,
        slice,
        sliceKey,
        pattern,
        elementRefs,
        doc,
        docExpectedPath: docRelPath,
      });
      await writeFile(join(slicesDir, `${sliceKey}.html`), page, "utf8");

      sliceSummaries.push({
        key: sliceKey,
        name: slice.name,
        pattern,
        hasDoc: doc !== null,
        status: doc?.status ?? null,
      });
      sliceCount++;
    }

    modelSummaries.push({ key: modelKey, name: model.name, file, diagramFile, slices: sliceSummaries });
  }

  const indexHtml = renderIndexPage(modelSummaries, title, format);
  await writeFile(join(outDir, "index.html"), indexHtml, "utf8");

  return { models: modelSummaries.length, slices: sliceCount, diagnostics };
}
