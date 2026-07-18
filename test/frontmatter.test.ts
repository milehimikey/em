// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  stringifyFrontmatter,
  frontmatterFromData,
  mergeFrontmatter,
} from "../src/model/frontmatter.js";

describe("frontmatter", () => {
  it("parses a leading YAML block and splits off the body", () => {
    const raw = `---\nid: place-order\nversion: 2\n---\n# Slice: Place Order\n\nBody text.\n`;
    const { data, document, body } = parseFrontmatter(raw);
    expect(data).toEqual({ id: "place-order", version: 2 });
    expect(document).not.toBeNull();
    expect(body).toBe("# Slice: Place Order\n\nBody text.\n");
  });

  it("returns null data/document when there's no frontmatter block", () => {
    const raw = "# Slice: Place Order\n\nNo frontmatter here.\n";
    const { data, document, body } = parseFrontmatter(raw);
    expect(data).toBeNull();
    expect(document).toBeNull();
    expect(body).toBe(raw);
  });

  it("round-trips: parse -> stringify reproduces an equivalent block", () => {
    const raw = `---\nid: place-order\nstatus: draft\n---\nBody.\n`;
    const { data, document, body } = parseFrontmatter(raw);
    const out = stringifyFrontmatter(document!, body);
    const reparsed = parseFrontmatter(out);
    expect(reparsed.data).toEqual(data);
    expect(reparsed.body).toBe(body);
  });

  it("mergeFrontmatter preserves untouched and unknown fields", () => {
    const raw = `---\nid: place-order\ncustomField: keep-me\nstatus: draft\n---\nBody.\n`;
    const { document, body } = parseFrontmatter(raw);
    mergeFrontmatter(document!, { status: "reviewed", version: 3 });
    const out = stringifyFrontmatter(document!, body);
    const { data } = parseFrontmatter(out);
    expect(data).toEqual({
      id: "place-order",
      customField: "keep-me",
      status: "reviewed",
      version: 3,
    });
  });

  it("frontmatterFromData builds a Document that stringifies cleanly", () => {
    const doc = frontmatterFromData({ id: "place-order", version: 1 });
    const out = stringifyFrontmatter(doc, "Body.\n");
    const { data, body } = parseFrontmatter(out);
    expect(data).toEqual({ id: "place-order", version: 1 });
    expect(body).toBe("Body.\n");
  });
});
