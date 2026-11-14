// SPDX-License-Identifier: MIT
// GH #493: the CLI's one seam onto `em-policy.yaml` for commands that act on it. Kept out of
// cli.ts so the ratify action (edited in parallel by other work) carries a single call.

import { effectivePolicy, policyRefusal } from "../policy/policy.js";

/** Whether `em slice ratify` records hash only: the `--no-ref` flag, else `merge: squash|rebase`
 *  in `em-policy.yaml` (stderr says so). There is deliberately no flag to force a ref against
 *  policy. An invalid policy file refuses the write (`policy-invalid`), never falls back. */
export function effectiveNoRef(command: string, baseDir: string, flagNoRef: boolean): boolean {
  const res = effectivePolicy(baseDir);
  if (!res.ok) {
    console.error(`${command}: ${policyRefusal(res)}`);
    process.exit(1);
  }
  if (flagNoRef) return true;
  const { merge } = res.policy;
  if (merge.value === "squash" || merge.value === "rebase") {
    console.error(`notice: ${merge.source} sets merge: ${merge.value} -- recording the hash only (as if --no-ref were passed)`);
    return true;
  }
  return false;
}
