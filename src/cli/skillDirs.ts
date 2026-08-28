// SPDX-License-Identifier: MIT
// The set of directories under `.claude/skills/` that together make up the em-bundled
// event-modeling skill (MIL-157): five focused, SDLC-stage skills plus the thin `event-modeling`
// router skill that preserves `/event-modeling` as a single resumable entry point, and one
// non-skill directory (`event-modeling-shared`, no SKILL.md) holding reference/template material
// every skill points back to instead of duplicating. `em skill install`/`sync`/`check` treat this
// whole set as one atomic bundle — installing/syncing/checking all of it in one command, exactly
// like before the split (MIL-93) — so a consumer repo's `.claude/skills/` never needs per-skill
// awareness, and unrelated skills already living in that directory (this em bundle isn't the only
// thing that can be there) are never touched: only these named directories are ever walked, never
// `.claude/skills/` wholesale.

/** Directories with their own SKILL.md (a `name:`/`description:`/`em-version:` frontmatter and
 *  Claude Code entry point). Order is display order only, not load-bearing. */
export const EM_SKILL_DIR_NAMES: readonly string[] = [
  "event-modeling",
  "event-modeling-discover",
  "event-modeling-design",
  "event-modeling-implement",
  "event-modeling-conform",
  "event-modeling-review",
];

/** Directories with no SKILL.md of their own — shared reference/template material every skill
 *  above points back to instead of duplicating. Still part of the sync/check bundle (content
 *  drift matters here too), just never stamp-checked for an `em-version:` frontmatter that
 *  doesn't exist. */
export const EM_SHARED_DIR_NAMES: readonly string[] = ["event-modeling-shared"];

/** Every directory `em skill install`/`sync`/`check` treat as part of the one bundle. */
export const EM_ALL_SKILL_BUNDLE_DIRS: readonly string[] = [...EM_SKILL_DIR_NAMES, ...EM_SHARED_DIR_NAMES];

/** The one directory whose presence/absence gates the bundle as a whole (used by `em skill
 *  install`'s already-installed check and `em ci init`'s generated CI gate) — the router skill,
 *  since it's the fixed entry point every consumer's `/event-modeling` resolves to regardless of
 *  which other skills in the bundle they've actually used. */
export const EM_SKILL_ANCHOR_DIR = "event-modeling";
