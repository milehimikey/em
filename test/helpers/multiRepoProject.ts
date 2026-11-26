// SPDX-License-Identifier: MIT
// GH #536 onward: a throwaway multi-repository project for tests — a model repository holding
// `system.yaml` and `shop/shop.em` with ratified slice docs, beside the code repositories the
// code map names. Same role test/helpers/multiModelRepo.ts plays for several models in one repo.

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitInitQuiet } from "./gitInitQuiet.js";

/** Four slices that exercise each way a slice divides across repositories:
 *  - `place-order`: State Change, `ui` (@Customer) + command + a `public` event;
 *  - `open-orders`: State View over that event, shown to @Staff;
 *  - `take-payment`: Automation — a processor reading `open-orders`, a command, a Payments event;
 *  - `cancel-order`: State Change with NO public element. */
export const SHOP_MODEL = `model "Shop"
slice "Place Order" {
  ui Checkout @Customer
  command Place Order note "slices/place-order.md"
  event Order Placed @Orders public
}
slice "Open Orders" {
  view Open Orders from "Order Placed" note "slices/open-orders.md"
  ui Order List @Staff
}
slice "Take Payment" {
  processor Charge Card from "Open Orders" note "slices/take-payment.md"
  command Take Payment
  event Payment Taken @Payments
}
slice "Cancel Order" {
  ui Cancel Button @Customer
  command Cancel Order note "slices/cancel-order.md"
  event Order Cancelled @Orders
}
`;

export const SHOP_SLICES: ReadonlyArray<readonly [key: string, pattern: string]> = [
  ["place-order", "state-change"],
  ["open-orders", "state-view"],
  ["take-payment", "automation"],
  ["cancel-order", "state-change"],
];

/** A slice doc `--slice-ready` accepts: bound, usable frontmatter, ratified, no open question. */
export function readyDoc(key: string, pattern: string): string {
  return `---\nschemaVersion: 1\npattern: ${pattern}\nswimlane: order\nstatus: ready-to-implement\nversion: 1\nratifiedBy: Alex Rivera\n---\n# Slice: ${key}\n\n## Open Questions\n- [x] resolved\n`;
}

export const SHOP_SYSTEM = (repos: readonly string[]): string =>
  `systemSchemaVersion: "2.1"\nname: Shop\nrepos:\n${repos.map((r) => `  ${r}: {remote: "git@github.com:acme/${r}.git"}\n`).join("")}models:\n  shop: {source: shop/shop.em}\n`;

export interface MultiRepoProject {
  /** The directory holding every repository, side by side. */
  base: string;
  modelRepo: string;
  /** `<modelRepo>/shop`. */
  modelDir: string;
  repoDir(id: string): string;
  /** Write (or replace) `shop/code-map.yaml`; `null` removes nothing — pass text. */
  setCodeMap(text: string): void;
}

/**
 * Create `<base>/model` (a git repository with `system.yaml`, `shop/shop.em` and ready slice
 * docs) and one empty git repository per id in `repos`, all siblings — so the repo resolver's
 * sibling fallback finds them with no configuration. Nothing is committed; a test that needs
 * history commits what it needs. Clean up with `rmTemp(project.base)`.
 */
export function createMultiRepoProject(repos: readonly string[], codeMap?: string): MultiRepoProject {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "em-multi-repo-")));
  const modelRepo = join(base, "model");
  const modelDir = join(modelRepo, "shop");
  for (const r of ["model", ...repos]) {
    mkdirSync(join(base, r), { recursive: true });
    gitInitQuiet(join(base, r), "-b", "main");
  }
  mkdirSync(join(modelDir, "slices"), { recursive: true });
  writeFileSync(join(modelRepo, "system.yaml"), SHOP_SYSTEM(repos));
  writeFileSync(join(modelDir, "shop.em"), SHOP_MODEL);
  for (const [key, pattern] of SHOP_SLICES) writeFileSync(join(modelDir, "slices", `${key}.md`), readyDoc(key, pattern));
  const setCodeMap = (text: string): void => writeFileSync(join(modelDir, "code-map.yaml"), text);
  if (codeMap !== undefined) setCodeMap(codeMap);
  return { base, modelRepo, modelDir, repoDir: (id) => join(base, id), setCodeMap };
}
