// SPDX-License-Identifier: MIT
// GH #421 step 2 — where a slice's design doc lives. The rule has always been "a slice doc is a
// sibling `slices/<key>.md` of the file that declares the slice"; with storyline models (step 1)
// the declaring file can be `<dir>/<slug>.em`, so the doc is `<dir>/slices/<key>.md`. Every path
// here is posix and relative to the ROOT model's directory (`baseDir` everywhere else in em), so
// a doc path is a stable string a note clause, an export and a README link can all carry.
//
// This module is the one place that knows the layout: `docDirOf` for a slice's prefix,
// `sliceDocRel` for its canonical doc path, `DOC_PATH_RE` to read a key (and dir) back out of a
// note value, and `docsDirs` for the directories a scan must visit.

import type { NormalizedModel, Slice } from "./model.js";

/** `""` for a slice declared in the root file, `"<dir>/"` for one declared in a storyline model
 *  file (its directory, posix, trailing slash). */
export function docDirOf(slice: Pick<Slice, "file"> | undefined): string {
  const file = slice?.file;
  if (!file) return "";
  const i = file.lastIndexOf("/");
  return i < 0 ? "" : file.slice(0, i + 1);
}

/** The canonical doc path of the slice with export key `key`: `<dir>/slices/<key>.md`. */
export function sliceDocRel(slice: Pick<Slice, "file"> | undefined, key: string): string {
  return `${docDirOf(slice)}slices/${key}.md`;
}

/** The doc directory (`<dir>/slices`, relative to the root) of a slice. */
export function sliceDocsDir(slice: Pick<Slice, "file"> | undefined): string {
  return `${docDirOf(slice)}slices`;
}

/** Every doc directory the model's slices use, root's `slices` first, each once, in slice order. */
export function docsDirs(model: Pick<NormalizedModel, "slices">): string[] {
  const out: string[] = ["slices"];
  for (const s of model.slices) {
    const d = sliceDocsDir(s);
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

/** A doc-shaped note value: an optional directory prefix, `slices/`, a kebab key, `.md`.
 *  Groups: [1] the directory prefix without its trailing slash (undefined for the root), [2] the
 *  key. Case-insensitive on the key like the slice-ref grammar. */
export const DOC_PATH_RE = /^(?:(.+?)\/)?slices\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/i;

/** Split a doc path into its directory prefix (`""` or `"<dir>/"`) and key, or null. */
export function parseDocPath(path: string): { dir: string; key: string } | null {
  const m = DOC_PATH_RE.exec(path);
  if (!m) return null;
  return { dir: m[1] ? `${m[1]}/` : "", key: m[2].toLowerCase() };
}
