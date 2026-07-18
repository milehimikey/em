// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { newSlice } from "../src/slice/generate.js";
import { syncSlice, syncAll } from "../src/slice/sync.js";
import { listSlices, searchSlices, showSlice, updateSlice } from "../src/slice/query.js";
import { parseFrontmatter } from "../src/model/frontmatter.js";

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
});
