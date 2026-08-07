// SPDX-License-Identifier: MIT
// Recolors each slice header cell's fill/stroke/font in a Graphviz-rendered SVG
// based on that slice's development status (see src/render/sliceStatus.ts),
// and appends a small legend explaining the colors actually used.
//
// This is a post-layout overlay, the same pattern as drawEdges.ts/drawNotes.ts:
// Graphviz always lays out every header cell identically (status never affects
// size, only color), so recoloring is a scoped string replace on the already-
// rendered header node group rather than anything that needs new geometry.

import { Grid, headerCellId } from "../layout/grid.js";
import { HEADER_FILL, HEADER_BORDER, HEADER_FONT } from "../emit/dot.js";
import { NodeStyle, statusStyle } from "../emit/theme.js";

// Graphviz lowercases hex colors in its SVG output (e.g. our "#E3E7EB" comes
// back as "#e3e7eb"), so matching must be case-insensitive even though we
// authored the DOT-side constants in uppercase.
function attrRe(name: string, value: string): RegExp {
  return new RegExp(`${name}="${value}"`, "gi");
}

/** Recolor each header cell whose slice resolved to a known status (see
 *  statusStyle()). Slices with no doc, `draft`, or an unrecognized status
 *  string are left with the default header colors, untouched. */
export function applyStatusColors(svg: string, grid: Grid, statuses: (string | null)[]): string {
  let out = svg;
  for (let c = 0; c < grid.cols; c++) {
    const style = statusStyle(statuses[c] ?? null);
    if (!style) continue;
    const id = headerCellId(c);
    const re = new RegExp(`(<title>${id}</title>)([\\s\\S]*?)(</g>)`);
    out = out.replace(re, (_whole, title: string, body: string, close: string) => {
      const recolored = body
        .replace(attrRe("fill", HEADER_FILL), `fill="${style.fill}"`)
        .replace(attrRe("stroke", HEADER_BORDER), `stroke="${style.stroke}"`)
        .replace(attrRe("fill", HEADER_FONT), `fill="${style.fontColor}"`);
      return title + recolored + close;
    });
  }
  return out;
}

// ---- legend ----

const PAD_X = 16;
const PAD_TOP = 14;
const HEAD_H = 22;
const LINE_H = 18;
const PAD_BOTTOM = 14;
const SWATCH = 11;

/** Canonical display order, independent of column order — a model's slices can
 *  land in any status in any order, but the legend should read the same way
 *  (earliest-to-latest lifecycle stage) every time. */
const STATUS_ORDER = ["reviewed", "ready-to-implement", "implemented"];

function humanizeStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1).replace(/-/g, " ");
}

/**
 * Grow the canvas and append a "Slice Status" legend below the diagram, one
 * swatch+label row per distinct known status actually present among
 * `statuses`. Returns the SVG unchanged if no slice resolved to a known
 * status (nobody's using slice docs yet, or none set a recognized value), or
 * if the SVG's dimensions can't be parsed. Independent of appendNoteLegend
 * (src/render/drawNotes.ts) — safe to call after it since it recomputes the
 * (possibly already-grown) viewBox itself, same as every other
 * append-below-diagram step in the render pipeline.
 */
export function appendStatusLegend(svg: string, grid: Grid, statuses: (string | null)[]): string {
  const present = new Set(
    statuses.slice(0, grid.cols).map((s) => s?.toLowerCase()).filter((s): s is string => !!s),
  );
  const rows = STATUS_ORDER.filter((s) => present.has(s));
  if (rows.length === 0) return svg;

  const vb = /viewBox="([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)"/.exec(svg);
  const hpt = /height="([\d.eE+-]+)pt"/.exec(svg);
  if (!vb || !hpt) return svg;

  const minX = +vb[1];
  const minY = +vb[2];
  const vw = +vb[3];
  const vh = +vb[4];

  const legendH = PAD_TOP + HEAD_H + rows.length * LINE_H + PAD_BOTTOM;
  const newVh = vh + legendH;
  const newHpt = +hpt[1] * (newVh / vh);
  const top = minY + vh;

  let out = svg;
  out = out.replace(hpt[0], `height="${n(newHpt)}pt"`);
  out = out.replace(vb[0], `viewBox="${vb[1]} ${vb[2]} ${vb[3]} ${n(newVh)}"`);

  const sectionY = top + PAD_TOP;
  let sections =
    `<text x="${n(minX + PAD_X)}" y="${n(sectionY + 14)}" font-family="Helvetica" ` +
    `font-weight="bold" font-size="12" fill="#202124">Slice Status</text>`;
  sections += rows
    .map((status, i) => {
      const style = statusStyle(status) as NodeStyle;
      const y = sectionY + HEAD_H + i * LINE_H;
      return (
        `<rect x="${n(minX + PAD_X)}" y="${n(y)}" width="${SWATCH}" height="${SWATCH}" ` +
        `fill="${style.fill}" stroke="${style.stroke}"/>` +
        `<text x="${n(minX + PAD_X + SWATCH + 6)}" y="${n(y + SWATCH - 1)}" font-family="Helvetica" ` +
        `font-size="11" fill="#3C4043">${esc(humanizeStatus(status))}</text>`
      );
    })
    .join("");

  const legend =
    `<g class="em-status-legend">` +
    `<rect x="${n(minX)}" y="${n(top)}" width="${n(vw)}" height="${n(legendH)}" fill="#FFFFFF"/>` +
    `<line x1="${n(minX)}" y1="${n(top)}" x2="${n(minX + vw)}" y2="${n(top)}" stroke="#D0D0D0" stroke-width="1"/>` +
    sections +
    `</g>`;

  return out.replace(/(<\/g>\s*)(<\/svg>)/, `$1${legend}$2`);
}

function n(v: number): string {
  return String(Math.round(v * 100) / 100);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
