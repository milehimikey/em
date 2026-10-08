// SPDX-License-Identifier: MIT
// Shared multi-model git fixture (MIL-235): a throwaway git repository holding a copy of
// `examples/multi-model/` (two models + system.yaml), committed, with a repo-local identity so
// `em upgrade --apply`-style commits work on a CI runner with no global git config. Reused by
// the 1.14.0 seam tickets (system, upgrade, codeowners, scope, consumer-adaptation tests) so
// each one doesn't re-roll its own `git init` + copy + commit.
//
//   const repo = makeMultiModelRepo();             // the example as shipped (manifest 2.0)
//   const old = makeMultiModelRepo({ legacy: true }); // the pre-MIL-235 shape (manifest 1.0)
//   repo.git("log", "--format=%s");                // run git in the repo, stdout returned
//   repo.cleanup();                                // rm -rf (call from afterEach/afterAll)

import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MULTI_MODEL_EXAMPLE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "examples", "multi-model");

/** The example's `system.yaml` before MIL-235: schema 1.0 with `seams:` and per-model `owner:`. */
export const LEGACY_MULTI_MODEL_MANIFEST = `# Seam manifest (MIL-194) — the cross-model bindings \`em system\` verifies.
systemSchemaVersion: "1.0"
name: Multi-model example
models:
  checkout:
    source: models/checkout/checkout.em
    owner: Storefront team
  fulfillment:
    source: models/fulfillment/fulfillment.em
    owner: Warehouse team
seams:
  - from: checkout:checkout/event.order-submitted
    to: fulfillment:receive-order/translation.order-intake
    description: A submitted order is handed to the warehouse to be fulfilled.
`;

/** The example's two models before MIL-235: no `owner` on the headers, no `consumes` (field
 *  blocks and `public` on `Accept Order` as shipped since MIL-237, and MIL-265's `invariant` lines
 *  and `public` on `Submit Order`, and MIL-266's `note "slices/checkout.md"` binding — those are not
 *  migrated; the translation's `note` is left out because the migration appends `consumes` at
 *  the end of that line). */
export const LEGACY_CHECKOUT_EM = `model "Checkout"

persona Customer

context Order

slice "Checkout" {
  ui Checkout Screen @Customer
  command Submit Order public note "slices/checkout.md" {
    total: decimal
    note?: text
  }
  invariant INV-CHK-1 "An order is submitted with a positive total"
  event Order Submitted @Order public {
    orderId: uuid assigned
    total: decimal
    placedAt: datetime assigned
    note?: text
  }
}

slice "Order Confirmation" {
  view Order Confirmation from "Order Submitted"
  ui Confirmation Screen @Customer
}

slice "Cancel Order" {
  ui Order Details @Customer
  command Cancel Order
  invariant INV-CXL-1 "Only an order that has not shipped can be cancelled"
  event Order Cancelled @Order public
}
`;

export const LEGACY_FULFILLMENT_EM = `model "Fulfillment"

persona Warehouse

context Order

slice "Receive Order" {
  translation Order Intake {
    orderId: uuid
    total: decimal
  }
  command Accept Order public {
    orderId: uuid
    total: decimal
  }
  invariant INV-FUL-1 "An order is accepted at most once per checkout order id"
  event Order Accepted @Order {
    orderId: uuid
    total: decimal
    acceptedAt: datetime assigned
  }
}

slice "Orders To Fulfil" {
  view Orders To Fulfil from "Order Accepted"
  ui Fulfilment Board @Warehouse
}

slice "Checkout" {
  ui Return Screen @Warehouse
  command Process Return
  event Return Processed @Order
}

slice "Return Confirmation" {
  view Return Confirmation from "Return Processed"
  ui Confirmation Screen @Warehouse
}
`;

export interface MultiModelRepo {
  /** The repo root (a fresh tmp dir). */
  dir: string;
  manifest: string;
  checkout: string;
  fulfillment: string;
  /** `git -C dir <args>` with the fixture identity; throws on a non-zero exit, returns stdout. */
  git(...args: string[]): string;
  cleanup(): void;
}

export interface MultiModelRepoOptions {
  /** Write the pre-MIL-235 shape (1.0 manifest, no owner/consumes in the models). */
  legacy?: boolean;
  /** Leave `system.yaml` out entirely (discovery tests). Default: included. */
  manifest?: boolean;
}

export function makeMultiModelRepo(opts: MultiModelRepoOptions = {}): MultiModelRepo {
  const dir = mkdtempSync(join(tmpdir(), "em-multi-model-"));
  cpSync(MULTI_MODEL_EXAMPLE_DIR, dir, { recursive: true });
  const manifest = join(dir, "system.yaml");
  const checkout = join(dir, "models", "checkout", "checkout.em");
  const fulfillment = join(dir, "models", "fulfillment", "fulfillment.em");
  if (opts.legacy) {
    writeFileSync(manifest, LEGACY_MULTI_MODEL_MANIFEST);
    writeFileSync(checkout, LEGACY_CHECKOUT_EM);
    writeFileSync(fulfillment, LEGACY_FULFILLMENT_EM);
  }
  if (opts.manifest === false) rmSync(manifest);

  const git = (...args: string[]): string => {
    const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  };
  git("init", "-q");
  git("config", "user.email", "t@t.test");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { dir, manifest, checkout, fulfillment, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
