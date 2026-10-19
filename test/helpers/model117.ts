// SPDX-License-Identifier: MIT
// GH #290: a "1.17.0-shaped" model repo — what a team that adopted em at 1.17 has on disk when it
// first runs 1.18's `em upgrade`: a read model with a hand-named continuation slice whose
// generated view region still lists only the ORIGIN instance's events (pre-GH #280), a README
// Slices table that predates GH #275's rows, and a parking-lot bullet holding a fragment of an
// Open Questions item (pre-GH #305). Neutral orders domain.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "../../src/pipeline.js";
import { buildSliceRegions } from "../../src/catalog/sliceSections.js";
import { regionEndLine, regionStartLine } from "../../src/catalog/sliceSections.js";
import { scaffoldStateFile } from "../../src/templates.js";

export const MODEL_117 = `model "Orders"
context Sales
persona Clerk

slice "Place Order" source "docs/orders.md#place" {
  ui Order Form @Clerk
  command Place Order note "slices/place-order.md"
  event Order Placed @Sales { orderId: string, total: number }
}

slice "Place Order Manually" source "docs/orders.md#place" {
  ui Manual Form @Clerk
  command Place Order Manually note "slices/place-order-manually.md"
  event Order Placed Manually @Sales { orderId: string, approvedBy: string }
}

slice "Orders" {
  view Orders from "Order Placed" { orderId: string, total: number, approvedBy: string } note "slices/orders.md"
  ui Order List @Clerk
}

slice "Orders manual" {
  view Orders again from "Order Placed Manually" { approvedBy: string }
  ui Order List @Clerk
}
`;

const PATTERN: Record<string, string> = { "place-order": "state-change", "place-order-manually": "state-change", orders: "state-view" };

/** Doc text for slice `key`; `staleViewRegion` rewrites the "built from" line to the 1.17 origin-only form. */
export function sliceDocText(key: string, opts: { staleViewRegion?: boolean; status?: string; extraBody?: string } = {}): string {
  const { model } = compile(MODEL_117);
  const idx = model.slices.findIndex((s) => s.name.toLowerCase().replace(/\s+/g, "-") === key);
  const regions = buildSliceRegions(model, [idx]);
  const body = regions
    .map((r) => {
      let lines = r.body;
      if (opts.staleViewRegion === true && r.kind === "view") {
        lines = lines.map((l) => (l.startsWith("- **View:**") ? '- **View:** `Orders` built from events: "Order Placed"' : l));
      }
      return [regionStartLine(r.name), ...lines, regionEndLine(r.name)].join("\n");
    })
    .join("\n\n");
  return (
    `---\nschemaVersion: 1\npattern: ${PATTERN[key]}\nswimlane: orders\nstatus: ${opts.status ?? "draft"}\nversion: 1\n---\n# ${key}\n\n${body}\n\n` +
    `## Open Questions\n\n- [x] **Retry policy** how many retries? — v1: fail fast; deferred to v2 (2026-10-12, Alex)\n${opts.extraBody ?? ""}`
  );
}

export const README_117 = "# Orders\n\n## Slices\n\n<!-- GENERATED:slices:start -->\n| # | Slice |\n|---|---|\n| 1 | Place Order |\n<!-- GENERATED:slices:end -->\n";

export function stateFile117(): string {
  const base = scaffoldStateFile("Orders", "orders", "2026-10-01", "1.17.0");
  return base.replace(/(## Open questions \/ parking lot\n)/, "$1\n- how many (from slice place-order, deferred to v2)\n");
}

/** Writes the repo content (no git) into `dir`. */
export function writeModel117(dir: string, opts: { signedOrders?: boolean } = {}): void {
  mkdirSync(join(dir, "slices"), { recursive: true });
  writeFileSync(join(dir, "orders.em"), MODEL_117);
  writeFileSync(join(dir, "README.md"), README_117);
  writeFileSync(join(dir, ".event-modeling.md"), stateFile117());
  writeFileSync(join(dir, "slices", "place-order.md"), sliceDocText("place-order"));
  writeFileSync(join(dir, "slices", "place-order-manually.md"), sliceDocText("place-order-manually"));
  writeFileSync(
    join(dir, "slices", "orders.md"),
    sliceDocText("orders", { staleViewRegion: true }).replace(
      "status: draft",
      opts.signedOrders === true ? "status: implemented" : "status: draft",
    ),
  );
}
