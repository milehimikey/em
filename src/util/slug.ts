// SPDX-License-Identifier: MIT
// Shared name -> identifier slugging. Two conventions, two purposes:
//  - slug(): underscore-separated, used for .em Element ids (model.ts).
//  - kebabSlug(): hyphen-separated, used for slice-doc frontmatter `id` and
//    filenames (matches the skill's existing "kebab-case the slice name"
//    convention). These are distinct namespaces — do not conflate them.

export function slug(name: string): string {
  const s = trimChar(name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"), "_");
  return s || "n";
}

export function kebabSlug(name: string): string {
  const s = trimChar(name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"), "-");
  return s || "n";
}

/** Strip leading/trailing runs of `ch` — a linear scan rather than `/^-+|-+$/`, which CodeQL
 *  flags as polynomial (js/polynomial-redos) now that MIL-193's `@milehimikey/em/refs` subpath
 *  export makes `kebabSlug()` reachable from library input. (The preceding collapse leaves at
 *  most one separator per run, so it was never slow in practice; the scan is simply provably
 *  linear.) */
function trimChar(s: string, ch: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === ch) start++;
  while (end > start && s[end - 1] === ch) end--;
  return s.slice(start, end);
}

/** Append a numeric suffix (`${sep}2`, `${sep}3`, ...) until `id` isn't in `used`. Adds the result to `used`. */
export function dedupe(id: string, used: Set<string>, sep: string): string {
  let candidate = id;
  let n = 2;
  while (used.has(candidate)) candidate = `${id}${sep}${n++}`;
  used.add(candidate);
  return candidate;
}
