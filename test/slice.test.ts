// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newSlice } from "../src/slice/generate.js";
import { syncSlice, syncAll } from "../src/slice/sync.js";
import { listSlices, searchSlices, showSlice, updateSlice } from "../src/slice/query.js";
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
