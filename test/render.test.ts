import { describe, it, expect } from "vitest";
import { noteHref } from "../src/render/render.js";

describe("noteHref", () => {
  it("is unchanged when the SVG sits beside the .em (note relative to both)", () => {
    expect(noteHref("notes/order-placed.md", "/proj/src", "/proj/src")).toBe(
      "notes/order-placed.md",
    );
  });

  it("rewrites relative to the output directory when they differ", () => {
    // .em + notes/ in /proj/src, SVG written to /proj/docs
    expect(noteHref("notes/order-placed.md", "/proj/src", "/proj/docs")).toBe(
      "../src/notes/order-placed.md",
    );
  });

  it("uses posix separators in the href", () => {
    const href = noteHref("a/b/note.md", "/proj/src", "/proj/out");
    expect(href).not.toContain("\\");
    expect(href).toBe("../src/a/b/note.md");
  });

  it("passes through URLs and absolute paths untouched", () => {
    expect(noteHref("https://wiki/x", "/a", "/b")).toBe("https://wiki/x");
    expect(noteHref("/abs/note.md", "/a", "/b")).toBe("/abs/note.md");
  });
});
