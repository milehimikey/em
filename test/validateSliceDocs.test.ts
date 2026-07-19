// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "../src/parser/parser.js";
import { normalize, NormalizedModel } from "../src/model/model.js";
import { loadSliceDocs } from "../src/model/sliceDoc.js";
import { validateSliceDocs } from "../src/model/validateSliceDocs.js";

const STATE_CHANGE_EM = `model "Demo"
persona Customer
context Order

slice "Place Order" {
  ui Product Catalog @Customer
  command Place Order note "slices/place-order.md"
  event Order Placed @Order
}
`;

const VALID_FRONTMATTER = `schemaVersion: 1
id: place-order
title: Place Order
pattern: state-change
status: draft
version: 1
model: ../model.em
sliceElement: place_order
commands: ["Place Order"]
events: ["Order Placed"]
readModels: []
contexts: ["Order"]
personas: ["Customer"]
`;

function messages(diags: { message: string }[]): string[] {
  return diags.map((d) => d.message);
}

describe("validateSliceDocs", () => {
  let dir: string;
  let modelPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "em-validate-slices-"));
    modelPath = join(dir, "model.em");
    writeFileSync(modelPath, STATE_CHANGE_EM);
    mkdirSync(join(dir, "slices"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function buildModel(): NormalizedModel {
    return normalize(parse(STATE_CHANGE_EM));
  }

  it("passes clean on a fully valid, in-sync doc", () => {
    writeFileSync(join(dir, "slices", "place-order.md"), `---\n${VALID_FRONTMATTER}---\nBody.\n`);
    const diags = validateSliceDocs(buildModel(), modelPath, loadSliceDocs(dir));
    expect(diags).toEqual([]);
  });

  it("errors when a doc has no frontmatter block at all", () => {
    writeFileSync(join(dir, "slices", "place-order.md"), "# Slice: Place Order\n\nNo frontmatter.\n");
    const diags = validateSliceDocs(buildModel(), modelPath, loadSliceDocs(dir));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("error");
    expect(diags[0].message).toMatch(/em migrate/);
  });

  it("errors on invalid pattern/status enums and non-kebab id", () => {
    const bad = VALID_FRONTMATTER.replace("id: place-order", "id: PlaceOrder")
      .replace("pattern: state-change", "pattern: write")
      .replace("status: draft", "status: in_progress");
    writeFileSync(join(dir, "slices", "place-order.md"), `---\n${bad}---\nBody.\n`);
    const diags = validateSliceDocs(buildModel(), modelPath, loadSliceDocs(dir));
    const msgs = messages(diags);
    expect(msgs.some((m) => /not kebab-case/.test(m))).toBe(true);
    expect(msgs.some((m) => /pattern.*must be one of/.test(m))).toBe(true);
    expect(msgs.some((m) => /status.*must be one of/.test(m))).toBe(true);
  });

  it("errors when sliceElement doesn't resolve to a real element", () => {
    const bad = VALID_FRONTMATTER.replace("sliceElement: place_order", "sliceElement: nonexistent");
    writeFileSync(join(dir, "slices", "place-order.md"), `---\n${bad}---\nBody.\n`);
    const diags = validateSliceDocs(buildModel(), modelPath, loadSliceDocs(dir));
    expect(messages(diags).some((m) => /does not match any element/.test(m))).toBe(true);
  });

  it("errors when model path doesn't resolve to an existing file", () => {
    const bad = VALID_FRONTMATTER.replace("model: ../model.em", "model: ../missing.em");
    writeFileSync(join(dir, "slices", "place-order.md"), `---\n${bad}---\nBody.\n`);
    const diags = validateSliceDocs(buildModel(), modelPath, loadSliceDocs(dir));
    expect(messages(diags).some((m) => /does not resolve to an existing file/.test(m))).toBe(true);
  });

  it("errors on duplicate ids across two docs", () => {
    writeFileSync(join(dir, "slices", "place-order.md"), `---\n${VALID_FRONTMATTER}---\nBody.\n`);
    writeFileSync(join(dir, "slices", "place-order-2.md"), `---\n${VALID_FRONTMATTER}---\nBody.\n`);
    const diags = validateSliceDocs(buildModel(), modelPath, loadSliceDocs(dir));
    expect(messages(diags).some((m) => /is also used by/.test(m))).toBe(true);
  });

  it("warns on an orphan doc with no .em element linking to it", () => {
    const noNoteEm = STATE_CHANGE_EM.replace(' note "slices/place-order.md"', "");
    writeFileSync(modelPath, noNoteEm);
    writeFileSync(join(dir, "slices", "place-order.md"), `---\n${VALID_FRONTMATTER}---\nBody.\n`);
    const diags = validateSliceDocs(normalize(parse(noNoteEm)), modelPath, loadSliceDocs(dir));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toMatch(/orphan doc/);
  });

  it("warns when generated fields drift from the .em", () => {
    const stale = VALID_FRONTMATTER.replace('commands: ["Place Order"]', "commands: []");
    writeFileSync(join(dir, "slices", "place-order.md"), `---\n${stale}---\nBody.\n`);
    const diags = validateSliceDocs(buildModel(), modelPath, loadSliceDocs(dir));
    expect(diags).toHaveLength(1);
    expect(diags[0].severity).toBe("warning");
    expect(diags[0].message).toMatch(/em slice sync/);
  });

  it("resolves triggers/triggeredBy across an automation -> command two-slice split", () => {
    const em = `model "Payments"
persona Customer
context Payment

slice "Payments To Process" {
  view Payments To Process from "Payment Requested"
  processor Payment Gateway note "slices/payments-to-process.md"
}

slice "Capture Payment" {
  command Capture Payment note "slices/capture-payment.md"
  event Payment Captured @Payment
}
`;
    const path = join(dir, "payments.em");
    writeFileSync(path, em);

    writeFileSync(
      join(dir, "slices", "payments-to-process.md"),
      `---\nschemaVersion: 1\nid: payments-to-process\ntitle: Payments To Process\npattern: automation\nstatus: draft\nversion: 1\nmodel: ../payments.em\nsliceElement: payment_gateway\ncommands: []\nevents: []\nreadModels: ["Payments To Process"]\ncontexts: []\npersonas: []\ntriggers: capture-payment\n---\nBody.\n`,
    );
    writeFileSync(
      join(dir, "slices", "capture-payment.md"),
      `---\nschemaVersion: 1\nid: capture-payment\ntitle: Capture Payment\npattern: state-change\nstatus: draft\nversion: 1\nmodel: ../payments.em\nsliceElement: capture_payment\ncommands: ["Capture Payment"]\nevents: ["Payment Captured"]\nreadModels: []\ncontexts: ["Payment"]\npersonas: []\ntriggeredBy: payments-to-process\n---\nBody.\n`,
    );

    const diags = validateSliceDocs(normalize(parse(em)), path, loadSliceDocs(dir));
    expect(diags).toEqual([]);
  });
});
