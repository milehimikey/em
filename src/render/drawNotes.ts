// Draws "has notes" affordances on top of a Graphviz-rendered SVG:
//   - a small folded-corner (dog-ear) marker in each noted box's top-right
//     corner, carrying a footnote number;
//   - a legend appended below the diagram mapping each number to its element
//     and note file.
// In SVG the markers and legend rows are anchors (click to open the markdown);
// raster output (PNG/PDF) can't carry links, so the footnote number + legend
// are what tell you which note belongs to which element.
//
// Marker coordinates come from parseNodeRects (the box coordinate space, inside
// Graphviz's transform group). The legend is laid out in the SVG's root/viewBox
// space, so it is appended after the diagram and the canvas is grown to fit.

import { Element, NormalizedModel } from "../model/model.js";
import { Rect } from "./svgGeometry.js";

const FOLD = 13; // leg length of the dog-ear, in user units
const INSET = 5; // pull off the bounding corner so it clears rounded box corners
const FILL = "#F4C430"; // sticky-note amber
const STROKE = "#7A5200"; // dark amber — reads on light and orange fills alike

/** Elements carrying a note, in document order. Index + 1 is the footnote number. */
export function notedElements(model: NormalizedModel): Element[] {
  return model.elements.filter((el) => el.note);
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
    markers.push(marker(r, hrefOf(el), i + 1));
  });

  return `<g class="em-notes">${markers.join("")}</g>`;
}

/** A folded-corner glyph + footnote number at the box's top-right, linked to the note. */
function marker(r: Rect, note: string, num: number): string {
  const href = esc(note);
  // Dog-ear inset from the box's top-right corner: a filled triangle whose
  // right-angle sits on the box face, with a fold crease across its hypotenuse.
  const x = r.right - INSET;
  const y = r.top + INSET; // y grows downward, so this nudges down from the top edge
  const tri = `M${n(x - FOLD)},${n(y)} L${n(x)},${n(y)} L${n(x)},${n(y + FOLD)} Z`;
  const crease = `M${n(x - FOLD)},${n(y)} L${n(x)},${n(y + FOLD)}`;
  // footnote number, just left of the fold, inside the box
  const numX = x - FOLD - 2;
  const numY = y + 9;
  return (
    `<a xlink:href="${href}" href="${href}" target="_blank">` +
    `<title>${num}. ${href}</title>` +
    `<path d="${tri}" fill="${FILL}" stroke="${STROKE}" stroke-width="1" stroke-linejoin="round"/>` +
    `<path d="${crease}" fill="none" stroke="${STROKE}" stroke-width="0.7"/>` +
    `<text x="${n(numX)}" y="${n(numY)}" text-anchor="end" font-family="Helvetica" ` +
    `font-weight="bold" font-size="10" fill="${STROKE}">${num}</text>` +
    `</a>`
  );
}

// ---- legend ----

const PAD_X = 16;
const PAD_TOP = 14;
const HEAD_H = 22;
const LINE_H = 18;
const PAD_BOTTOM = 14;

/**
 * Grow the canvas and append a notes legend below the diagram. Returns the SVG
 * unchanged if there are no notes or the dimensions can't be parsed.
 */
export function appendNoteLegend(
  svg: string,
  model: NormalizedModel,
  hrefOf: HrefOf = rawNote,
): string {
  const noted = notedElements(model);
  if (noted.length === 0) return svg;

  const vb = /viewBox="([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)"/.exec(svg);
  const hpt = /height="([\d.eE+-]+)pt"/.exec(svg);
  if (!vb || !hpt) return svg; // can't safely resize — leave markers only

  const minX = +vb[1];
  const minY = +vb[2];
  const vw = +vb[3];
  const vh = +vb[4];

  const legendH = PAD_TOP + HEAD_H + noted.length * LINE_H + PAD_BOTTOM;
  const newVh = vh + legendH;
  const newHpt = (+hpt[1]) * (newVh / vh); // keep the pt:viewBox ratio (handles scaling)
  const top = minY + vh; // legend sits just below the diagram, in root coords

  let out = svg;
  out = out.replace(hpt[0], `height="${n(newHpt)}pt"`);
  out = out.replace(vb[0], `viewBox="${vb[1]} ${vb[2]} ${vb[3]} ${n(newVh)}"`);

  const rows = noted
    .map((el, i) =>
      row(el, hrefOf(el), i + 1, minX + PAD_X, top + PAD_TOP + HEAD_H + i * LINE_H + 13),
    )
    .join("");

  const legend =
    `<g class="em-note-legend">` +
    `<rect x="${n(minX)}" y="${n(top)}" width="${n(vw)}" height="${n(legendH)}" fill="#FFFFFF"/>` +
    `<line x1="${n(minX)}" y1="${n(top)}" x2="${n(minX + vw)}" y2="${n(top)}" stroke="#D0D0D0" stroke-width="1"/>` +
    `<text x="${n(minX + PAD_X)}" y="${n(top + PAD_TOP + 14)}" font-family="Helvetica" ` +
    `font-weight="bold" font-size="12" fill="#202124">Notes</text>` +
    rows +
    `</g>`;

  return out.replace(/(<\/g>\s*)(<\/svg>)/, `$1${legend}$2`);
}

/** One legend row: "N.  Element name — path", linked to the note. */
function row(el: Element, note: string, num: number, x: number, y: number): string {
  const href = esc(note); // resolved link target
  const label = esc(el.note ?? ""); // authored path, shown as the readable label
  const name = esc(el.name);
  return (
    `<a xlink:href="${href}" href="${href}" target="_blank">` +
    `<text x="${n(x)}" y="${n(y)}" font-family="Helvetica" font-size="11" fill="#202124">` +
    `<tspan font-weight="bold" fill="${STROKE}">${num}.</tspan>` +
    `<tspan dx="6">${name}</tspan>` +
    `<tspan dx="6" fill="#5F6368">— ${label}</tspan>` +
    `</text></a>`
  );
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
