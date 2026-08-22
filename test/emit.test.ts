// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { compile } from "../src/pipeline.js";
import { STARTER_EM } from "../src/templates.js";

describe("dot emitter", () => {
  it("emits the strict-grid scaffolding", () => {
    const { dot } = compile(STARTER_EM);
    // rigid grid uses heavily weighted invisible column chains
    expect(dot).toContain("weight=1000");
    expect(dot).toContain("style=invis");
    // each row is locked to one rank
    expect(dot).toContain("rank=same");
    expect(dot).toMatch(/digraph EventModel/);
  });

  it("emits no semantic arrows (the renderer draws them over the grid)", () => {
    const { dot } = compile(`
context Order
slice "A" {
  ui Catalog @Customer
  command Place Order
  event Order Placed @Order
}
`);
    // structural chains use `->` but are invisible/uncoloured; a semantic arrow
    // would be a coloured edge (`a -> b [color=…]`), which must not appear.
    expect(dot).not.toMatch(/->[^\n;]*\[color=/);
  });

  it("emits a UML-style HTML label for an element with fields", () => {
    const { dot } = compile(`
slice "S" {
  event Order Placed {
    orderId
    total: Money
  }
}
`);
    // HTML table with a divider rule, the title, and a typed field
    expect(dot).toContain("<TABLE");
    expect(dot).toContain("<HR/>");
    expect(dot).toContain("<B>Order Placed</B>");
    expect(dot).toContain("total : ");
    expect(dot).toMatch(/<FONT COLOR="#5F6368">Money<\/FONT>/);
    // field boxes auto-size (height grows), so they are not fixedsize
    expect(dot).toMatch(/order_placed \[label=<<TABLE[\s\S]*fixedsize=false/);
  });

  it("keeps fixed-size boxes for elements without fields", () => {
    const { dot } = compile(`slice "S" {\n  command Place Order\n}`);
    expect(dot).toMatch(/place_order \[label="Place Order"[^\]]*fixedsize=true/);
  });

  it("wraps a PascalCase name with no spaces onto multiple lines", () => {
    const { dot } = compile(
      `slice "S" {\n  command ThisIsAnExtremelyLongCommandNameThatShouldTestBoxWidthOverflowHandling\n}`,
    );
    const match = dot.match(/label="([^"]*)", fillcolor=/);
    expect(match).not.toBeNull();
    const lines = (match![1] as string).split("\\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(18);
  });

  it("splits camelCase acronyms at case transitions, not mid-acronym", () => {
    const { dot } = compile(`slice "S" {\n  command SyncHTTPServerConfigNow\n}`);
    const match = dot.match(/label="([^"]*)", fillcolor=/);
    const lines = (match![1] as string).split("\\n");
    expect(lines.join(" ")).toMatch(/HTTP/);
  });

  it("hard-chops a single unbroken run of characters as a last resort", () => {
    const long = "a".repeat(60);
    const { dot } = compile(`slice "S" {\n  command ${long}\n}`);
    const match = dot.match(/label="([^"]*)", fillcolor=/);
    const lines = (match![1] as string).split("\\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(18);
    expect(lines.join("")).toBe(long);
  });

  it("leaves normal multi-word wrapping unchanged", () => {
    const { dot } = compile(
      `slice "S" {\n  command Sync Smartphone Operating System Name\n}`,
    );
    expect(dot).toContain('label="Sync Smartphone\\nOperating System\\nName"');
  });

  it("MIL-26: stretches every no-fields box in a row to the row's tallest natural height", () => {
    const { dot } = compile(`
slice "A" {
  command ThisIsAnExtremelyLongCommandNameThatShouldWrapOntoThreeLines
}
slice "B" {
  command Short
}
`);
    const tall = /thisisanextremelylongcommandnamethatshouldwrapontothreelines \[[^\]]*height=([\d.]+)\]/.exec(
      dot,
    );
    const short = /\n\s*short \[[^\]]*height=([\d.]+)\]/.exec(dot);
    expect(tall).not.toBeNull();
    expect(short).not.toBeNull();
    // both commands share the same "API" row across the two slices — same height,
    // and taller than the single-line default (0.62), since the long name wraps.
    expect(short![1]).toBe(tall![1]);
    expect(Number(tall![1])).toBeGreaterThan(0.62);
  });

  it("MIL-26: stretches the row's empty-cell spacers to match, not just its real boxes", () => {
    const { dot } = compile(`
context Order
slice "A" {
  event ThisIsAnExtremelyLongEventNameThatShouldWrapOntoThreeLines @Order
}
slice "B" {
  command Placeholder Only
}
`);
    // slice B has no event, so its Order-row cell is an invisible placeholder — one
    // of possibly several placeholders in this model (e.g. slice A's own empty API
    // row); at least one (the Order-row one) must pick up the tall row's height
    // instead of the 0.62 default.
    const placeholders = [
      ...dot.matchAll(/__ph_\d+_\d+ \[label="", style=invis, fixedsize=true, width=2, height=([\d.]+)\]/g),
    ];
    expect(placeholders.length).toBeGreaterThan(0);
    expect(placeholders.some((m) => Number(m[1]) > 0.62)).toBe(true);
  });

  it("MIL-26: a fields-bearing box neither inherits nor inflates its row's uniform height", () => {
    // command and view share one lane (the API row) — a fields-bearing view in slice A
    // and a plain short command in slice B land in the same row across two columns.
    const { dot } = compile(`
slice "A" {
  view WithFields from "Something" { orderId }
}
slice "B" {
  command Short
}
`);
    // the fields-bearing view keeps auto-height, unaffected by anything in its row.
    expect(dot).toMatch(/withfields \[label=<<TABLE[\s\S]*?fixedsize=false/);
    // the plain command in the same row isn't stretched to accommodate it — a fields
    // box is excluded from the row-height computation entirely, so its neighbor keeps
    // the ordinary single-line default instead of being inflated to match.
    const short = /\n\s*short \[[^\]]*height=([\d.]+)\]/.exec(dot);
    expect(short).not.toBeNull();
    expect(Number(short![1])).toBe(0.62);
  });

  it("warns when a reaction triggers no command", () => {
    const { diagnostics } = compile(`
slice "Auto" {
  processor Worker
}
`);
    expect(diagnostics.some((d) => /triggers no command/.test(d.message))).toBe(true);
  });
});

describe("validation", () => {
  it("warns on a command with no event", () => {
    const { diagnostics } = compile(`slice "S" {\n  command Lonely Command\n}`);
    expect(diagnostics.some((d) => /produces no event/.test(d.message))).toBe(
      true,
    );
  });

  it("errors on a view referencing an unknown event", () => {
    const { diagnostics } = compile(
      `slice "S" {\n  view V from "Nope Never Happened"\n}`,
    );
    expect(
      diagnostics.some(
        (d) => d.severity === "error" && /unknown event/.test(d.message),
      ),
    ).toBe(true);
  });

  it("errors on an arrow to a missing element", () => {
    const { diagnostics } = compile(
      `slice "S" {\n  command A\n  event B\n}\narrow A -> Ghost`,
    );
    expect(
      diagnostics.some((d) => d.severity === "error" && /arrow target/.test(d.message)),
    ).toBe(true);
  });

  it("passes the starter model with no errors", () => {
    const { diagnostics } = compile(STARTER_EM);
    expect(diagnostics.some((d) => d.severity === "error")).toBe(false);
  });
});