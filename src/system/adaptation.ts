// SPDX-License-Identifier: MIT
// The consumer-adaptation check (MIL-239): for one `consumes` binding, does the consuming
// translation's declared field set still match the producer's public element? A consumer field
// the producer no longer carries (removed, or renamed — `renamed from` names the new name), or
// a type change on a field both declare, means the consumer has not adapted. Additive producer
// changes (a new field, a new optional field) never raise: the generated contract's doc comment
// says consumers tolerate unknown fields (MIL-237, `CONSUMER_TOLERANCE_SENTENCE`).
//
// Pure, over export JSON fields only (compile isolation, MIL-194) — the field comparison
// vocabulary (`typeIdentity`/`typeLabel`) is the one `em api check` uses.

import { normalizeName } from "../model/model.js";
import type { FieldExport } from "../emit/json.js";
import { typeIdentity, typeLabel } from "../cli/api.js";

/** The slice of a field export the check reads. */
export type AdaptationField = Pick<FieldExport, "name" | "type" | "typeRef" | "renamedFrom">;

export interface AdaptationProblem {
  field: string;
  /** Human wording of what no longer matches, e.g. `renamed to "customerOrderId"`. */
  what: string;
}

/** Problems found comparing `consumer`'s declared fields against `producer`'s, consumer order.
 *  An empty list means adapted (or nothing to compare). */
export function compareConsumerFields(consumer: AdaptationField[], producer: AdaptationField[]): AdaptationProblem[] {
  const byName = new Map(producer.map((f) => [normalizeName(f.name), f]));
  const problems: AdaptationProblem[] = [];
  for (const c of consumer) {
    const key = normalizeName(c.name);
    const same = byName.get(key);
    if (same) {
      if (c.type !== null || c.typeRef !== null) {
        if ((same.type !== null || same.typeRef !== null) && typeIdentity(c) !== typeIdentity(same)) {
          problems.push({ field: c.name, what: `type changed ${typeLabel(c)} → ${typeLabel(same)}` });
        }
      }
      continue;
    }
    const renamed = producer.find((p) => (p.renamedFrom ?? []).some((old) => normalizeName(old) === key));
    if (renamed) {
      let what = `renamed to "${renamed.name}"`;
      if ((c.type !== null || c.typeRef !== null) && typeIdentity(c) !== typeIdentity(renamed)) {
        what += ` (type also changed ${typeLabel(c)} → ${typeLabel(renamed)})`;
      }
      problems.push({ field: c.name, what });
    } else {
      problems.push({ field: c.name, what: "removed" });
    }
  }
  return problems;
}

/** The message for one binding's `consumer-not-adapted` finding. `commit` is the producer's
 *  last commit touching its `.em` source (short sha), or null when unknown. */
export function adaptationMessage(
  consumerLabel: string,
  producerLabel: string,
  problems: AdaptationProblem[],
  commit: string | null,
): string {
  const parts = problems.map((p) => `field "${p.field}" ${p.what}`).join("; ");
  return `${consumerLabel} is not adapted to ${producerLabel}: ${parts} — producer last changed in ${commit ?? "(commit unknown)"}`;
}
