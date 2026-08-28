// SPDX-License-Identifier: MIT
// Coverage for `em slice new --wire` (src/cli/sliceLink.ts, MIL-161): the line-span locator, the
// pure note-clause insertion, primary-element resolution per pattern, and the full wire
// operation over a compiled model. CLI-level exit-code/process coverage (the --wire flag itself,
// writing the file, the printed confirmation) lives in test/cli.test.ts.
import { describe, it, expect } from "vitest";
import { compile } from "../src/pipeline.js";
import { findLineSpan, insertNoteClause, resolvePrimaryElement, wireSliceNote } from "../src/cli/sliceLink.js";

describe("findLineSpan", () => {
  it("finds a middle line's span, excluding its own LF terminator", () => {
    const source = "line1\nline2\nline3\n";
    const span = findLineSpan(source, 2);
    expect(span).toEqual({ start: 6, end: 11 });
    expect(source.slice(span!.start, span!.end)).toBe("line2");
  });

  it("excludes a trailing \\r on a CRLF line", () => {
    const source = "line1\r\nline2\r\nline3\r\n";
    const span = findLineSpan(source, 2);
    expect(source.slice(span!.start, span!.end)).toBe("line2");
  });

  it("finds the last line even with no trailing newline", () => {
    const source = "line1\nline2";
    const span = findLineSpan(source, 2);
    expect(source.slice(span!.start, span!.end)).toBe("line2");
  });

  it("returns null past the end of the file", () => {
    expect(findLineSpan("line1\nline2\n", 5)).toBeNull();
  });
});

