// SPDX-License-Identifier: MIT
// Draws "has notes" and "has issues" affordances on top of a Graphviz-rendered SVG:
//   - a small folded-corner (dog-ear) marker per noted box, top-right, amber, carrying
//     a footnote number, linked to the note file;
//   - a small folded-corner marker per element with an open `issue`, top-left, red,
//     carrying its own footnote number — no link (there's nothing to open), just a
//     `<title>` tooltip, since the full text lives in the legend;
//   - a legend appended below the diagram: a "Notes" section mapping each amber number
//     to its element and note file, and (when present) an "Issues" section mapping each
//     red number to its element and issue text.
// An element may carry both a note and an issue at once: the two markers sit on
// opposite top corners of the box, so they never overlap, and each keeps its own
// independent numbering (a "1" note and a "1" issue on the same box are unambiguous —
// distinct color, distinct corner, distinct legend section).
// In SVG the note markers/rows are anchors (click to open the markdown); issue
// markers/rows never are, since inline text has no file to link to. Raster output
// (PNG/PDF) can't carry links or tooltips either way, so the legend is what tells you
// which note or issue belongs to which element there.
//
// Marker coordinates come from parseNodeRects (the box coordinate space, inside
// Graphviz's transform group). The legend is laid out in the SVG's root/viewBox
// space, so it is appended after the diagram and the canvas is grown to fit.

import { Element, NormalizedModel } from "../model/model.js";
import { Rect } from "./svgGeometry.js";

const FOLD = 13; // leg length of the dog-ear, in user units
const INSET = 5; // pull off the bounding corner so it clears rounded box corners
const FILL = "#F4C430"; // sticky-note amber (notes)
const STROKE = "#7A5200"; // dark amber — reads on light and orange fills alike
const ISSUE_FILL = "#E53935"; // red sticky (open issues)
const ISSUE_STROKE = "#8B0000"; // dark red

/** Elements carrying a note, in document order. Index + 1 is the footnote number. */
export function notedElements(model: NormalizedModel): Element[] {
  return model.elements.filter((el) => el.note);
}

/** Elements carrying an open issue, in document order. Index + 1 is the footnote number. */
export function issuedElements(model: NormalizedModel): Element[] {
  return model.elements.filter((el) => el.issue);
}

/** How to turn an element's note into the link href (default: the raw note path). */
export type HrefOf = (el: Element) => string;

const rawNote: HrefOf = (el) => el.note ?? "";

/** SVG group with a numbered corner marker per noted element (inside the graph group). */
export function buildNoteMarkers(
  model: NormalizedModel,
  rects: Map<string, Rect>,
  hrefOf: HrefOf = rawNote,
): string {
  const markers: string[] = [];

  notedElements(model).forEach((el, i) => {
    const r = rects.get(el.id);
    if (!r) return;
    markers.push(noteMarker(r, hrefOf(el), i + 1));
  });

  return `<g class="em-notes">${markers.join("")}</g>`;
}

/** SVG group with a numbered corner marker per element with an open issue. */
export function buildIssueMarkers(model: NormalizedModel, rects: Map<string, Rect>): string {
  const markers: string[] = [];

  issuedElements(model).forEach((el, i) => {
    const r = rects.get(el.id);
    if (!r) return;
    markers.push(issueMarker(r, el.issue ?? "", i + 1));
  });

  return `<g class="em-issues">${markers.join("")}</g>`;
}

type Corner = "left" | "right";

/** The dog-ear glyph + footnote number, anchored at one top corner of the box. */
function cornerGlyph(r: Rect, num: number, corner: Corner, fill: string, stroke: string): string {
  const y = r.top + INSET; // y grows downward, so this nudges down from the top edge
  const x = corner === "right" ? r.right - INSET : r.left + INSET;
  const foldX = corner === "right" ? x - FOLD : x + FOLD;
  const tri = `M${n(foldX)},${n(y)} L${n(x)},${n(y)} L${n(x)},${n(y + FOLD)} Z`;
  const crease = `M${n(foldX)},${n(y)} L${n(x)},${n(y + FOLD)}`;
  const numX = corner === "right" ? foldX - 2 : foldX + 2;
  const numY = y + 9;
  const anchor = corner === "right" ? "end" : "start";
  return (
    `<path d="${tri}" fill="${fill}" stroke="${stroke}" stroke-width="1" stroke-linejoin="round"/>` +
    `<path d="${crease}" fill="none" stroke="${stroke}" stroke-width="0.7"/>` +
    `<text x="${n(numX)}" y="${n(numY)}" text-anchor="${anchor}" font-family="Helvetica" ` +
    `font-weight="bold" font-size="10" fill="${stroke}">${num}</text>`
  );
}

/** A folded-corner glyph + footnote number at the box's top-right, linked to the note. */
function noteMarker(r: Rect, note: string, num: number): string {
  const href = esc(note);
  return (
    `<a xlink:href="${href}" href="${href}" target="_blank">` +
    `<title>${num}. ${href}</title>` +
    cornerGlyph(r, num, "right", FILL, STROKE) +
    `</a>`
  );
}

