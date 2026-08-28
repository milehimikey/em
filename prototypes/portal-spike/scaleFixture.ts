// SPDX-License-Identifier: MIT
// MIL-162 spike: a deterministic generator for a synthetic multi-model system at
// "hundreds of slices, several models" scale — the acceptance criterion the ticket names
// ("prototype against a large (hundreds-of-slices, multi-model) test set, not just the
// tutorial example") that nothing else in examples/ exercises. examples/multi-model/ (MIL-160)
// proves the one-directory-per-model *collision* story at 2 models / 4 slices; this generator
// proves the *navigation* story — a chain of models where each one's public integration
// surface (the `public` clause, docs/dsl.md "Integration surface") feeds the next model's
// intake slice, mirroring how a portal would need to resolve "where does this event's data
// come from" across file boundaries.
//
// Not a shipped `em` feature: nothing here is wired into src/cli.ts, and this directory is
// deliberately outside src/ and examples/. It exists to be run by spike.ts and exercised by
// test/portalSpike.test.ts, and to be thrown away or promoted into the separate em-portal
// package's own fixtures once that repo exists (see docs/decisions/mil-162-teachable-navigator.md).

export interface FixtureModel {
  /** Directory name under the fixture root, e.g. "model-00-checkout". */
  dirName: string;
  /** The quoted model name as declared in the `.em` source, e.g. "Checkout 00". */
  modelName: string;
  /** File name inside dirName, e.g. "model-00-checkout.em". */
  fileName: string;
  /** Full `.em` source text. */
  source: string;
  /** Name of the slice-count-th slice's public event this model exposes (null for the last
   *  model in the chain, matching real systems where not every model has a downstream
   *  consumer inside the same set). */
  publicEventName: string | null;
  /** Name of the upstream public event this model's intake slice consumes (null for the
   *  first model, which has nothing upstream). */
  consumesEventName: string | null;
}

export interface ScaleFixture {
  models: FixtureModel[];
  totalSlices: number;
}

const DOMAIN_NAMES = [
  "Checkout",
  "Fulfillment",
  "Billing",
  "Returns",
  "Support",
  "Loyalty",
  "Inventory",
  "Shipping",
  "Catalog",
  "Notifications",
];

/** Builds `modelCount` models of `slicesPerModel` slices each (plus one intake slice per model
 *  after the first), chained so model `i`'s LAST slice's event is `public` and model `i+1`
 *  opens with an intake slice whose command name cites that event's exact name in plain text
 *  (`Handle <that event name>`) — NOT a `view … from "…"` clause, which only resolves within
 *  the model currently being compiled (`em validate`'s `view-from-unresolved`, hit for real
 *  writing this generator's first draft). Naming convention over independently-compiled files
 *  is the only cross-model linkage `em` has today; a portal has to do the same string-level
 *  join itself (spike.ts's `buildCrossModelLinks`) rather than read it off a compiler-checked
 *  reference. Fully deterministic: same `modelCount`/`slicesPerModel` always produces
 *  byte-identical output, so the fixture (and anything computed over it) is reproducible
 *  without checking hundreds of generated files into git. */
export function generateScaleFixture(modelCount: number, slicesPerModel: number): ScaleFixture {
  if (modelCount < 1) throw new Error("modelCount must be >= 1");
  if (slicesPerModel < 1) throw new Error("slicesPerModel must be >= 1");

  const models: FixtureModel[] = [];
  let totalSlices = 0;
  let previousPublicEvent: string | null = null;

  for (let i = 0; i < modelCount; i++) {
    const domain = DOMAIN_NAMES[i % DOMAIN_NAMES.length];
    const modelName = `${domain} ${String(i).padStart(2, "0")}`;
    const dirName = `model-${String(i).padStart(2, "0")}-${domain.toLowerCase()}`;
    const fileName = `${dirName}.em`;
    const persona = "Operator";
    const context = domain.replace(/\s+/g, "");

    const lines: string[] = [`model "${modelName}"`, "", `persona ${persona}`, "", `context ${context}`, ""];

    const consumesEventName = previousPublicEvent;
    if (consumesEventName !== null) {
      // Deliberately NOT a `view … from "<consumesEventName>"` clause: `from` only resolves
      // within the model currently being compiled (`em validate`'s view-from-unresolved error;
      // discovered running this generator's first draft against real `em validate` — see
      // docs/decisions/mil-162-teachable-navigator.md's "what the prototype found" section).
      // em's DSL has no construct for "this slice's trigger is another FILE's public event" —
      // the only thing carried across model files today is the upstream event's exact NAME, by
      // convention, in this intake slice's own command name. A portal has to join on that
      // convention itself (buildCrossModelLinks in spike.ts); em doesn't verify it.
      lines.push(
        `slice "Intake ${modelName}" {`,
        `  ui Upstream ${modelName} Screen @${persona}`,
        `  command Handle ${consumesEventName}`,
        `  event ${modelName} Intake Acknowledged @${context}`,
        `}`,
        "",
      );
      totalSlices++;
    }

    let publicEventName: string | null = null;
    for (let j = 0; j < slicesPerModel; j++) {
      const isLast = j === slicesPerModel - 1;
      const sliceName = `${modelName} Slice ${String(j).padStart(3, "0")}`;
      const eventName = `${sliceName} Recorded`;
      const publicClause = isLast ? " public" : "";
      if (isLast) publicEventName = eventName;

      lines.push(
        `slice "${sliceName}" {`,
        `  ui ${sliceName} Screen @${persona}`,
        `  command Record ${sliceName}`,
        `  event ${eventName} @${context}${publicClause}`,
        `}`,
        "",
      );
      totalSlices++;
    }

    models.push({
      dirName,
      modelName,
      fileName,
      source: lines.join("\n").trimEnd() + "\n",
      publicEventName,
      consumesEventName,
    });

    previousPublicEvent = publicEventName;
  }

  return { models, totalSlices };
}
