// SPDX-License-Identifier: MIT
// Testable input handling for `em catalog`: --format validation, factored
// out of cli.ts so it's unit-testable without spawning a subprocess (mirrors
// src/cli/glossary-inputs.ts's planGlossaryArgs shape).

/** Resolved `em catalog` flag validation, or a user-facing `error`. */
export type CatalogPlan = { error: string } | { ok: true; format: "svg" | "png" };

/**
 * Validate the `em catalog` `--format` flag. Pure — no I/O. Only svg/png are
 * accepted: the per-slice page embeds the diagram in an `<object>`/`<img>`,
 * which needs a format a browser can render directly — pdf (and any other
 * rsvg-convert-only format) is out of scope for a static browsable site.
 */
export function planCatalogArgs(opts: { format?: string }): CatalogPlan {
  const format = opts.format ?? "svg";
  if (format !== "svg" && format !== "png") {
    return { error: `em catalog: unsupported --format '${format}' (catalog diagrams support svg or png only)` };
  }
  return { ok: true, format };
}