/**
 * A folded-corner glyph + footnote number at the box's top-left, marking an open
 * issue. Unlike a note there's nothing to link to, so this carries a `<title>`
 * tooltip instead of an `<a>` wrapper — the legend below is the reliable way to
 * read the full issue text (tooltips don't survive rasterization either).
 */
function issueMarker(r: Rect, issue: string, num: number): string {
  return `<g><title>${num}. ${esc(issue)}</title>${cornerGlyph(r, num, "left", ISSUE_FILL, ISSUE_STROKE)}</g>`;
}

// ---- legend ----

const PAD_X = 16;
const PAD_TOP = 14;
const HEAD_H = 22;
const LINE_H = 18;
const PAD_BOTTOM = 14;

/**
 * Grow the canvas and append a legend below the diagram: a "Notes" section (if any
 * element has a note) and an "Issues" section (if any element has an open issue).
 * Returns the SVG unchanged if there's nothing to show or the dimensions can't be
 * parsed.
 */
export function appendNoteLegend(
  svg: string,
  model: NormalizedModel,
  hrefOf: HrefOf = rawNote,
): string {
  const noted = notedElements(model);
  const issued = issuedElements(model);
  if (noted.length === 0 && issued.length === 0) return svg;

  const vb = /viewBox="([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)"/.exec(svg);
  const hpt = /height="([\d.eE+-]+)pt"/.exec(svg);
  if (!vb || !hpt) return svg; // can't safely resize — leave markers only

  const minX = +vb[1];
  const minY = +vb[2];
  const vw = +vb[3];
  const vh = +vb[4];

  const notesH = noted.length > 0 ? HEAD_H + noted.length * LINE_H : 0;
  const issuesH = issued.length > 0 ? HEAD_H + issued.length * LINE_H : 0;
  const legendH = PAD_TOP + notesH + issuesH + PAD_BOTTOM;
  const newVh = vh + legendH;
  const newHpt = (+hpt[1]) * (newVh / vh); // keep the pt:viewBox ratio (handles scaling)
  const top = minY + vh; // legend sits just below the diagram, in root coords

  let out = svg;
  out = out.replace(hpt[0], `height="${n(newHpt)}pt"`);
  out = out.replace(vb[0], `viewBox="${vb[1]} ${vb[2]} ${vb[3]} ${n(newVh)}"`);

  let sectionY = top + PAD_TOP;
  let sections = "";

  if (noted.length > 0) {
    sections +=
      `<text x="${n(minX + PAD_X)}" y="${n(sectionY + 14)}" font-family="Helvetica" ` +
      `font-weight="bold" font-size="12" fill="#202124">Notes</text>`;
    sections += noted
      .map((el, i) =>
        row(el, hrefOf(el), i + 1, minX + PAD_X, sectionY + HEAD_H + i * LINE_H + 13, "note"),
      )
      .join("");
    sectionY += notesH;
  }

  if (issued.length > 0) {
    sections +=
      `<text x="${n(minX + PAD_X)}" y="${n(sectionY + 14)}" font-family="Helvetica" ` +
      `font-weight="bold" font-size="12" fill="${ISSUE_STROKE}">Issues</text>`;
    sections += issued
      .map((el, i) =>
        row(el, el.issue ?? "", i + 1, minX + PAD_X, sectionY + HEAD_H + i * LINE_H + 13, "issue"),
      )
      .join("");
    sectionY += issuesH;
  }

  const legend =
    `<g class="em-note-legend">` +
    `<rect x="${n(minX)}" y="${n(top)}" width="${n(vw)}" height="${n(legendH)}" fill="#FFFFFF"/>` +
    `<line x1="${n(minX)}" y1="${n(top)}" x2="${n(minX + vw)}" y2="${n(top)}" stroke="#D0D0D0" stroke-width="1"/>` +
    sections +
    `</g>`;

  return out.replace(/(<\/g>\s*)(<\/svg>)/, `$1${legend}$2`);
}

/**
 * One legend row: "N.  Element name — text". Notes rows link to the note file;
 * issue rows carry the full issue text and have no link target.
 */
function row(
  el: Element,
  hrefOrText: string,
  num: number,
  x: number,
  y: number,
  kind: "note" | "issue" = "note",
): string {
  const color = kind === "issue" ? ISSUE_STROKE : STROKE;
  const label = esc(kind === "issue" ? el.issue ?? "" : el.note ?? ""); // readable text
  const name = esc(el.name);
  const text =
    `<text x="${n(x)}" y="${n(y)}" font-family="Helvetica" font-size="11" fill="#202124">` +
    `<tspan font-weight="bold" fill="${color}">${num}.</tspan>` +
    `<tspan dx="6">${name}</tspan>` +
    `<tspan dx="6" fill="#5F6368">— ${label}</tspan>` +
    `</text>`;
  if (kind === "issue") return text; // nothing to link to
  const href = esc(hrefOrText); // resolved link target
  return `<a xlink:href="${href}" href="${href}" target="_blank">${text}</a>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function n(v: number): number {
  return Math.round(v * 100) / 100;
}
