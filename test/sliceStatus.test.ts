// SPDX-License-Identifier: MIT
// Coverage for src/render/sliceStatus.ts: doc lookup follows the exact same
// deduped-key convention as em catalog (src/catalog/build.ts), so two features
// reading the "same" slices/<key>.md never disagree about which slice owns it.
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../src/parser/parser.js";
import { normalize } from "../src/model/model.js";
import { readSliceStatuses } from "../src/render/sliceStatus.js";

function withTmpDir(fn: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "em-slicestatus-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("readSliceStatuses", () => {
  it("returns null for every slice when there's no slices/ dir at all", () => {
    withTmpDir((dir) => {
      const model = normalize(
        parse(`
slice "Place Order" {
  command Place Order
}
`),
      );
      expect(readSliceStatuses(model, dir)).toEqual([null]);
    });
  });

  it("reads each slice's Status from its kebab-slug doc, aligned by slice index", () => {
    withTmpDir((dir) => {
      const model = normalize(
        parse(`
slice "Place Order" {
  command Place Order
}
slice "Ship Order" {
  command Ship Order
}
slice "Refund Order" {
  command Refund Order
}
`),
      );
      mkdirSync(join(dir, "slices"), { recursive: true });
      writeFileSync(join(dir, "slices", "place-order.md"), "- **Status:** Reviewed\n");
      writeFileSync(join(dir, "slices", "ship-order.md"), "# Ship Order\n\nno status line here.\n");
      // no doc at all for "Refund Order"

      expect(readSliceStatuses(model, dir)).toEqual(["reviewed", null, null]);
    });
  });

  it("resolves a duplicate slice name's status doc the same way em catalog resolves its doc: only the first gets the plain key", () => {
    withTmpDir((dir) => {
      const model = normalize(
        parse(`
slice "Ship Order" {
  command Ship Order
}
slice "Ship Order" {
  command Reship Order
}
`),
      );
      mkdirSync(join(dir, "slices"), { recursive: true });
      writeFileSync(join(dir, "slices", "ship-order.md"), "- **Status:** Implemented\n");
      // no "ship-order~2.md" authored

      expect(readSliceStatuses(model, dir)).toEqual(["implemented", null]);
    });
  });
});
