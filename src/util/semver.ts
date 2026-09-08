// SPDX-License-Identifier: MIT
// Minimal semver parsing/comparison — em has no runtime dependency on the `semver` package, and
// every comparison it needs (recorded vs. installed `Em version:`, the skill bundle's own
// `em-version:` stamp) is "is A older than B", never full range matching. Pre-release/build
// metadata (`-beta.1`, `+build`) is accepted but ignored for ordering — `em` has never shipped
// one, and treating an unparseable suffix as "equal to the release it's built on" is the safer
// default over throwing.

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)/;

/** `null` for anything that doesn't start with `<major>.<minor>.<patch>` — including the
 *  `"unknown"` sentinel `Em version:` uses for a state file that predates the bullet. */
export function parseSemver(version: string): Semver | null {
  const m = SEMVER_RE.exec(version.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** -1/0/1, ordinary three-way compare on (major, minor, patch). */
export function compareSemver(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/** `true` when `recorded` parses and is strictly older than `installed` — `false` for an
 *  unparseable `recorded` (never a comparison error a caller has to handle; "can't prove it's
 *  behind" reads the same as "not behind" for a warn-only advisory). */
export function isOlder(recorded: string | null, installed: string): boolean {
  if (recorded === null) return false;
  const r = parseSemver(recorded);
  const i = parseSemver(installed);
  if (!r || !i) return false;
  return compareSemver(r, i) < 0;
}

/** `true` when `installed` is ahead of `recorded` by a minor version or more (a major bump also
 *  counts) — the threshold the skill-bundle STOP rule (MIL-219 ruling 3) uses: a patch-only gap
 *  is never worth stopping an agent over, a minor or major one is. `false` when either side
 *  fails to parse. */
export function isBehindByMinorOrMore(recorded: string | null, installed: string): boolean {
  if (recorded === null) return false;
  const r = parseSemver(recorded);
  const i = parseSemver(installed);
  if (!r || !i) return false;
  if (i.major !== r.major) return i.major > r.major;
  return i.minor > r.minor;
}
