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

const PATTERN: Record<string, string> = { "place-order": "state-change", "place-order-manually": "state-change", orders: "state-view", "cancel-order-customer": "state-change", "cancel-order-timeout": "state-change", shipments: "state-view" };

/** Doc text for slice `key`; `staleViewRegion` rewrites the "built from" line to the 1.17 origin-only form. */
export function sliceDocText(key: string, opts: { staleViewRegion?: boolean; status?: string; extraBody?: string; stage2?: boolean } = {}): string {
  const { model } = compile(opts.stage2 === true ? MODEL_117_STAGE2 : MODEL_117);
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
export function writeModel117(dir: string, opts: { signedOrders?: boolean; stage2?: boolean } = {}): void {
  mkdirSync(join(dir, "slices"), { recursive: true });
  writeFileSync(join(dir, "orders.em"), opts.stage2 === true ? MODEL_117_STAGE2 : MODEL_117);
  if (opts.stage2 === true) {
    writeFileSync(join(dir, "slices", "cancel-order-customer.md"), sliceDocText("cancel-order-customer", { stage2: true }));
    writeFileSync(join(dir, "slices", "cancel-order-timeout.md"), sliceDocText("cancel-order-timeout", { stage2: true }));
  }
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

// ---- GH #290 stage 2: the PIM shape (repeated-command columns) and a hand-named continuation ----

/** `MODEL_117` plus: two columns that repeat ONE command and differ only in the recorded event (the
 *  PIM shape, collapses to `event A | B @Sales`), and two consecutive hand-named continuations of ONE view after their host
 *  command slice (stack into the first), then a third continuation of a DIFFERENT view (stays separate). */
export const MODEL_117_STAGE2 =
  MODEL_117 +
  `
slice "Cancel Order Customer" {
  ui Cancel Form @Clerk
  command Cancel Order note "slices/cancel-order-customer.md"
  event Order Cancelled By Customer @Sales { orderId: string, reason: string }
}

slice "Cancel Order Timeout" {
  ui Cancel Form @Clerk
  command Cancel Order
  event Order Cancelled By Timeout @Sales { orderId: string, reason: string }
}

slice "Cancellations" {
  view Cancellations from "Order Cancelled By Customer", "Order Cancelled By Timeout" { orderId: string, reason: string }
  ui Cancellation List @Clerk
}

slice "Shipments" {
  view Shipments from "Order Placed" { orderId: string }
  ui Shipment List @Clerk
}

slice "Ship Order" {
  ui Ship Form @Clerk
  command Ship Order
  event Order Shipped @Sales { orderId: string }
}

slice "Shipments after ship" {
  view Shipments again from "Order Shipped" { orderId: string }
  ui Shipment List @Clerk
}

slice "Shipments after ship, again" {
  view Shipments again from "Order Shipped" { orderId: string }
  ui Shipment List @Clerk
}

slice "Orders after ship" {
  view Orders again from "Order Shipped" { orderId: string }
  ui Order List @Clerk
}
`;
