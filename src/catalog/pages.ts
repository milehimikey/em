// SPDX-License-Identifier: MIT
// HTML-string builders for `em catalog`'s static site: an index page and one
// per-slice detail page. Hand-written template literals, no templating
// library. (The live-viewer page went the other way — a real HTML file,
// src/render/viewer.html, shipped as a generated constant — because it is one
// static 600-line page; these stay literals since they vary per model/slice.)

import { Element, Slice } from "../model/model.js";
import { SlicePattern, slicePatternLabel } from "./classify.js";
import { SliceDoc } from "./sliceDoc.js";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** A slice's row in the index page's per-model table. */
export interface CatalogSliceSummary {
  key: string;
  name: string;
  pattern: SlicePattern;
  /** Whether a slices/<key>.md doc was found at all — distinct from `status` being null,
   *  which can also mean "doc exists but has no recognizable Status line". */
  hasDoc: boolean;
  /** Lowercased Status value from the doc, or null (no doc, or doc has no Status line). */
  status: string | null;
}

export interface CatalogModelSummary {
  key: string;
  name: string;
  /** Input .em file path, as given on the command line. */
  file: string;
  /** Diagram filename, relative to <outDir>/<model-key>/. */
  diagramFile: string;
  slices: CatalogSliceSummary[];
}

/** Human-readable status cell: "no doc" (nothing found), "unknown" (doc found, no Status
 *  line), or the doc's own Status value verbatim. Shared by the index and slice pages so the
 *  two never drift out of sync on how a missing/freeform doc reads. */
function statusLabel(hasDoc: boolean, status: string | null): string {
  if (!hasDoc) return "no doc";
  if (!status) return "unknown";
  return status;
}

/** MIME type for the diagram `<object>` — must match the actual file `buildCatalog` wrote
 *  (`diagram.svg` or `diagram.png`), or the browser won't render it. */
function diagramMimeType(format: "svg" | "png"): string {
  return format === "png" ? "image/png" : "image/svg+xml";
}

/** `homeHref` is relative to the page being built (`index.html` from the index page itself,
 *  `../../index.html` from a slice page two levels down) so the site works opened straight
 *  off disk via `file://`, with no server — an absolute `href="/"` would jump to the
 *  filesystem root instead. */
