// SPDX-License-Identifier: MIT
// `em inline-check` (GH #496): was a slice ratified INLINE -- on the same branch as its
// implementation -- against the policy `em-policy.yaml` declares (`ratification.inline`)? docs/process.md's
// risk tiers say a public-touching slice takes a separate doc PR; this is the PR-time check.
//
// "Ratified inline" is decided from git, mechanically, over ONE change set (`<base>...HEAD`, the
// merge-base form `em system scope` uses): a slice counts when that change set both
//   (a) ratified its doc -- `ratifiedHash:` is recorded at HEAD and was absent or different at the
//       base (no dependence on `ratifiedRef:`, so `--no-ref` docs count), and
//   (b) touched implementation code -- a path that is not model material (see `isModelMaterial`).
// Pure aside from the injectable GitRunner and fs reads via readSliceDoc; no process.exit.
import { realpathSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { readSliceDoc } from "../catalog/readSliceDoc.js";
import { hasUsableFrontmatter, parseSliceDoc } from "../catalog/sliceDoc.js";
import { slicePublicTouching } from "../catalog/apiFirst.js";
import { sliceDocRel } from "../model/sliceDocPath.js";
import { changedEntriesSince, entryPaths } from "./conformScope.js";
import { GitRunner, realGit } from "./diff-inputs.js";
import { STATE_FILE_NAME } from "./stateFile.js";
import { modelForPath } from "../system/scope.js";
import { EffectivePolicy } from "../policy/policy.js";
import { POLICY_FILE, ROSTER_FILE } from "../roster/roster.js";

export const INLINE_CODE = "slice-ratified-inline";
export type InlineReason = "public-touching" | "policy-never";

export interface InlineFinding {
  code: typeof INLINE_CODE;
  sliceKey: string;
  /** The doc, relative to the model's directory. */
  path: string;
  reason: InlineReason;
  /** Where the governing `ratification.inline` value came from: a policy file, or "default". */
  policySource: string;
  message: string;
}

export interface InlineCheckResult {
  base: string;
  /** The merge-base the change set was measured from. */
  mergeBase: string;
  /** Slice keys whose doc was ratified in the change set, sorted. */
  ratified: string[];
  /** Implementation-code paths the change set touched (repo-root-relative, sorted). */
  codePaths: string[];
  findings: InlineFinding[];
  inline: EffectivePolicy["ratification"]["inline"];
  inlineViolation: EffectivePolicy["ratification"]["inlineViolation"];
  /** False only when there are findings AND `inline-violation: error`. */
  ok: boolean;
}

export type InlineCheckOutcome = { ok: true; result: InlineCheckResult } | { ok: false; message: string };

const MODEL_SUBDIRS = new Set(["slices", "contracts", "model-versions", "conformance"]);

/** Is `repoPath` model material rather than implementation code? Under the model directory
 *  (`modelDir`, repo-relative, "" = repo root) AND one of: an entry of `slices/` `contracts/`
 *  `model-versions/` `conformance/`, a `.em` file, or the `.event-modeling.md` state file.
 *  Containment is `em system scope`'s own (`modelForPath`). */
export function isModelMaterial(repoPath: string, modelDir: string): boolean {
  // The process files that govern the model (policy, roster) are not implementation either, wherever they sit.
  if (basename(repoPath) === POLICY_FILE || basename(repoPath) === ROSTER_FILE) return true;
  if (modelForPath([{ key: "m", dir: modelDir }], repoPath) === null) return false;
  const rest = modelDir === "" ? repoPath : repoPath.slice(modelDir.length + 1);
  const first = rest.split("/")[0];
  return (rest.includes("/") && MODEL_SUBDIRS.has(first)) || rest.toLowerCase().endsWith(".em") || basename(rest) === STATE_FILE_NAME;
}

export function checkInlineRatification(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  base: string,
  policy: EffectivePolicy,
  run: GitRunner = realGit,
): InlineCheckOutcome {
  const git = (args: string[]) => run(["-C", baseDir, ...args]);
  const inside = git(["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    return { ok: false, message: `${baseDir} is not inside a git work tree -- em inline-check reads git history, so it needs one` };
  }
  const mb = git(["merge-base", base, "HEAD"]);
  if (mb.status !== 0 || mb.stdout.trim() === "") {
    return { ok: false, message: `--base "${base}" has no merge-base with HEAD (fetch it first? \`git fetch origin main\`; a shallow clone needs fetch-depth: 0)` };
  }
  const mergeBase = mb.stdout.trim();
  const changed = changedEntriesSince(baseDir, mergeBase, run, "em inline-check");
  if (!changed.ok) return { ok: false, message: changed.message };
  const modelDirRaw = relative(changed.repoRoot, realpathSync(resolve(baseDir))).split("\\").join("/");
  const modelDir = modelDirRaw === "." ? "" : modelDirRaw;
  const codePaths = entryPaths(changed.entries).filter((p) => !isModelMaterial(p, modelDir));

  const ratified: string[] = [];
  const findings: InlineFinding[] = [];
  const { inline, inlineViolation } = policy.ratification;
  const seen = new Set<string>();
  model.slices.forEach((slice, i) => {
    const sliceKey = refs.sliceKeys[i];
    if (seen.has(sliceKey)) return;
    seen.add(sliceKey);
    const head = readSliceDoc(baseDir, sliceKey);
    if (!head || !hasUsableFrontmatter(head) || head.ratifiedHash === null) return;
    const path = sliceDocRel(slice, sliceKey);
    const repoPath = modelDir === "" ? path : `${modelDir}/${path}`;
    const shown = git(["show", `${mergeBase}:${repoPath}`]);
    const before = shown.status === 0 ? parseSliceDoc(shown.stdout) : null;
    if (before !== null && before.ratifiedHash === head.ratifiedHash) return;
    ratified.push(sliceKey);
    if (codePaths.length === 0 || inline.value === "always") return;
    if (inline.value === "internal" && !slicePublicTouching(slice)) return;
    const reason: InlineReason = inline.value === "never" ? "policy-never" : "public-touching";
    const why = reason === "public-touching" ? "it is public-touching" : "ratification.inline is `never`";
    findings.push({
      code: INLINE_CODE,
      sliceKey,
      path,
      reason,
      policySource: inline.source,
      message: `${sliceKey} was ratified in the same change set as implementation code (${codePaths.length} path(s)); ${why} (policy ratification.inline: ${inline.value}, from ${inline.source}) -- ratify it in a separate doc PR`,
    });
  });
  ratified.sort();
  findings.sort((a, b) => (a.sliceKey < b.sliceKey ? -1 : a.sliceKey > b.sliceKey ? 1 : 0));
  return {
    ok: true,
    result: { base, mergeBase, ratified, codePaths, findings, inline, inlineViolation, ok: !(findings.length > 0 && inlineViolation.value === "error") },
  };
}
