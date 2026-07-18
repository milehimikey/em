// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigration, planMigration } from "../src/migrate/migrate.js";
import { parseFrontmatter } from "../src/model/frontmatter.js";
import { validateSliceDocs } from "../src/model/validateSliceDocs.js";
import { loadSliceDocs } from "../src/model/sliceDoc.js";
import { normalize } from "../src/model/model.js";
import { parse } from "../src/parser/parser.js";

const MODEL = `model "Demo"
persona Customer
context Order

slice "Place Order" {
  ui Product Catalog @Customer
  command Place Order note "slices/place-order.md"
  event Order Placed @Order
}
`;

const LEGACY_DOC = `<!--
Rich slice design document.
-->

# Slice: Place Order

- **Pattern:** State Change
- **Swimlane:** Customer -> Order
- **Status:** reviewed

## Intent
Customers place orders.

## Dependencies & Read Models Affected
- **Upstream events this slice relies on:** {{...}}
- **Downstream read models / slices affected:** Open Orders
`;

describe("em migrate", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-migrate-"));
    writeFileSync(join(dir, "demo.em"), MODEL);
    mkdirSync(join(dir, "slices"));
    writeFileSync(join(dir, "slices", "place-order.md"), LEGACY_DOC);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("plans frontmatter injection, inferring pattern/sliceElement from the .em over prose", () => {
    const plan = planMigration(dir);
    expect(plan.docs).toHaveLength(1);
    const docPlan = plan.docs[0];
    expect(docPlan.alreadyMigrated).toBe(false);

    const { data, body } = parseFrontmatter(docPlan.content!);
    expect(data).toMatchObject({
      schemaVersion: 1,
      id: "place-order",
      title: "Place Order",
      pattern: "state-change", // from the .em element kind, not the (also-correct) prose
      status: "reviewed", // parsed from prose
      version: 1,
      sliceElement: "place_order",
      commands: ["Place Order"],
      events: ["Order Placed"],
      contexts: ["Order"],
      personas: ["Customer"],
    });
    // Legacy Pattern/Status bullets are stripped; the rest of the body survives.
    expect(body).not.toMatch(/\*\*Pattern:\*\*/);
    expect(body).not.toMatch(/\*\*Status:\*\*/);
    expect(body).toMatch(/\*\*Swimlane:\*\*/);
    expect(body).toContain("Customers place orders.");
  });

  it("is idempotent — a second plan against already-migrated docs is a no-op", () => {
    applyMigration(planMigration(dir));
    const plan2 = planMigration(dir);
    expect(plan2.docs).toHaveLength(1);
    expect(plan2.docs[0].alreadyMigrated).toBe(true);
  });

  it("applying the plan produces a doc that passes validateSliceDocs cleanly", () => {
    applyMigration(planMigration(dir));
    const model = normalize(parse(readFileSync(join(dir, "demo.em"), "utf8")));
    const diags = validateSliceDocs(model, join(dir, "demo.em"), loadSliceDocs(dir));
    expect(diags).toEqual([]);
  });

  it("flags orphan docs (no .em note back-reference) instead of guessing confidently", () => {
    const orphanEm = MODEL.replace(' note "slices/place-order.md"', "");
    writeFileSync(join(dir, "demo.em"), orphanEm);
    const plan = planMigration(dir);
    expect(plan.notes.some((n) => /orphan|pattern couldn't be inferred/.test(n.message))).toBe(true);
    const { data } = parseFrontmatter(plan.docs[0].content!);
    expect(data!.sliceElement).toBeUndefined();
  });

  it("migrates .event-modeling.md by injecting a frontmatter block", () => {
    writeFileSync(
      join(dir, ".event-modeling.md"),
      "# Event Modeling Progress — Demo\n\n- **Model file:** `demo.em`\n",
    );
    const plan = planMigration(dir);
    expect(plan.stateFile?.alreadyMigrated).toBe(false);
    const { data, body } = parseFrontmatter(plan.stateFile!.content!);
    expect(data).toMatchObject({ schemaVersion: 1, model: "demo.em" });
    expect(body).toContain("# Event Modeling Progress — Demo");
  });

  it("regenerates the Slice inventory table, matching rows by slice name", () => {
    writeFileSync(
      join(dir, ".event-modeling.md"),
      [
        "# Event Modeling Progress — Demo",
        "",
        "## Slice inventory",
        "| Slice | Pattern | Doc status |",
        "|-------|---------|------------|",
        "| Place Order | State Change | draft |",
        "| Unmatched Slice | State View | none |",
        "",
      ].join("\n"),
    );
    const plan = planMigration(dir);
    const { body } = parseFrontmatter(plan.stateFile!.content!);
    const lines = body.split("\n");

    expect(lines).toContain("| Slice | Id | Pattern | Doc status |");
    expect(lines).toContain("| Place Order | place-order | state-change | reviewed (v1) |");
    // Unmatched row (no doc named "Unmatched Slice") is left as-is, and flagged.
    expect(lines).toContain("| Unmatched Slice | State View | none |");
    expect(plan.notes.some((n) => /Slice inventory row/.test(n.message))).toBe(true);
  });
});
