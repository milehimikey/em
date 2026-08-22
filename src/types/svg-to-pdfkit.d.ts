// SPDX-License-Identifier: MIT
// svg-to-pdfkit ships no type declarations (plain CJS, "main": "source.js") — this is the
// minimal ambient shape src/render/render.ts actually calls. Not a full API surface.

declare module "svg-to-pdfkit" {
  import type PDFDocument from "pdfkit";

  function SVGtoPDF(
    doc: PDFDocument,
    svg: string,
    x?: number,
    y?: number,
    options?: Record<string, unknown>,
  ): void;

  export = SVGtoPDF;
}
