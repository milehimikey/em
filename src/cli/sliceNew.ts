// SPDX-License-Identifier: MIT
// `em slice new` (MIL-97 item 3): scaffolds a fresh slices/<key>.md doc's mechanical
// frontmatter + heading — exactly the 5 keys docs/slice-doc-schema.md's required-vs-optional
// table requires at `status: draft` (schemaVersion/pattern/swimlane/status/version), nothing
// else — no `implementedIn` (only required once a slice has ever reached `implemented`), no
// lineage keys (`split-from`/`merged-from`/`superseded-by` only apply to a split/merge/rename
// doc), no commented-out guidance cruft. The skill's `slice` phase still writes every judgment
// section by hand (Intent, Command, Scenarios, Open Questions, ...) — this command only kills
// the copy-paste-the-template-and-fill-in-the-frontmatter step, the one purely mechanical part
// that was silently drifting when hand-typed (a placeholder left unedited, a key forgotten).
//
// Deliberately fs-free/pure — src/cli.ts owns the write, the existing-file/--force check, and
// the printed `note` reminder, same split as sliceIndex.ts (buildSliceIndexTable vs
// runSliceIndex/CLI wiring).

import { kebabSlug } from "../util/slug.js";

/** `pattern`'s exact 4-value enum — docs/slice-doc-schema.md's "Canonical keys" table. */
export const SLICE_PATTERNS = ["state-change", "state-view", "automation", "translation"] as const;
export type SlicePattern = (typeof SLICE_PATTERNS)[number];

export function isSlicePattern(value: string): value is SlicePattern {
  return (SLICE_PATTERNS as readonly string[]).includes(value);
}

/** Current frontmatter dialect version (docs/slice-doc-schema.md, "schemaVersion vs version"):
 *  one value, the same across every doc using this dialect, bumped only by `em` maintainers
 *  when the dialect's canonical keys change — unrelated to any one slice's own `version`.
 *  Unchanged since MIL-86. */
const SCHEMA_VERSION = 1;

/** The filename stem a slice's display name maps to — `slices/<key>.md`, and the same key a
 *  `note "slices/<key>.md"` binding on the slice's primary element must match. Always derive
 *  it with this (kebabSlug, the same helper `em scaffold` uses) rather than letting a caller
 *  pass a pre-slugged key of their own, so the two can never drift apart. */
export function sliceDocKey(displayName: string): string {
  return kebabSlug(displayName);
}

/**
 * Build the full contents of a fresh `slices/<key>.md`. Frontmatter: exactly the 5 keys
 * required at `status: draft`, in the same order templates/slice.md's own frontmatter block
 * uses. Body: the `# Slice: <name>` heading and the diagram-image stub the skill's `slice`
 * phase step 3 fills the actual image in for (`em render ... --slice ... -o
 * slices/<key>.svg`) — every judgment section (Intent, Command, Scenarios, Open Questions,
 * ...) is deliberately left out, staying hand-authored per templates/slice.md.
 */
export function buildSliceDocContent(displayName: string, key: string, pattern: SlicePattern, swimlane: string): string {
  return (
    `---\n` +
    `schemaVersion: ${SCHEMA_VERSION}\n` +
    `pattern: ${pattern}\n` +
    `swimlane: ${swimlane}\n` +
    `status: draft\n` +
    `version: 1\n` +
    `---\n` +
    `# Slice: ${displayName}\n` +
    `\n` +
    `![Diagram](./${key}.svg)\n`
  );
}