describe("insertNoteClause", () => {
  it("appends to a bare element line with no braces", () => {
    const result = insertNoteClause('  processor Payment Gateway from "Payments To Process"', "slices/x.md");
    expect(result).toEqual({
      ok: true,
      content: '  processor Payment Gateway from "Payments To Process" note "slices/x.md"',
    });
  });

  it("inserts before an opening brace on a multi-line field block's header line", () => {
    const result = insertNoteClause("  command Place Order {", "slices/x.md");
    expect(result).toEqual({ ok: true, content: '  command Place Order note "slices/x.md" {' });
  });

  it("preserves inline field text that trails the opening brace on the same line", () => {
    const result = insertNoteClause("  command Place Order { customerId", "slices/x.md");
    expect(result).toEqual({ ok: true, content: '  command Place Order note "slices/x.md" { customerId' });
  });

  it("appends after a fully inline, already-closed field block", () => {
    const result = insertNoteClause("  command Place Order { customerId, total: Money }", "slices/x.md");
    expect(result).toEqual({
      ok: true,
      content: '  command Place Order { customerId, total: Money } note "slices/x.md"',
    });
  });

  it("inserts before the brace even after a leading @Tag", () => {
    const result = insertNoteClause("  event Order Placed @Order {", "slices/x.md");
    expect(result).toEqual({ ok: true, content: '  event Order Placed @Order note "slices/x.md" {' });
  });

  it("never mistakes a brace inside a quoted clause for a block opener (MIL-122)", () => {
    const result = insertNoteClause('  event Widget Updated issue "PUT /widgets/{id}"', "slices/x.md");
    expect(result).toEqual({
      ok: true,
      content: '  event Widget Updated issue "PUT /widgets/{id}" note "slices/x.md"',
    });
  });

  it("preserves a trailing # comment, inserting the clause before it", () => {
    const result = insertNoteClause('  processor Payment Gateway from "Payments To Process"  # legacy', "slices/x.md");
    expect(result).toEqual({
      ok: true,
      content: '  processor Payment Gateway from "Payments To Process" note "slices/x.md" # legacy',
    });
  });

  it("refuses a line that already has a note clause, without mutating it", () => {
    const result = insertNoteClause('  command Do Thing note "slices/existing.md"', "slices/x.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("already has a `note` clause");
  });

  it("doesn't false-positive on an element name that merely contains 'note' as a substring", () => {
    const result = insertNoteClause("  command Denote Preference", "slices/x.md");
    expect(result.ok).toBe(true);
  });
});

describe("resolvePrimaryElement", () => {
  const source = [
    'slice "Checkout" {',
    "  ui Checkout Screen",
    "  command Submit Payment",
    "  event Payment Requested",
    "}",
    'slice "Manager Review" {',
    '  view Pending Payments from "Payment Requested"',
    "  ui Payment Dashboard",
    "}",
    'slice "Capture Payment" {',
    '  processor Payment Gateway from "Pending Payments"',
    "  command Capture Payment",
    "  event Payment Captured",
    "}",
    'slice "Ambiguous" {',
    "  command First Command",
    "  command Second Command",
    "  event Something Happened",
    "}",
  ].join("\n");

  it("resolves the command for a state-change slice", () => {
    const { model, refs } = compile(source);
    const result = resolvePrimaryElement(model, refs, "checkout", "state-change");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.element.kind).toBe("command");
    expect(result.element.name).toBe("Submit Payment");
  });

  it("resolves the view for a state-view slice", () => {
    const { model, refs } = compile(source);
    const result = resolvePrimaryElement(model, refs, "manager-review", "state-view");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.element.kind).toBe("view");
    expect(result.element.name).toBe("Pending Payments");
  });

  it("resolves the processor for an automation slice", () => {
    const { model, refs } = compile(source);
    const result = resolvePrimaryElement(model, refs, "capture-payment", "automation");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.element.kind).toBe("processor");
    expect(result.element.name).toBe("Payment Gateway");
  });

  it("errors clearly for a key that names no slice in the model", () => {
    const { model, refs } = compile(source);
    const result = resolvePrimaryElement(model, refs, "no-such-key", "state-change");
    expect(result).toEqual({ ok: false, message: 'no slice with export key "no-such-key" in this model' });
  });

  it("refuses when the slice has no element of the primary kind", () => {
    const { model, refs } = compile(source);
    const result = resolvePrimaryElement(model, refs, "checkout", "automation");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("has no processor/automation/saga element");
  });

  it("refuses when more than one element matches the primary kind", () => {
    const { model, refs } = compile(source);
    const result = resolvePrimaryElement(model, refs, "ambiguous", "state-change");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("2 command elements");
    expect(result.message).toContain("ambiguous");
  });
});

describe("wireSliceNote (full operation)", () => {
  it("inserts the note on the primary element's exact header line, leaving every other byte untouched", () => {
    const source = [
      'slice "Checkout" {',
      "  ui Checkout Screen",
      "  command Submit Payment",
      "  event Payment Requested",
      "}",
    ].join("\n");
    const { model, refs } = compile(source);
    const result = wireSliceNote(source, model, refs, "checkout", "state-change", "slices/checkout.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sliceName).toBe("Checkout");
    expect(result.elementName).toBe("Submit Payment");
    expect(result.content).toBe(
      [
        'slice "Checkout" {',
        "  ui Checkout Screen",
        '  command Submit Payment note "slices/checkout.md"',
        "  event Payment Requested",
        "}",
      ].join("\n"),
    );
    // Re-compiling the wired output must still parse cleanly and carry the note through.
    const recompiled = compile(result.content);
    const command = recompiled.model.slices[0].elements.find((el) => el.kind === "command")!;
    expect(command.note).toBe("slices/checkout.md");
  });

  it("propagates a resolve failure without touching the source", () => {
    const source = 'slice "Checkout" {\n  ui Checkout Screen\n  command Submit Payment\n}\n';
    const { model, refs } = compile(source);
    const result = wireSliceNote(source, model, refs, "no-such-key", "state-change", "slices/checkout.md");
    expect(result).toEqual({ ok: false, message: 'no slice with export key "no-such-key" in this model' });
  });
});
