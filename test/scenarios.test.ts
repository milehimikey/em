// SPDX-License-Identifier: MIT
// Coverage for the constrained, authored Scenario grammar (src/catalog/scenarios.ts, MIL-266).
import { describe, it, expect } from "vitest";
import { parseScenarios } from "../src/catalog/scenarios.js";

const DOC = [
  "# Slice: Checkout",
  "",
  "## Scenarios (Given / When / Then)",
  "<!-- guidance -->",
  "### Scenario: Customer submits an order",
  "- **Given:**",
  "  - a basket with a positive total",
  "- **When:** the customer submits",
  "- **Then:**",
  "  - `Order Submitted` is recorded",
  "",
  "  - the confirmation shows it",
  "",
  "### Scenario: Rejected (INV-CHK-1)",
  "- **Given:** a basket whose total is 0",
  "- **When:**",
  "  - the customer submits",
  "- **Then:**",
  "  - rejected; no event",
  "",
  "## Open Questions",
  "### Scenario: not in the Scenarios section",
  "- [ ] q",
].join("\n");

describe("parseScenarios", () => {
  it("round-trips every block: title, inline label text, nested items, in document order", () => {
    expect(parseScenarios(DOC)).toEqual({
      scenarios: [
        {
          title: "Customer submits an order",
          given: ["a basket with a positive total"],
          when: ["the customer submits"],
          then: ["`Order Submitted` is recorded", "the confirmation shows it"],
        },
        {
          title: "Rejected (INV-CHK-1)",
          given: ["a basket whose total is 0"],
          when: ["the customer submits"],
          then: ["rejected; no event"],
        },
      ],
      problems: [],
    });
  });

  it("parses a CRLF doc identically", () => {
    expect(parseScenarios(DOC.replace(/\n/g, "\r\n"))).toEqual(parseScenarios(DOC));
  });

  it("reports a block missing a beat with the exact message, and leaves it out of the result", () => {
    const doc = [
      "## Scenarios",
      "### Scenario: Half written",
      "- **Given:**",
      "  - something",
      "- **When:**",
      "",
      "### Scenario: Fine",
      "- **Given:** a",
      "- **When:** b",
      "- **Then:** c",
    ].join("\n");
    expect(parseScenarios(doc)).toEqual({
      scenarios: [{ title: "Fine", given: ["a"], when: ["b"], then: ["c"] }],
      problems: [
        'scenario "Half written" has no **When:**, **Then:** — every `### Scenario:` block needs Given, When and Then bullets',
      ],
    });
  });

  it("ignores the 1.13 case-label bullet shape entirely — no scenarios, no problems", () => {
    const doc = [
      "## Scenarios (Given / When / Then)",
      "- **Happy path**",
      "  - **Given:** a",
      "  - **When:** b",
      "  - **Then:** c",
      "- Free prose about a rejected case.",
    ].join("\n");
    expect(parseScenarios(doc)).toEqual({ scenarios: [], problems: [] });
  });

  it("ignores the Delta section's `##### Scenario:` blocks", () => {
    const doc = ["## Delta", "##### Scenario: x", "- **Given:** a", "## Scenarios", "free prose"].join("\n");
    expect(parseScenarios(doc)).toEqual({ scenarios: [], problems: [] });
  });
});
