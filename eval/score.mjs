#!/usr/bin/env node
// Scores a produced model against a reference slicing.
//
//   em export produced.em > produced.json
//   node eval/score.mjs produced.json eval/inputs/<input>/reference.json [--aliases aliases.json] [--json]
//
// Computes the mechanical metrics of the eval protocol (README.md):
//   - slicesPerReaction (PRIMARY): produced slices / reference business reactions. The reference's own
//                            value is reported next to it. aliases.json maps produced slice key ->
//                            reference slice key so a rename is reconciled explicitly (and counted). Aliases only
//                            reconcile extra/missing; they never change the produced slice count.
//   - sliceRatio (secondary): produced slices / reference slices (1.0 = same granularity)
//   - entityClusteredRate:   share of State Change slices inside a run of >= 3 consecutive same-context
//                            State Change slices that ends in exactly one trailing State View reading only
//                            from that run (0 = none)
// plus businessEventRecall (reference business events found in the produced model) for convenience.
// Reads only `em export` output (no em import), so it runs anywhere Node does.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const MIN_RUN = 3;

/** Entity-clustered share of State Change slices; mirrors the `timeline-entity-clustered` lint
 *  (src/model/validate.ts) computed from the export: exempt below 2 distinct write contexts; a run
 *  slice has ALL its events on one context and any view it carries reads only that context; the
 *  trailing view is the first view-bearing slice from the run's start onward. Differences from the
 *  lint: `again` views are judged per instance's own sources (the lint uses the logical view's union),
 *  and the lint reports once per maximal run while this counts the run's slices. */
export function entityClustered(slices) {
  const ordered = [...slices].sort((a, b) => a.index - b.index);
  const eventContext = new Map();
  const writeContexts = new Set();
  for (const s of ordered)
    for (const e of s.elements)
      if (e.kind === "event") {
        eventContext.set(norm(e.name), e.context ?? null);
        writeContexts.add(e.context ?? null);
      }
  const stateChanges = ordered.filter((s) => s.pattern === "state-change").length;
  if (writeContexts.size < 2) return { clustered: 0, stateChanges, rate: 0 };

  const info = ordered.map((s) => {
    const events = s.elements.filter((e) => e.kind === "event");
    const views = s.elements.filter((e) => e.kind === "view");
    const evCtx = new Set(events.map((e) => e.context ?? null));
    const viewCtx = new Set();
    for (const v of views) {
      const names = (v.from ?? []).map((f) => f.name);
      if (names.length === 0) for (const c of evCtx) viewCtx.add(c);
      for (const n of names) viewCtx.add(eventContext.get(norm(n)) ?? null);
    }
    const context = s.pattern === "state-change" && events.length > 0 && evCtx.size === 1 ? [...evCtx][0] : undefined;
    return { views: views.length, viewCtx, context };
  });
  const only = (set, ctx) => [...set].every((c) => c === ctx);

  let clustered = 0;
  let i = 0;
  while (i < info.length) {
    const ctx = info[i].context;
    if (ctx === undefined || !only(info[i].viewCtx, ctx)) {
      i++;
      continue;
    }
    let j = i;
    while (j < info.length && info[j].context === ctx && only(info[j].viewCtx, ctx)) j++;
    if (j - i >= MIN_RUN) {
      const trailing = info.slice(i).find((x) => x.views > 0);
      if (trailing && only(trailing.viewCtx, ctx)) clustered += j - i;
    }
    i = j;
  }
  return { clustered, stateChanges, rate: stateChanges ? clustered / stateChanges : 0 };
}

export function score(exported, reference, aliases = {}) {
  const slices = exported.model.slices;
  const expected = new Set(reference.reactions.flatMap((r) => r.slices));
  // Counts come from RAW produced keys: aliases only reconcile the extra/missing lists, so they can
  // never lower the primary metric.
  const rawKeys = slices.map((s) => s.key);
  const used = rawKeys.filter((k) => k in aliases);
  const targets = used.map((k) => aliases[k]);
  if (new Set(targets).size !== targets.length) throw new Error("aliases: two produced keys map to the same reference key (many-to-one)");
  for (const k of used) {
    if (rawKeys.includes(aliases[k])) throw new Error(`aliases: "${k}" maps onto "${aliases[k]}", which the produced model already has`);
  }
  const produced = new Set(rawKeys);
  const reconciled = new Set(rawKeys.map((k) => aliases[k] ?? k));
  const aliasesUsed = used.length;
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
    extraSlices: [...reconciled].filter((k) => !expected.has(k)),
    missingSlices: [...expected].filter((k) => !reconciled.has(k)),
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
