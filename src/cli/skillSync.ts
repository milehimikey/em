// SPDX-License-Identifier: MIT
// `em skill sync` (MIL-93): materializes/updates a consuming repo's vendored copy of the
// event-modeling skill from the em package actually installed. Unlike `em ledger`/
// skillVersionCheck.ts (which diff two *git revisions* of the same repo), this diffs two
// *directories on disk right now* — the packaged skill bundled with the running em, and a
// vendored copy in some other repo — so there's no GitRunner here at all.
//
// Contract: the vendored copy is read-only from the consuming repo's point of view. Local
// edits are never merged — sync always makes vendoredDir byte-identical to packagedDir, the
// same "you don't own this copy" stance rlm-blueprint's hand-rolled sync guard already
// enforced by hand. That's why, unlike `em skill install`, there's no --force/confirmation
// gate: overwriting is the entire point.
//
// Split into a pure plan (walk + hash, no writes) and a thin apply (the actual fs mutation) so
// `em skill check` (src/cli/skillCheck.ts) can reuse planSkillSync's diff for its own
// content-drift detection without performing any writes.

import { existsSync, mkdirSync, copyFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { walkDir } from "../util/walkDir.js";

export type SkillSyncFileChangeKind = "added" | "modified" | "removed";

export interface SkillSyncFileChange {
  relPath: string;
  kind: SkillSyncFileChangeKind;
}

export interface SkillSyncPlan {
  /** Sorted by relPath. Empty means vendoredDir already matches packagedDir exactly. */
  changes: SkillSyncFileChange[];
  /** Files present, identical, in both dirs — not listed in `changes`. */
  unchangedCount: number;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Pure: compares packagedDir (source of truth) against vendoredDir (which may not exist yet —
 * that's the fresh-sync case, not an error) by per-file sha256. No fs writes.
 */
export function planSkillSync(packagedDir: string, vendoredDir: string): SkillSyncPlan {
  const packagedFiles = new Set(walkDir(packagedDir));
  const vendoredFiles = new Set(existsSync(vendoredDir) ? walkDir(vendoredDir) : []);
  const allPaths = [...new Set([...packagedFiles, ...vendoredFiles])].sort();

  const changes: SkillSyncFileChange[] = [];
  let unchangedCount = 0;

  for (const relPath of allPaths) {
    const inPackaged = packagedFiles.has(relPath);
    const inVendored = vendoredFiles.has(relPath);
    if (inPackaged && !inVendored) {
      changes.push({ relPath, kind: "added" });
    } else if (!inPackaged && inVendored) {
      changes.push({ relPath, kind: "removed" });
    } else if (sha256(join(packagedDir, relPath)) !== sha256(join(vendoredDir, relPath))) {
      changes.push({ relPath, kind: "modified" });
    } else {
      unchangedCount++;
    }
  }

  return { changes, unchangedCount };
}

/**
 * Shell: applies a plan produced by planSkillSync — copies added/modified files from
 * packagedDir into vendoredDir, deletes removed files from vendoredDir. Idempotent; a plan
 * with no changes is a no-op. Creates vendoredDir (and any needed subdirectories) as needed.
 */
export function applySkillSync(plan: SkillSyncPlan, packagedDir: string, vendoredDir: string): void {
  for (const change of plan.changes) {
    const dest = join(vendoredDir, change.relPath);
    if (change.kind === "removed") {
      rmSync(dest);
    } else {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(join(packagedDir, change.relPath), dest);
    }
  }
}
