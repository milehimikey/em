// SPDX-License-Identifier: MIT
// Coverage for `em slice stub-all` (src/cli/sliceStubAll.ts, MIL-184): the pure swimlane
// derivation (`deriveStubSwimlane`), the pure status-escalation writer (`applyStubStatus`, which
// reuses review/ratify/mark-implemented's own frontmatter writers), and `runStubAll`'s per-slice
// decision tree over a mixed fixture model (undocumented slices needing a fresh stub, a
// continuation slice, an already-documented slice, a `binding-missing-file` slice, a
// `frontmatter-invalid` slice, an orphaned unbound file, and an unclassifiable slice).
// CLI-level exit-code/flag-validation coverage (--status enum, --by/--implemented-in
// requiredness, --dry-run) lives in test/cli.test.ts's `em slice stub-all` block, and `em slice
// new --stub` (the single-slice sibling) lives in that file's `em slice new` block.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/pipeline.js";
import { applyStubStatus, deriveStubSwimlane, runStubAll } from "../src/cli/sliceStubAll.js";

describe("deriveStubSwimlane (pure)", () => {
  function slice(dsl: string, name: string) {
    const { model } = compile(dsl);
    return model.slices.find((s) => s.name === name)!;
  }

  it("first ui's persona -> first event's context, in declaration order", () => {
    const dsl =
      'persona Customer\ncontext Order\nslice "Place Order" {\n  ui Order Screen @Customer\n' +
      "  command Place Order\n  event Order Placed @Order\n}\n";
    expect(deriveStubSwimlane(slice(dsl, "Place Order"))).toBe("Customer → Order");
  });

  it('falls back to "— → —" when the slice has no ui element', () => {
    const dsl = 'context Order\nslice "Cancel Order" {\n  command Cancel Order\n  event Order Cancelled @Order\n}\n';
    expect(deriveStubSwimlane(slice(dsl, "Cancel Order"))).toBe("— → —");
  });

  it('falls back to "— → —" when the slice has no event element (e.g. a bare view)', () => {
    const dsl =
      'context Order\nslice "Upstream" {\n  command Place Order\n  event Order Placed @Order\n}\n' +
      'slice "View Orders" {\n  view Order List from "Order Placed"\n}\n';
    expect(deriveStubSwimlane(slice(dsl, "View Orders"))).toBe("— → —");
  });
});

const DRAFT_STUB =
  "---\nschemaVersion: 1\npattern: state-change\nswimlane: Customer → Order\nstatus: draft\nversion: 1\n---\n" +
  "# Slice: Place Order\n\n_Stub — deepen with the slice phase (see slice-doc-schema.md)._\n";

