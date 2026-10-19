// SPDX-License-Identifier: MIT
// `em roster init` (GH #259, the upgrade path #290 names): write a starting `ratifiers.yaml` from
// the names the model's slice docs already record in `ratifiedBy:` / `reviewedBy:`, so adopting the
// roster does not start by locking out everyone who has already signed something. Entries carry no
// `contexts` (whole model) -- narrowing them is the host's decision, made by editing the file.

import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { ROSTER_SCHEMA_VERSION, isGrandfatheredSignoff } from "./roster.js";

/** `em upgrade`'s ratified-signoff step writes this placeholder; it is not a person. */
export interface ObservedSigners {
  ratifiers: string[];
  reviewers: string[];
  /** Docs carrying the grandfathered placeholder (skipped; counted so the exemption is visible). */
  grandfathered: number;
}

/** Distinct, sorted signer names across every slice doc bound in the model. */
export function observeSigners(model: NormalizedModel, refs: RefsResult, baseDir: string): ObservedSigners {
  const ratifiers = new Set<string>();
  const reviewers = new Set<string>();
  let grandfathered = 0;
  const seen = new Set<string>();
  refs.sliceKeys.forEach((sliceKey, i) => {
    const { doc } = resolveSliceDocJoin(model, refs, model.slices[i], sliceKey, baseDir, (id) => refs.refById.get(id)!);
    if (doc.reason !== null || seen.has(doc.path)) return;
    seen.add(doc.path);
    if (isGrandfatheredSignoff(doc.ratifiedBy) || isGrandfatheredSignoff(doc.reviewedBy)) grandfathered++;
    if (doc.ratifiedBy && !isGrandfatheredSignoff(doc.ratifiedBy)) ratifiers.add(doc.ratifiedBy.trim());
    if (doc.reviewedBy && !isGrandfatheredSignoff(doc.reviewedBy)) reviewers.add(doc.reviewedBy.trim());
  });
  const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
  return { ratifiers: sorted(ratifiers), reviewers: sorted(reviewers), grandfathered };
}

const yamlName = (n: string) => JSON.stringify(n);

/** Roster text for `observed`. With no ratifier observed there is nothing to seed, so the
 *  `ratifiers:` list is a commented placeholder -- but the file must still be valid, so the
 *  caller refuses to write when both lists are empty. */
export function renderRoster(observed: ObservedSigners): string {
  const lines = [
    "# ratifiers.yaml -- who may sign slice docs for this model (em roster init).",
    "# Seeded from the names already recorded in the slice docs. Narrow an entry with",
    "# `contexts: [Name, ...]` (omit = whole model). Delete the file to lift the restriction.",
    `rosterSchemaVersion: "${ROSTER_SCHEMA_VERSION}"`,
  ];
  const list = (key: string, names: string[]) => {
    lines.push(`${key}:`);
    for (const n of names) lines.push(`  - name: ${yamlName(n)}`);
  };
  if (observed.ratifiers.length > 0) list("ratifiers", observed.ratifiers);
  if (observed.reviewers.length > 0) list("reviewers", observed.reviewers);
  return lines.join("\n") + "\n";
}
