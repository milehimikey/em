#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Scores an `em conform` run's findings against a conform eval case's expected-outcome file
// (eval/conform/README.md). Unlike eval/score.mjs (the discover/slice-quality protocol this
// extends — GH #452), conform's output isn't fully mechanical: the spec surface and the
// false-positive-bait idiom need an agent's judgment, so this scorer reads the agent's own
// findings record (the `conformance/<date>-findings.json` shape reference/conform.md's step 5
// defines, `findingsSchemaVersion: "1.0"`) rather than re-deriving everything from `em export`.
//
//   node eval/conform/score.mjs <findings.json> <expected.json> [--json]
//
// `expected.json` (one per case, see eval/conform/helpdesk/expected/*.json):
//   {
//     "expectedSchemaVersion": "1.0",
//     "mustReport": [ { "id", "surface", "class", "slice", "summary" }, ... ],
//     "mustNotReport": [ { "id", "slice", "wouldLookLike", "reason" }, ... ]
//   }
//
// Metrics (the three GH #452 asks):
//   - catchRate            — share of `mustReport` entries the run reported AT ALL (same
//                             slice + surface), regardless of whether the classification was
//                             right. 1.0 = every seeded finding was found.
//   - classificationAccuracy — share of `mustReport` entries the run both caught AND classified
//                             with the expected `class` string exactly. Denominator is the
//                             full `mustReport` list (a miss counts against this too, same as
//                             catchRate) — this is deliberately the stricter, "did the whole
//                             job" reading, not just accuracy conditioned on having caught it.
//   - falsePositiveCount   — findings classified "Real drift" or "Model gap" (an actual
//                             reported problem, not Accepted divergence/Unpropagated delta/
//                             Extraction uncertainty) on a slice that `mustReport` never names
//                             for that surface. A finding on a `mustNotReport` slice is always
//                             counted here; so is any OTHER unseeded problem report. 0 is ideal
//                             — this is the number the false-positive-bait case (d) exists to
//                             keep honest.
//
// A finding "matches" a `mustReport` entry when `slice` and `surface` both agree — classes are
// compared separately (that disagreement is what `classificationAccuracy` is for), not folded
// into the match test itself.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REPORTED_PROBLEM_CLASSES = new Set(["Real drift", "Model gap"]);

/**
 * @param {Array<{surface: string, class: string, slice: string|null}>} findings
 * @param {{mustReport: Array<{id:string, surface:string, class:string, slice:string}>, mustNotReport?: Array<{id:string, slice:string}>}} expected
 */
export function scoreConform(findings, expected) {
  const mustReport = expected.mustReport ?? [];
  const byKey = new Map();
  for (const f of findings) {
    const key = `${f.surface}::${f.slice}`;
    const list = byKey.get(key) ?? [];
    list.push(f);
    byKey.set(key, list);
  }

  const matched = [];
  const missed = [];
  const misclassified = [];
  for (const expectedFinding of mustReport) {
    const key = `${expectedFinding.surface}::${expectedFinding.slice}`;
    const candidates = byKey.get(key) ?? [];
    if (candidates.length === 0) {
      missed.push(expectedFinding);
      continue;
    }
    matched.push(expectedFinding);
    if (!candidates.some((f) => f.class === expectedFinding.class)) {
      misclassified.push({ expected: expectedFinding, reportedClasses: candidates.map((f) => f.class) });
    }
  }

  const expectedKeys = new Set(mustReport.map((e) => `${e.surface}::${e.slice}`));
  const falsePositives = findings.filter(
    (f) => REPORTED_PROBLEM_CLASSES.has(f.class) && !expectedKeys.has(`${f.surface}::${f.slice}`),
  );

  const total = mustReport.length;
  return {
    totalExpected: total,
    caught: matched.length,
    catchRate: total ? matched.length / total : 1,
    correctlyClassified: matched.length - misclassified.length,
    classificationAccuracy: total ? (matched.length - misclassified.length) / total : 1,
    falsePositiveCount: falsePositives.length,
    missed,
    misclassified,
    falsePositives,
  };
}

/** Load a `conformance/<date>-findings.json` document and return its `findings` array, the
 *  shape `scoreConform` consumes. Accepts either the full document or a bare array, so an eval
 *  runner can score a hand-trimmed list without the rest of the envelope. */
export function loadFindings(path) {
  const doc = JSON.parse(readFileSync(path, "utf8"));
  return Array.isArray(doc) ? doc : doc.findings ?? [];
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  const args = argv.filter((a) => a !== "--json");
  if (args.length !== 2) {
    console.error("usage: node eval/conform/score.mjs <findings.json> <expected.json> [--json]");
    process.exit(2);
  }
  const findings = loadFindings(args[0]);
  const expected = JSON.parse(readFileSync(args[1], "utf8"));
  const result = scoreConform(findings, expected);
  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`caught                 ${result.caught}/${result.totalExpected}`);
    console.log(`catch rate             ${result.catchRate.toFixed(2)}`);
    console.log(`classification acc.    ${result.classificationAccuracy.toFixed(2)}`);
    console.log(`false positives        ${result.falsePositiveCount}`);
    if (result.missed.length) console.log(`missed                 ${result.missed.map((m) => m.id).join(", ")}`);
    if (result.misclassified.length)
      console.log(`misclassified          ${result.misclassified.map((m) => m.expected.id).join(", ")}`);
    if (result.falsePositives.length)
      console.log(`false-positive slices  ${result.falsePositives.map((f) => f.slice).join(", ")}`);
  }
}
