// SPDX-License-Identifier: MIT
// Shared first-class-invariants fixture (MIL-265): one small two-slice model plus its slice docs
// and a test tree, written into a caller-supplied directory.
//
//   - `place-order`: the command declares INV-ORD-1 and the event declares INV-ORD-2 in the model
//     (`invariant` lines); its doc CITES INV-ORD-1 in its Invariants section (`- INV-ORD-1 — …`,
//     the citation shape, not the `**INV-X:**` declaring label) and INV-ORD-2 in a scenario.
//   - `cancel-order`: its doc declares a 1.13-style doc-only `INV-1`, and — MIL-155's
//     cross-credit shape — mentions the model-declared `INV-ORD-1` on a structural Invariants
//     bullet of its own. Model-first reading credits INV-ORD-1 to `place-order` only.
//
// `withGrammar: false` writes the SAME docs and test tree with the `invariant` lines removed —
// the 1.13-style input whose `em coverage --json` / `em query invariant` output is pinned
// byte-for-byte by test/fixtures/invariant-baseline/ (captured from em 1.13.1 + MIL-259, before
// the model-first readers existed).
//
// The commands stay internal here (the baseline must be valid 1.13 input); test/validate.test.ts
// writes them `public` (MIL-237) for `public-command-without-invariants`. Field types use the
// MIL-237 public table (`decimal`) since the events are public; the 1.13 CLI gives the same
// baseline output for this text (re-verified at the post-MIL-237 rebase).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function invariantFixtureModel(withGrammar: boolean): string {
  const inv = (line: string) => (withGrammar ? `  ${line}\n` : "");
  return (
    `model "Invariant Shop"\n\n` +
    `slice "Place Order" {\n` +
    `  ui Checkout\n` +
    `  command Place Order { orderId: UUID, total: decimal } note "slices/place-order.md"\n` +
    inv(`invariant INV-ORD-1 "Order total must be positive"`) +
    `  event Order Placed { orderId: UUID, total: decimal } public\n` +
    inv(`invariant INV-ORD-2 "An order is placed at most once"`) +
    `}\n\n` +
    `slice "Orders" {\n` +
    `  view Orders from "Order Placed"\n` +
    `  ui Order List\n` +
    `}\n\n` +
    `slice "Cancel Order" {\n` +
    `  command Cancel Order { orderId: UUID } note "slices/cancel-order.md"\n` +
    `  event Order Cancelled { orderId: UUID } public\n` +
    `}\n\n` +
    `arrow Order List -> Cancel Order\n`
  );
}

const frontmatter = (pattern: string) =>
  `---\nschemaVersion: 1\npattern: ${pattern}\nswimlane: Orders\nstatus: implemented\nversion: 1\nimplementedIn: https://example.invalid/pr/1\n` +
  `ratifiedBy: Ada\nratifiedOn: 2026-10-01\n---\n`;

export const PLACE_ORDER_DOC =
  frontmatter("state-change") +
  `# Slice: Place Order\n\n` +
  `## Invariants / Business Rules\n` +
  `- INV-ORD-1 — a zero-total cart is rejected before payment is attempted\n\n` +
  `## Scenarios (Given / When / Then)\n` +
  `- Duplicate submit (INV-ORD-2)\n`;

export const CANCEL_ORDER_DOC =
  frontmatter("state-change") +
  `# Slice: Cancel Order\n\n` +
  `## Invariants / Business Rules\n` +
  `- **INV-1:** A shipped order cannot be cancelled\n` +
  `- Relies on INV-ORD-1 having held when the order was placed\n`;

/** Write the fixture into `dir` (model at `dir/model.em`, docs under `dir/slices/`, a test tree
 *  under `dir/tests/` citing INV-ORD-1 and INV-1 but not INV-ORD-2). */
export function writeInvariantFixture(dir: string, withGrammar: boolean): void {
  mkdirSync(join(dir, "slices"), { recursive: true });
  mkdirSync(join(dir, "tests"), { recursive: true });
  writeFileSync(join(dir, "model.em"), invariantFixtureModel(withGrammar));
  writeFileSync(join(dir, "slices", "place-order.md"), PLACE_ORDER_DOC);
  writeFileSync(join(dir, "slices", "cancel-order.md"), CANCEL_ORDER_DOC);
  writeFileSync(join(dir, "tests", "orders.test.ts"), `// INV-ORD-1 holds\n// INV-1 holds\n`);
}
