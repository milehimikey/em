// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newSlice } from "../src/slice/generate.js";
import { syncSlice, syncAll } from "../src/slice/sync.js";
import {
  listSliceRecords,
  listSlices,
  searchSliceRecords,
  searchSlices,
  showSlice,
  updateSlice,
} from "../src/slice/query.js";
import { mergeFrontmatter, parseFrontmatter, stringifyFrontmatter } from "../src/model/frontmatter.js";

const MODEL = `model "Demo"
persona Customer
context Order

slice "Place Order" {
  ui Product Catalog @Customer
  command Place Order
  event Order Placed @Order
}
`;

describe("em slice new / sync / list / show / search / update", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-slice-cli-"));
    writeFileSync(join(dir, "demo.em"), MODEL);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("scaffolds a doc with frontmatter but no sliceElement yet", () => {
    const result = newSlice("Place Order", { dir });
    expect(result.id).toBe("place-order");

    const raw = readFileSync(result.path, "utf8");
    const { data } = parseFrontmatter(raw);
    expect(data).toMatchObject({
      schemaVersion: 1,
      id: "place-order",
      title: "Place Order",
      pattern: "state-change",
      status: "draft",
      version: 1,
      model: "../demo.em",
    });
    expect(data!.sliceElement).toBeUndefined();
  });

  it("dedupes ids on a name collision", () => {
    newSlice("Place Order", { dir });
    const second = newSlice("Place Order", { dir });
    expect(second.id).toBe("place-order-2");
  });

  it("refuses to overwrite without --force", () => {
    newSlice("Place Order", { dir });
    expect(() => newSlice("Place Order", { dir, id: "place-order" })).toThrow(/already used/);
  });

  it("sync discovers sliceElement from the .em's note back-reference and fills generated fields", () => {
    newSlice("Place Order", { dir });

    // Simulate the agent wiring `note "slices/place-order.md"` onto the command.
    const wired = MODEL.replace(
      "command Place Order",
      'command Place Order note "slices/place-order.md"',
    );
    writeFileSync(join(dir, "demo.em"), wired);

    const result = syncSlice("place-order", { dir });
    expect(result.changed).toBe(true);

    const raw = readFileSync(result.path, "utf8");
    const { data, body } = parseFrontmatter(raw);
    expect(data).toMatchObject({
      sliceElement: "place_order",
      commands: ["Place Order"],
      events: ["Order Placed"],
      readModels: [],
      contexts: ["Order"],
      personas: ["Customer"],
    });
    // Body (the user's template content) is untouched by sync.
    expect(body).toContain("# Slice: Place Order");

    // Re-syncing with no .em change reports no change.
    expect(syncSlice("place-order", { dir }).changed).toBe(false);
  });

  it("substitutes every {{Slice Name}} in a custom template, not just the first", () => {
    writeFileSync(
      join(dir, "body.md"),
      "# {{Slice Name}}\n\nOverview of {{Slice Name}} goes here.\n",
    );
    writeFileSync(join(dir, "em.config.json"), JSON.stringify({ sliceTemplate: "body.md" }));

    const result = newSlice("Place Order", { dir });
    const { body } = parseFrontmatter(readFileSync(result.path, "utf8"));
    expect(body).toBe("# Place Order\n\nOverview of Place Order goes here.\n");
  });

  it("reports a missing custom template by path instead of a raw ENOENT", () => {
    writeFileSync(join(dir, "em.config.json"), JSON.stringify({ sliceTemplate: "nope.md" }));
    expect(() => newSlice("Place Order", { dir })).toThrow(/slice template not found/);
  });

  it("rejects a non-string sliceTemplate rather than throwing from path.resolve", () => {
    writeFileSync(join(dir, "em.config.json"), JSON.stringify({ sliceTemplate: 42 }));
    expect(() => newSlice("Place Order", { dir })).toThrow(/`sliceTemplate` must be a string path/);
  });

  it("rejects an explicit --model path that doesn't exist instead of writing it to frontmatter", () => {
    expect(() => newSlice("Place Order", { dir, modelPath: join(dir, "missing.em") })).toThrow(
      /model file not found/,
    );
  });

  it("syncAll syncs every wired doc and skips unwired ones", () => {
    newSlice("Place Order", { dir });
    const wired = MODEL.replace(
      "command Place Order",
      'command Place Order note "slices/place-order.md"',
    );
    writeFileSync(join(dir, "demo.em"), wired);

    const { synced, skipped } = syncAll({ dir });
    expect(synced.map((s) => s.id)).toEqual(["place-order"]);
    expect(skipped).toEqual([]);
  });

  it("syncAll resolves triggers/triggeredBy between two docs neither of which has a sliceElement yet", () => {
    // Both docs are freshly scaffolded, so each one's sliceElement can only be
    // discovered from the .em's `note`. The automation's `triggers` points at the
    // command doc and vice versa, which only resolves if sliceElement discovery
    // happens for every doc before any single doc's fields are derived.
    const em = `model "Payments"
persona Customer
context Payment

slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
  processor Payment Gateway note "slices/payments-to-process.md"
}

slice "Capture Payment" {
  command Capture Payment note "slices/capture-payment.md"
  event Payment Captured @Payment
}
`;
    const d = mkdtempSync(join(tmpdir(), "em-sync-order-"));
    try {
      writeFileSync(join(d, "payments.em"), em);
      newSlice("Payments To Process", { dir: d, pattern: "automation" });
      newSlice("Capture Payment", { dir: d });

      const { synced, skipped } = syncAll({ dir: d });
      expect(skipped).toEqual([]);
      expect(synced.map((s) => s.id).sort()).toEqual(["capture-payment", "payments-to-process"]);

      const automation = parseFrontmatter(
        readFileSync(join(d, "slices", "payments-to-process.md"), "utf8"),
      ).data;
      const command = parseFrontmatter(
        readFileSync(join(d, "slices", "capture-payment.md"), "utf8"),
      ).data;

      expect(automation!.triggers).toBe("capture-payment");
      expect(command!.triggeredBy).toBe("payments-to-process");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("list/show/search read frontmatter and reflect status/version updates", () => {
    newSlice("Place Order", { dir });
    const wired = MODEL.replace(
      "command Place Order",
      'command Place Order note "slices/place-order.md"',
    );
    writeFileSync(join(dir, "demo.em"), wired);
    syncSlice("place-order", { dir });

    expect(listSlices({ dir })).toEqual([
      { id: "place-order", title: "Place Order", pattern: "state-change", status: "draft", version: 1, file: "place-order.md" },
    ]);

    expect(searchSlices("", { dir, pattern: "state-change", context: "Order" })).toHaveLength(1);
    expect(searchSlices("", { dir, context: "Payment" })).toHaveLength(0);
    expect(searchSlices("place order", { dir })).toHaveLength(1);
    expect(searchSlices("nonexistent", { dir })).toHaveLength(0);

    const shown = showSlice("place-order", { dir });
    expect(shown?.frontmatter?.commands).toEqual(["Place Order"]);

    const updated = updateSlice("place-order", { dir, status: "reviewed", bumpVersion: true });
    const { data } = parseFrontmatter(readFileSync(updated.path, "utf8"));
    expect(data).toMatchObject({ status: "reviewed", version: 2 });

    expect(listSlices({ dir, status: "reviewed" })).toHaveLength(1);
    expect(listSlices({ dir, status: "draft" })).toHaveLength(0);
  });

  it("list/search --full return every frontmatter field, including ones em doesn't know", () => {
    newSlice("Place Order", { dir });
    const wired = MODEL.replace(
      "command Place Order",
      'command Place Order note "slices/place-order.md"',
    );
    writeFileSync(join(dir, "demo.em"), wired);
    syncSlice("place-order", { dir });

    // Hand-author an em-known optional field and one em has never heard of.
    const path = join(dir, "slices", "place-order.md");
    const { document, body } = parseFrontmatter(readFileSync(path, "utf8"));
    mergeFrontmatter(document!, { tags: ["core"], jira: "LEND-1" });
    writeFileSync(path, stringifyFrontmatter(document!, body));

    const [record] = listSliceRecords({ dir });
    expect(record).toMatchObject({
      id: "place-order",
      commands: ["Place Order"],
      events: ["Order Placed"],
      contexts: ["Order"],
      personas: ["Customer"],
      tags: ["core"],
      jira: "LEND-1",
      file: "place-order.md",
    });

    // Same selection semantics as the summary form, just a wider shape.
    expect(searchSliceRecords("", { dir, tag: "core" })).toEqual([record]);
    expect(searchSliceRecords("", { dir, tag: "nope" })).toEqual([]);
    expect(listSliceRecords({ dir }).map((r) => r.id)).toEqual(
      listSlices({ dir }).map((s) => s.id),
    );
  });

  it("list gained --context/--tag filtering from the unified select path", () => {
    newSlice("Place Order", { dir });
    const wired = MODEL.replace(
      "command Place Order",
      'command Place Order note "slices/place-order.md"',
    );
    writeFileSync(join(dir, "demo.em"), wired);
    syncSlice("place-order", { dir });

    expect(listSlices({ dir, context: "Order" }).map((s) => s.id)).toEqual(["place-order"]);
    expect(listSlices({ dir, context: "Billing" })).toEqual([]);
  });

  it("compliance: is reserved — never touched by sync/update, but findable via search", () => {
    newSlice("Place Order", { dir });
    const wired = MODEL.replace(
      "command Place Order",
      'command Place Order note "slices/place-order.md"',
    );
    writeFileSync(join(dir, "demo.em"), wired);
    syncSlice("place-order", { dir });

    // Simulate a human hand-adding a compliance block per the documented convention.
    const path = join(dir, "slices", "place-order.md");
    const beforeAdd = parseFrontmatter(readFileSync(path, "utf8"));
    mergeFrontmatter(beforeAdd.document!, {
      compliance: { frameworks: ["PCI-DSS", "SOX"], dataClassification: "restricted" },
    });
    writeFileSync(path, stringifyFrontmatter(beforeAdd.document!, beforeAdd.body));

    // A generated-field sync (e.g. after a later .em edit) must not touch it.
    syncSlice("place-order", { dir });
    const afterSync = parseFrontmatter(readFileSync(path, "utf8"));
    expect(afterSync.data!.compliance).toEqual({
      frameworks: ["PCI-DSS", "SOX"],
      dataClassification: "restricted",
    });

    // Neither must a status/version update.
    updateSlice("place-order", { dir, status: "reviewed", bumpVersion: true });
    const afterUpdate = parseFrontmatter(readFileSync(path, "utf8"));
    expect(afterUpdate.data!.compliance).toEqual({
      frameworks: ["PCI-DSS", "SOX"],
      dataClassification: "restricted",
    });
    expect(afterUpdate.data).toMatchObject({ status: "reviewed", version: 2 });

    // It's still searchable despite being unvalidated.
    expect(searchSlices("PCI-DSS", { dir })).toHaveLength(1);
    expect(searchSlices("HIPAA", { dir })).toHaveLength(0);
  });
});