function layout(title: string, bodyHtml: string, homeHref: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0; font-family: system-ui, sans-serif; line-height: 1.5;
      background: #fafafa; color: #1f2933;
    }
    header {
      padding: .75rem 1.25rem; background: #1f2933; color: #fff;
    }
    header a { color: #fff; text-decoration: none; }
    main { max-width: 960px; margin: 0 auto; padding: 1.5rem 1.25rem 3rem; }
    table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
    th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #ddd; font-size: 14px; }
    th { font-weight: 600; background: #f0f2f5; }
    .status { display: inline-block; padding: .1rem .5rem; border-radius: 999px; font-size: 12px; background: #e4e7eb; }
    .pattern { font-size: 12px; color: #52606d; }
    /* Fixed-height frame, not a width-driven one: a slice diagram is often
       narrow and tall relative to the full model's wide/short diagram, so
       sizing by width alone would blow a narrow one's height up hugely.
       object-fit doesn't apply to <object> the way it does <img> (needed here,
       not <img>, so the SVG's clickable note links keep working) — giving it a
       DEFINITE width AND height together stretches it non-uniformly, distorting
       the aspect ratio instead of preserving it. width:auto + height:100% +
       max-width:100% instead sizes it from its own intrinsic aspect ratio
       (capped, never overflowing the frame); the flex centers it horizontally. */
    .diagram-frame {
      height: 420px; border: 1px solid #ddd; margin: 1rem 0; overflow: hidden; background: #fff;
      display: flex; align-items: flex-start; justify-content: center;
    }
    object.diagram { width: auto; height: 100%; max-width: 100%; }
    .full-diagram-link { margin: 0 0 1rem; font-size: 13px; }
    .doc { margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid #ddd; }
    .doc h1 { font-size: 1.3rem; }
    .doc h2 { font-size: 1.05rem; }
    .no-doc { color: #7b8794; font-style: italic; }
    code { background: #eee; padding: .05rem .3rem; border-radius: 3px; }
  </style>
</head>
<body>
  <header><a href="${escapeHtml(homeHref)}">Event Model Catalog</a></header>
  <main>
${bodyHtml}
  </main>
</body>
</html>
`;
}

export function renderIndexPage(models: CatalogModelSummary[], title: string, format: "svg" | "png"): string {
  const sections = models
    .map((m) => {
      const rows = m.slices
        .map(
          (s) => `      <tr>
        <td><a href="${escapeHtml(m.key)}/slices/${escapeHtml(s.key)}.html">${escapeHtml(s.name)}</a></td>
        <td class="pattern">${escapeHtml(slicePatternLabel(s.pattern))}</td>
        <td><span class="status">${escapeHtml(statusLabel(s.hasDoc, s.status))}</span></td>
      </tr>`,
        )
        .join("\n");
      const diagramHref = `${escapeHtml(m.key)}/${escapeHtml(m.diagramFile)}`;
      return `    <section>
      <h2>${escapeHtml(m.name)}</h2>
      <p>${m.slices.length} slice${m.slices.length === 1 ? "" : "s"} · <code>${escapeHtml(m.file)}</code> · <a href="${diagramHref}">open diagram full-size</a></p>
      <div class="diagram-frame"><object class="diagram" type="${diagramMimeType(format)}" data="${diagramHref}"></object></div>
      <table>
        <thead><tr><th>Slice</th><th>Pattern</th><th>Status</th></tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </section>`;
    })
    .join("\n");

  return layout(
    title,
    `    <h1>${escapeHtml(title)}</h1>
${sections}`,
    "index.html",
  );
}

export interface SlicePageArgs {
  modelName: string;
  /** Full model diagram path relative to this page (which lives in
   *  <outDir>/<model-key>/slices/) — shown as a secondary "view full diagram" link
   *  (a plain anchor, not an embed, so no MIME type is needed here). */
  diagramFile: string;
  /** This slice's own diagram, relative to this page (same directory) — always
   *  svg (buildSliceDiagram writes svg regardless of the main diagram's chosen
   *  format). Shown as the page's primary diagram. */
  sliceDiagramFile: string;
  slice: Slice;
  sliceKey: string;
  pattern: SlicePattern;
  /** Internal Element.id -> em export ref, for stable per-row anchors. */
  elementRefs: Map<string, string>;
  doc: SliceDoc | null;
  /** slices/<slug>.md, relative to the source .em file — shown when no doc was found. */
  docExpectedPath: string;
}

function formatFields(el: Element): string {
  if (!el.fields || el.fields.length === 0) return "";
  return el.fields.map((f) => (f.type ? `${f.name}: ${f.type}` : f.name)).join(", ");
}

function elementDetail(el: Element): string {
  const parts: string[] = [];
  if (el.persona) parts.push(`@${el.persona}`);
  if (el.context) parts.push(`@${el.context}`);
  if (el.from && el.from.length > 0) parts.push(`from ${el.from.join(", ")}`);
  if (el.again) parts.push("again");
  if (el.public) parts.push("public");
  const fields = formatFields(el);
  if (fields) parts.push(`{ ${fields} }`);
  return parts.map(escapeHtml).join(" &middot; ");
}

function renderElementsTable(slice: Slice, elementRefs: Map<string, string>): string {
  const rows = slice.elements
    .map((el) => {
      const ref = elementRefs.get(el.id);
      const anchor = ref ? ` id="${escapeHtml(ref)}"` : "";
      const annotations: string[] = [];
      if (el.issue) annotations.push(`<div><span class="status">issue</span> ${escapeHtml(el.issue)}</div>`);
      if (el.divergence) annotations.push(`<div><span class="status">divergence</span> ${escapeHtml(el.divergence)}</div>`);
      return `      <tr${anchor}>
        <td>${escapeHtml(el.kind)}</td>
        <td>${escapeHtml(el.name)}</td>
        <td>${elementDetail(el)}${annotations.join("")}</td>
      </tr>`;
    })
    .join("\n");

  return `    <table>
      <thead><tr><th>Kind</th><th>Name</th><th>Detail</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>`;
}

export function renderSlicePage(args: SlicePageArgs): string {
  const { modelName, diagramFile, sliceDiagramFile, slice, pattern, elementRefs, doc, docExpectedPath } = args;

  const docSection = doc
    ? `    <div class="doc">${doc.html}</div>`
    : `    <p class="no-doc">No slice doc found at <code>${escapeHtml(docExpectedPath)}</code>.</p>`;

  return layout(
    `${slice.name} — ${modelName}`,
    `    <p><a href="../../index.html">&larr; ${escapeHtml(modelName)}</a></p>
    <h1>${escapeHtml(slice.name)}</h1>
    <p class="pattern">${escapeHtml(slicePatternLabel(pattern))} · <span class="status">${escapeHtml(statusLabel(!!doc, doc?.status ?? null))}</span></p>
    <div class="diagram-frame"><object class="diagram" type="image/svg+xml" data="${escapeHtml(sliceDiagramFile)}"></object></div>
    <p class="full-diagram-link"><a href="${escapeHtml(diagramFile)}">View full model diagram &rarr;</a></p>
${renderElementsTable(slice, elementRefs)}
${docSection}`,
    "../../index.html",
  );
}
