// SPDX-License-Identifier: MIT
// MIL-268 fixtures for `em engagement` (goal-spec criterion 22). Invented, domain-neutral models
// — a tool-lending library and three unrelated lifecycles — written with their slice docs into
// a directory. Every model validates clean; docs are the minimum `--slice-ready` accepts
// (bound by `note`, frontmatter usable, Open Questions all checked, `ratifiedBy` recorded).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type DocState = "implemented" | "ready" | "draft";

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function docText(key: string, pattern: string, state: DocState): string {
  const status = state === "ready" ? "ready-to-implement" : state;
  const extra =
    state === "implemented"
      ? `ratifiedBy: Alex Rivera\nimplementedIn: https://example.test/pr/${key}\n`
      : state === "ready"
        ? "ratifiedBy: Alex Rivera\n"
        : "";
  return `---\nschemaVersion: 1\npattern: ${pattern}\nswimlane: lending\nstatus: ${status}\nversion: 1\n${extra}---\n# Slice: ${key}\n\n## Open Questions\n- [x] resolved\n`;
}

function writeDocs(dir: string, docs: Array<[string, string, DocState]>): void {
  mkdirSync(join(dir, "slices"), { recursive: true });
  for (const [key, pattern, state] of docs) writeFileSync(join(dir, "slices", `${key}.md`), docText(key, pattern, state));
}

/** A state-change slice: `ui` -> command -> event, doc bound on the command. */
function stateChange(name: string, eventName: string, context = "Lending"): string {
  const key = slug(name);
  return `slice "${name}" {\n  ui ${name} Screen @Member\n  command ${name} note "slices/${key}.md"\n  event ${eventName} @${context}\n}\n`;
}

/** A state-view slice: view from events, read by a screen, doc bound on the view. */
function stateView(name: string, from: string[]): string {
  const key = slug(name);
  return `slice "${name}" {\n  view ${name} from ${from.map((f) => `"${f}"`).join(", ")} note "slices/${key}.md"\n  ui ${name} Screen @Member\n}\n`;
}

export const LENDING_VIEW_COUNT = 18;
export const lendingViewKeys = Array.from({ length: LENDING_VIEW_COUNT }, (_, i) => `catalog-view-${i + 1}`);

/**
 * The lending-library fixture, shaped like a real "remaining work" engagement:
 * - foundation state changes `register-tool`, `lend-tool` (implemented — they impose nothing);
 * - 18 state views over the foundation events (`catalog-view-1` … `-18`);
 * - a to-do view `overdue-loans-to-notify` and the translation `send-overdue-notice` reading it,
 *   whose event `loops-to` the to-do view (the edge the plan must exclude);
 * - `loan-history`, a view over the notice event (one in-engagement upstream: level 2);
 * - held cases: `reservations` reads two unmerged in-engagement state changes (`reserve-tool`,
 *   `cancel-reservation`); `damage-reports` reads `report-damage`, which is ready but NOT in the
 *   engagement; `tool-ratings` is still a draft doc.
 */
export function writeLendingFixture(dir: string): { file: string } {
  mkdirSync(dir, { recursive: true });
  const parts = [
    `model "lending-fixture"\n\npersona Member\ncontext Lending\n\n`,
    stateChange("Register Tool", "Tool Registered"),
    stateChange("Lend Tool", "Tool Lent"),
    stateChange("Report Damage", "Damage Reported"),
    stateChange("Reserve Tool", "Tool Reserved"),
    stateChange("Cancel Reservation", "Reservation Cancelled"),
    ...lendingViewKeys.map((_, i) => stateView(`Catalog View ${i + 1}`, ["Tool Registered", "Tool Lent"])),
    `slice "Overdue Loans To Notify" {\n  view Overdue Loans To Notify from "Tool Lent" note "slices/overdue-loans-to-notify.md"\n}\n`,
    `slice "Send Overdue Notice" {\n  translation Overdue Notice Gateway from "Overdue Loans To Notify" note "slices/send-overdue-notice.md"\n  command Send Overdue Notice\n  event Overdue Notice Sent @Lending loops-to "Overdue Loans To Notify"\n}\n`,
    stateView("Loan History", ["Overdue Notice Sent"]),
    stateView("Reservations", ["Tool Reserved", "Reservation Cancelled"]),
    stateView("Damage Reports", ["Damage Reported"]),
    stateView("Tool Ratings", ["Tool Registered"]),
  ];
  const file = join(dir, "lending.em");
  writeFileSync(file, parts.join("\n"));
  writeDocs(dir, [
    ["register-tool", "state-change", "implemented"],
    ["lend-tool", "state-change", "implemented"],
    ["report-damage", "state-change", "ready"],
    ["reserve-tool", "state-change", "ready"],
    ["cancel-reservation", "state-change", "ready"],
    ...lendingViewKeys.map((k): [string, string, DocState] => [k, "state-view", "ready"]),
    ["overdue-loans-to-notify", "state-view", "ready"],
    ["send-overdue-notice", "translation", "ready"],
    ["loan-history", "state-view", "ready"],
    ["reservations", "state-view", "ready"],
    ["damage-reports", "state-view", "ready"],
    ["tool-ratings", "state-view", "draft"],
  ]);
  return { file };
}

/** Every lending slice the engagement takes (all but the two implemented foundations and
 *  `report-damage`, which stays outside so `damage-reports` is held on it). */
export const LENDING_ENGAGEMENT_KEYS = [
  "reserve-tool",
  "cancel-reservation",
  ...lendingViewKeys,
  "overdue-loans-to-notify",
  "send-overdue-notice",
  "loan-history",
  "reservations",
  "damage-reports",
  "tool-ratings",
];

/** Three lifecycles that share nothing (account, order, shipping): each a foundation state
 *  change (implemented) plus a view over it (ready). */
export function writeLifecyclesFixture(dir: string): { file: string } {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "lifecycles.em");
  writeFileSync(
    file,
    [
      `model "lifecycles-fixture"\n\npersona Member\ncontext Accounts\ncontext Orders\ncontext Shipping\n\n`,
      stateChange("Open Account", "Account Opened", "Accounts"),
      stateChange("Place Order", "Order Placed", "Orders"),
      stateChange("Ship Parcel", "Parcel Shipped", "Shipping"),
      stateView("Account List", ["Account Opened"]),
      stateView("Order List", ["Order Placed"]),
      stateView("Shipment List", ["Parcel Shipped"]),
    ].join("\n"),
  );
  writeDocs(dir, [
    ["open-account", "state-change", "implemented"],
    ["place-order", "state-change", "implemented"],
    ["ship-parcel", "state-change", "implemented"],
    ["account-list", "state-view", "ready"],
    ["order-list", "state-view", "ready"],
    ["shipment-list", "state-view", "ready"],
  ]);
  return { file };
}
