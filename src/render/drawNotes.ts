// Draws a small "has notes" marker on top of any box whose element carries a
// `note "path.md"` clause. The marker is a folded corner (dog-ear) in the box's
// top-right corner — an unobtrusive annotation affordance that doesn't disturb
// the grid. In SVG it is wrapped in an anchor so clicking it opens the linked
// markdown; raster output (rsvg→PNG) keeps the marker but drops the link.
//
// Coordinates come from parseNodeRects (same user space as the SVG); y grows
// downward, so the box top edge has the smaller y.

import { NormalizedModel } from "../model/model.js";
import { Rect } from "./svgGeometry.js";

const FOLD = 13; // leg length of the dog-ear, in user units
const INSET = 5; // pull off the bounding corner so it clears rounded box corners
const FILL = "#F4C430"; // sticky-note amber
const STROKE = "#7A5200"; // dark amber — reads on light and orange fills alike

/** SVG group with a corner marker per noted element (empty group if none). */
export function buildNoteMarkers(model: NormalizedModel, rects: Map<string, Rect>): string {
  const markers: string[] = [];

  for (const el of model.elements) {
    if (!el.note) continue;
    const r = rects.get(el.id);
    if (!r) continue;
    markers.push(marker(r, el.note));
  }

  return `<g class="em-notes">${markers.join("")}</g>`;
}

/** A folded-corner glyph at the box's top-right, linked to the note file. */
function marker(r: Rect, note: string): string {
  const href = esc(note);
  // Dog-ear inset from the box's top-right corner: a filled triangle whose
  // right-angle sits on the box face, with a fold crease across its hypotenuse.
  const x = r.right - INSET;
  const y = r.top + INSET; // y grows downward, so this nudges down from the top edge
  const tri = `M${n(x - FOLD)},${n(y)} L${n(x)},${n(y)} L${n(x)},${n(y + FOLD)} Z`;
  const crease = `M${n(x - FOLD)},${n(y)} L${n(x)},${n(y + FOLD)}`;
  return (
    `<a xlink:href="${href}" href="${href}" target="_blank">` +
    `<title>${href}</title>` +
    `<path d="${tri}" fill="${FILL}" stroke="${STROKE}" stroke-width="1" stroke-linejoin="round"/>` +
    `<path d="${crease}" fill="none" stroke="${STROKE}" stroke-width="0.7"/>` +
    `</a>`
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
