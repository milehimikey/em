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

/** GH #494: the policy file that says the pull-request review is the review record (`review:
 *  pull-request`), or null (`session`, or no policy). An invalid policy file refuses the write. */
export function reviewByPullRequestSource(command: string, baseDir: string): string | null {
  const res = effectivePolicy(baseDir);
  if (!res.ok) {
    console.error(`${command}: ${policyRefusal(res)}`);
    process.exit(1);
  }
  const { review } = res.policy;
  return review.value === "pull-request" ? review.source : null;
}

/** GH #494: the stderr lines for a slice whose review was recorded with its sign-off. */
export function reviewRecordedNotices(source: string, sliceKey: string, skipReviewPassed: boolean): string[] {
  const lines = [
    `notice: ${source} sets review: pull-request -- recording the pull-request review as the review record for "${sliceKey}" (reviewedBy/reviewedOn written with the sign-off, no reviewSkipped)`,
  ];
  if (skipReviewPassed) lines.push(`notice: --skip-review was unnecessary for "${sliceKey}" -- ${source} sets review: pull-request, so the review is recorded and no reviewSkipped marker is written`);
  return lines;
}
