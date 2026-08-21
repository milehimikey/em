// SPDX-License-Identifier: MIT
// Unit coverage for the `em scaffold` template-filling helpers in src/templates.ts. CLI-level
// wiring (file creation, --force, refuse-on-existing) is covered in test/cli.test.ts.
import { describe, it, expect } from "vitest";
import { scaffoldReadme, scaffoldStateFile, starterEmFor } from "../src/templates.js";

describe("starterEmFor", () => {
  it("titles the starter model from the given display name, leaving the rest of STARTER_EM intact", () => {
    const em = starterEmFor("Order Fulfillment");
    expect(em.startsWith('model "Order Fulfillment"\n')).toBe(true);
    expect(em).toContain('slice "Browse Catalog"');
  });

  it("titles from an arbitrary name, not just the default", () => {
    const em = starterEmFor("Widget Returns");
    expect(em.startsWith('model "Widget Returns"\n')).toBe(true);
  });
});

describe("scaffoldReadme", () => {
  const readme = scaffoldReadme("Widget Returns", "widget-returns");

  it("fills the Model Name and model-name placeholders throughout the prose", () => {
    expect(readme.startsWith("# Widget Returns\n")).toBe(true);
    expect(readme).toContain("em watch widget-returns.em -o widget-returns.svg --serve");
    expect(readme).toContain("`em slice index widget-returns.em`");
  });

  it("leaves no {{...}} placeholder anywhere in the result", () => {
    expect(readme).not.toMatch(/\{\{[^}]*\}\}/);
  });

  it("keeps the GENERATED:slices marker block exactly as the template has it (header-only, no rows)", () => {
    expect(readme).toContain(
      "<!-- GENERATED:slices:start -->\n" +
        "| # | Slice | Pattern | Status | Implemented in | Design doc |\n" +
        "|---|-------|---------|--------|----------------|------------|\n" +
        "<!-- GENERATED:slices:end -->",
    );
  });
});

describe("scaffoldStateFile", () => {
  const state = scaffoldStateFile("Widget Returns", "widget-returns", "2026-08-20");

  it("fills every mechanical field", () => {
    expect(state).toContain("# Event Modeling Progress — Widget Returns");
    expect(state).toContain("- **Model file:** `widget-returns.em`");
    expect(state).toContain("- **Current phase:** discover");
    expect(state).toContain("- **Current step:** 1");
    expect(state).toContain("- **Last updated:** 2026-08-20");
    expect(state).toContain("- **Last conformance:** never");
    expect(state).toContain("- **Last stakeholder review:** never");
  });

  it("leaves no {{...}} placeholder anywhere in the result", () => {
    expect(state).not.toMatch(/\{\{[^}]*\}\}/);
  });

  it("leaves judgment sections as real empty headers, guidance comments intact, no fabricated bullet", () => {
    // Session inputs: no guidance comment in the template, so a bare empty heading.
    expect(state).toContain("## Session inputs\n\n## Participants");
    // Participants: guidance comment survives, no {{Name}} bullet after it.
    expect(state).toContain(
      "## Participants\n" +
        "<!-- Populate at session start. Live workshop: one human proxy relays questions to the room;\n" +
        "     attribute every answer/decision in the Decisions log to a named participant here. -->\n\n" +
        "## Extraction progress",
    );
    // Decisions log: guidance comment survives, no {{YYYY-MM-DD}}: {{decision}}... bullet after it.
    expect(state).toContain(
      "## Decisions log\n" +
        "<!-- Resolved choices, with the reasoning, so they aren't re-litigated. In a live workshop,\n" +
        "     attribute each entry to the participant who made the call (see Participants above). -->\n\n" +
        "## Usage log",
    );
    // Open questions: guidance comment survives, no {{question}} bullet after it.
    expect(state).toContain(
      "## Open questions / parking lot\n" +
        "<!-- Unresolved items to bring back to the user. Never guess these. Metadata is optional and\n" +
        "     flat — add only what's known: source (ticket/conversation that spawned it), blocked on\n" +
        "     (who/what), revisit (when). -->\n\n" +
        "## Slice inventory",
    );
  });
});
