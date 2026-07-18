// SPDX-License-Identifier: MIT
// Shared name -> identifier slugging. Two conventions, two purposes:
//  - slug(): underscore-separated, used for .em Element ids (model.ts).
//  - kebabSlug(): hyphen-separated, used for slice-doc frontmatter `id` and
//    filenames (matches the skill's existing "kebab-case the slice name"
//    convention). These are distinct namespaces — do not conflate them.

export function slug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "n";
}

export function kebabSlug(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "n";
}

/** Append a numeric suffix (`${sep}2`, `${sep}3`, ...) until `id` isn't in `used`. Adds the result to `used`. */
export function dedupe(id: string, used: Set<string>, sep: string): string {
  let candidate = id;
  let n = 2;
  while (used.has(candidate)) candidate = `${id}${sep}${n++}`;
  used.add(candidate);
  return candidate;
}
