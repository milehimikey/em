#!/usr/bin/env node
// Scores a produced model against a reference slicing.
//
//   em export produced.em > produced.json
//   node eval/score.mjs produced.json eval/inputs/<input>/reference.json [--aliases aliases.json] [--json]
//
// Computes the mechanical metrics of the eval protocol (README.md):
//   - slicesPerReaction (PRIMARY): produced slices / reference business reactions. The reference's own
//                            value is reported next to it. aliases.json maps produced slice key ->
//                            reference slice key so a rename is reconciled explicitly (and counted).
//   - sliceRatio (secondary): produced slices / reference slices (1.0 = same granularity)
//   - entityClusteredRate:   share of State Change slices inside a run of >= 3 consecutive same-context
//                            State Change slices that ends in exactly one trailing State View reading only
//                            from that run (0 = none)
// plus businessEventRecall (reference business events found in the produced model) for convenience.
// Reads only `em export` output (no em import), so it runs anywhere Node does.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function sliceContext(slice) {
  const ev = slice.elements.find((e) => e.kind === "event");
  return ev ? (ev.context ?? "") : null;
}

/** Share of State Change slices that sit in an entity-clustered run. */
export function entityClustered(slices) {
  const ordered = [...slices].sort((a, b) => a.index - b.index);
  const stateChanges = ordered.filter((s) => s.pattern === "state-change");
  let clustered = 0;
  let i = 0;
  while (i < ordered.length) {
    if (ordered[i].pattern !== "state-change") {
      i++;
      continue;
    }
    const ctx = sliceContext(ordered[i]);
    let j = i;
    while (j < ordered.length && ordered[j].pattern === "state-change" && sliceContext(ordered[j]) === ctx) j++;
    const run = ordered.slice(i, j);
    const next = ordered[j];
    if (run.length >= 3 && next && next.pattern === "state-view") {
      const keys = new Set(run.map((s) => s.key));
      const reads = next.elements.filter((e) => e.kind === "view").flatMap((e) => e.from ?? []);
      // no cross-context read: every source event belongs to a slice in the run
      if (reads.every((r) => keys.has(String(r.ref).split("/")[0]))) clustered += run.length;
    }
    i = j;
  }
  return { clustered, stateChanges: stateChanges.length, rate: stateChanges.length ? clustered / stateChanges.length : 0 };
}

export function score(exported, reference, aliases = {}) {
  const slices = exported.model.slices;
  const expected = new Set(reference.reactions.flatMap((r) => r.slices));
  const produced = new Set(slices.map((s) => aliases[s.key] ?? s.key));
  const aliasesUsed = slices.filter((s) => s.key in aliases).length;
  const reactions = reference.reactions.length;

  const producedEvents = new Set(
    slices.flatMap((s) => s.elements.filter((e) => e.kind === "event").map((e) => norm(e.name))),
  );
  const expectedEvents = reference.reactions.flatMap((r) => r.events ?? []);
  const found = expectedEvents.filter((e) => producedEvents.has(norm(e)));

  const cluster = entityClustered(slices);
  return {
    input: reference.input,
    reactions,
    producedSlices: produced.size,
    referenceSlices: expected.size,
    slicesPerReaction: produced.size / reactions,
    referenceSlicesPerReaction: expected.size / reactions,
    sliceRatio: produced.size / expected.size,
    aliasesUsed,
    extraSlices: [...produced].filter((k) => !expected.has(k)),
    missingSlices: [...expected].filter((k) => !produced.has(k)),
    businessEventRecall: expectedEvents.length ? found.length / expectedEvents.length : 1,
    stateChangeSlices: cluster.stateChanges,
    entityClusteredSlices: cluster.clustered,
    entityClusteredRate: cluster.rate,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  const ai = argv.indexOf("--aliases");
  const aliasPath = ai >= 0 ? argv[ai + 1] : null;
  const args = argv.filter((a, i) => a !== "--json" && a !== "--aliases" && (ai < 0 || i !== ai + 1));
  if (args.length !== 2) {
    console.error("usage: node eval/score.mjs <em-export.json> <reference.json> [--aliases aliases.json] [--json]");
    process.exit(2);
  }
  const result = score(JSON.parse(readFileSync(args[0], "utf8")), JSON.parse(readFileSync(args[1], "utf8")),
    aliasPath ? JSON.parse(readFileSync(aliasPath, "utf8")) : {},
  );
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`input                  ${result.input}`);
    console.log(`slices per reaction    ${result.slicesPerReaction.toFixed(2)} (reference ${result.referenceSlicesPerReaction.toFixed(2)})  PRIMARY`);
    console.log(`slice ratio            ${result.sliceRatio.toFixed(2)}  (produced/reference slices; 1.00 = reference granularity)`);
    console.log(`aliases used           ${result.aliasesUsed}`);
    console.log(`business-event recall  ${result.businessEventRecall.toFixed(2)}`);
    console.log(`entity-clustered rate  ${result.entityClusteredRate.toFixed(2)} (${result.entityClusteredSlices}/${result.stateChangeSlices} State Change slices)`);
    if (result.extraSlices.length) console.log(`extra slices           ${result.extraSlices.join(", ")}`);
    if (result.missingSlices.length) console.log(`missing slices         ${result.missingSlices.join(", ")}`);
  }
}
