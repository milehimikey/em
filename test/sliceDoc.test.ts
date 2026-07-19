// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSliceDocs } from "../src/model/sliceDoc.js";

describe("loadSliceDocs", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-slicedoc-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns [] when there's no slices/ directory", () => {
    expect(loadSliceDocs(dir)).toEqual([]);
  });

  it("loads every .md file, parsing frontmatter where present", () => {
    const slicesDir = join(dir, "slices");
    mkdirSync(slicesDir);
    writeFileSync(
      join(slicesDir, "place-order.md"),
      "---\nid: place-order\nstatus: draft\n---\n# Slice: Place Order\n",
    );
    writeFileSync(join(slicesDir, "legacy.md"), "# Slice: Legacy\n\nNo frontmatter.\n");
    writeFileSync(join(slicesDir, "notes.txt"), "not a slice doc");

    const docs = loadSliceDocs(dir);
    expect(docs).toHaveLength(2);

    const placeOrder = docs.find((d) => d.file === "place-order.md")!;
    expect(placeOrder.frontmatter).toEqual({ id: "place-order", status: "draft" });
    expect(placeOrder.body).toBe("# Slice: Place Order\n");

    const legacy = docs.find((d) => d.file === "legacy.md")!;
    expect(legacy.frontmatter).toBeNull();
    expect(legacy.document).toBeNull();
  });
});