describe("applyStubStatus (pure)", () => {
  it("returns the draft content byte-identical when status is draft", () => {
    const result = applyStubStatus(DRAFT_STUB, "place-order", "draft", "", "2026-09-08", null);
    expect(result).toEqual({ ok: true, content: DRAFT_STUB });
  });

  it("writes reviewedBy/reviewedOn and flips status to reviewed", () => {
    const result = applyStubStatus(DRAFT_STUB, "place-order", "reviewed", "Sam Okafor", "2026-09-08", null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("status: reviewed");
    expect(result.content).toContain("reviewedBy: Sam Okafor");
    expect(result.content).toContain("reviewedOn: 2026-09-08");
    expect(result.content).not.toContain("ratifiedBy");
  });

  it("writes both reviewedBy/On and ratifiedBy/On, flipping status to ready-to-implement", () => {
    const result = applyStubStatus(DRAFT_STUB, "place-order", "ready-to-implement", "Alex Rivera", "2026-09-08", null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("status: ready-to-implement");
    expect(result.content).toContain("reviewedBy: Alex Rivera");
    expect(result.content).toContain("ratifiedBy: Alex Rivera");
    expect(result.content).toContain("reviewedOn: 2026-09-08");
    expect(result.content).toContain("ratifiedOn: 2026-09-08");
  });

  it("writes review + ratify + implementedIn, flipping status to implemented", () => {
    const result = applyStubStatus(
      DRAFT_STUB,
      "place-order",
      "implemented",
      "Jordan Lee",
      "2026-09-08",
      "https://github.com/org/repo/pull/42",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.content).toContain("status: implemented");
    expect(result.content).toContain("implementedIn: https://github.com/org/repo/pull/42");
    expect(result.content).toContain("ratifiedBy: Jordan Lee");
  });

  it("refuses --status implemented with no implementedInUrl", () => {
    const result = applyStubStatus(DRAFT_STUB, "place-order", "implemented", "Jordan Lee", "2026-09-08", null);
    expect(result).toEqual({
      ok: false,
      message: "--implemented-in <url> is required for --status implemented",
    });
  });

  it("propagates a blank reviewer name refusal from the review writer", () => {
    const result = applyStubStatus(DRAFT_STUB, "place-order", "reviewed", "  ", "2026-09-08", null);
    expect(result).toEqual({ ok: false, message: "a reviewer name is required (--by)" });
  });
});

// Mixed fixture: one slice per branch of runStubAll's decision tree (see module header).
const FIXTURE = `model "Stub Fixture"

persona Customer
context Order

slice "Place Order" {
  ui Order Screen @Customer
  command Place Order
  event Order Placed @Order
}
slice "Cancel Order" {
  command Cancel Order
  event Order Cancelled @Order
}
slice "View Orders" {
  view Order List from "Order Placed" note "slices/view-orders.md"
}
slice "View Orders Later" {
  view Order List again from "Order Cancelled"
}
slice "Ghost Slice" {
  command Ghost Thing note "slices/ghost-slice.md"
  event Ghost Thing Done @Order
}
slice "Broken Doc Slice" {
  command Broken Thing note "slices/broken-doc-slice.md"
  event Broken Thing Done @Order
}
slice "Orphan Slice" {
  command Orphan Thing
  event Orphan Thing Done @Order
}
slice "Lonely Screen" {
  ui Lonely Screen @Customer
}
`;

const VIEW_ORDERS_DOC =
  "---\nschemaVersion: 1\npattern: state-view\nswimlane: order\nstatus: draft\nversion: 1\n---\nbody\n";

describe("runStubAll (fs orchestration over a mixed model)", () => {
  // A fresh directory per test (not beforeAll/afterAll): runStubAll writes real stub files to
  // disk, and several scenarios below re-plan the SAME fixture under different --status/--dry-run
  // options — sharing one directory across tests would let one test's writes change what the
  // next test's `no-doc-bound` vs. "file already exists" branch resolves to.
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-slice-stub-all-"));
    mkdirSync(join(dir, "slices"), { recursive: true });
    writeFileSync(join(dir, "model.em"), FIXTURE);
    writeFileSync(join(dir, "slices", "view-orders.md"), VIEW_ORDERS_DOC);
    // ghost-slice.md deliberately absent — "Ghost Slice" notes it but the file doesn't exist.
    writeFileSync(join(dir, "slices", "broken-doc-slice.md"), "# No Frontmatter\n\nbody\n");
    // orphan-slice.md exists on disk but nothing in the .em notes it.
    writeFileSync(join(dir, "slices", "orphan-slice.md"), "hand-written, not wired, must survive untouched\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function plan(status: "draft" | "reviewed" | "ready-to-implement" | "implemented" = "draft", dryRun = false) {
    const { model, refs } = compile(readFileSync(join(dir, "model.em"), "utf8"));
    const source = readFileSync(join(dir, "model.em"), "utf8");
    return runStubAll(model, refs, dir, source, {
      status,
      by: status === "draft" ? null : "Alex Rivera",
      on: "2026-09-08",
      implementedInUrl: status === "implemented" ? "https://github.com/org/repo/pull/1" : null,
      dryRun,
    });
  }

  it("stubs and wires every genuinely undocumented, classifiable slice", () => {
    const result = plan();
    const stubbed = result.outcomes.filter((o) => o.kind === "stubbed").map((o) => o.sliceKey);
    expect(stubbed.sort()).toEqual(["cancel-order", "ghost-slice", "place-order"]);

    const placeOrder = result.outcomes.find((o) => o.sliceKey === "place-order");
    expect(placeOrder).toMatchObject({
      kind: "stubbed",
      path: "slices/place-order.md",
      pattern: "state-change",
      swimlane: "Customer → Order",
      status: "draft",
      wired: true,
      elementName: "Place Order",
    });

    const cancelOrder = result.outcomes.find((o) => o.sliceKey === "cancel-order");
    expect(cancelOrder).toMatchObject({ swimlane: "— → —", wired: true });

    // Ghost Slice already carries a note pointing at slices/ghost-slice.md — the file itself is
    // just missing, so it's stubbed WITHOUT re-wiring (there's nothing left to wire).
    const ghost = result.outcomes.find((o) => o.sliceKey === "ghost-slice");
    expect(ghost).toMatchObject({ wired: false, elementName: null });

    expect(readFileSync(join(dir, "slices", "place-order.md"), "utf8")).toContain("pattern: state-change");
    expect(readFileSync(join(dir, "slices", "cancel-order.md"), "utf8")).toContain("swimlane: — → —");
    expect(readFileSync(join(dir, "slices", "ghost-slice.md"), "utf8")).toContain("pattern: state-change");

    // .em source got the note wired onto Place Order/Cancel Order's own command lines.
    expect(result.source).toContain('command Place Order note "slices/place-order.md"');
    expect(result.source).toContain('command Cancel Order note "slices/cancel-order.md"');
    // Ghost Slice's pre-existing note is untouched, not duplicated.
    expect(result.source.match(/note "slices\/ghost-slice\.md"/g)?.length).toBe(1);

    // The orphaned file on disk was never touched.
    expect(readFileSync(join(dir, "slices", "orphan-slice.md"), "utf8")).toBe(
      "hand-written, not wired, must survive untouched\n",
    );
  });

  it("skips a continuation slice, naming the originating slice (MIL-208)", () => {
    const result = plan();
    const outcome = result.outcomes.find((o) => o.sliceKey === "view-orders-later");
    expect(outcome).toEqual({
      kind: "skip",
      sliceKey: "view-orders-later",
      reason: 'continuation of "view-orders" (view again, MIL-208) — no doc of its own',
    });
  });

  it("skips an already-documented slice", () => {
    const result = plan();
    expect(result.outcomes.find((o) => o.sliceKey === "view-orders")).toEqual({
      kind: "skip",
      sliceKey: "view-orders",
      reason: "already documented (slices/view-orders.md)",
    });
  });

  it("skips a slice with invalid frontmatter rather than overwriting it", () => {
    const result = plan();
    expect(result.outcomes.find((o) => o.sliceKey === "broken-doc-slice")).toEqual({
      kind: "skip",
      sliceKey: "broken-doc-slice",
      reason: "slices/broken-doc-slice.md exists but its frontmatter is invalid — fix it by hand (see em validate)",
    });
  });

  it("skips an unbound slice whose canonical path already holds an orphaned file", () => {
    const result = plan();
    expect(result.outcomes.find((o) => o.sliceKey === "orphan-slice")).toEqual({
      kind: "skip",
      sliceKey: "orphan-slice",
      reason: "slices/orphan-slice.md already exists but isn't wired — bind or remove it by hand",
    });
  });

  it("skips an unclassifiable slice (no command/event/view/processor/translation)", () => {
    const result = plan();
    expect(result.outcomes.find((o) => o.sliceKey === "lonely-screen")).toEqual({
      kind: "skip",
      sliceKey: "lonely-screen",
      reason: "pattern is unclassified — nothing to stub",
    });
  });

  it("--status ready-to-implement writes ratifiedBy/On (with --by) on every fresh stub", () => {
    const result = plan("ready-to-implement");
    const placeOrder = result.outcomes.find((o) => o.sliceKey === "place-order");
    expect(placeOrder).toMatchObject({ status: "ready-to-implement" });
    const written = readFileSync(join(dir, "slices", "place-order.md"), "utf8");
    expect(written).toContain("status: ready-to-implement");
    expect(written).toContain("ratifiedBy: Alex Rivera");
    expect(written).toContain("ratifiedOn: 2026-09-08");
  });

  it("--dry-run reports the same outcomes but writes nothing at all", () => {
    const before = readFileSync(join(dir, "model.em"), "utf8");
    const result = plan("draft", true);
    const stubbed = result.outcomes.filter((o) => o.kind === "stubbed").map((o) => o.sliceKey);
    expect(stubbed.sort()).toEqual(["cancel-order", "ghost-slice", "place-order"]);
    // No stub files land on disk, the .em is untouched, and the returned source is byte-identical
    // to the input — dry-run never gives the caller anything to write.
    expect(existsSync(join(dir, "slices", "place-order.md"))).toBe(false);
    expect(existsSync(join(dir, "slices", "cancel-order.md"))).toBe(false);
    expect(existsSync(join(dir, "slices", "ghost-slice.md"))).toBe(false);
    expect(readFileSync(join(dir, "model.em"), "utf8")).toBe(before);
    expect(result.source).toBe(before);
  });
});
