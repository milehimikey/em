// SPDX-License-Identifier: MIT
// `em slice mark-implemented` (MIL-103): promotes the lifecycle flip that used to live only in
// em-sdd-bridge's `em-sdd-mark-implemented <slice-key> <pr-url>` (see reference/implement.md §6)
// into `em` itself, the same way MIL-87 promoted `--slice-ready`. Sets exactly two frontmatter
// fields — `status: implemented` and `implementedIn: <pr-url>` — on the slice doc resolved from
// the key via the SAME note-binding resolution `--slice-ready`/`em export` use
// (catalog/docJoin.ts's resolveSliceDocJoin). Never touches `version:` (a bump here is an `em
// ledger` defect per docs/slice-doc-schema.md) and never touches the markdown body.
//
// Write strategy: surgical index-math splicing on the raw file text, not a parse+re-serialize
// (sliceDoc.ts's own parser is deliberately read-only and drops everything not in its `SliceDoc`
// shape — round-tripping through it would silently destroy comments, key order, spacing, and
// every field this command isn't allowed to touch). `locateFrontmatterInner` finds the fenced
// block's byte range using plain `indexOf` line-walking rather than `split(/\r?\n/)+join("\n")`
// (what sliceDoc.ts's own splitFrontmatter does for parsing) specifically because a split/join
// round-trip would silently normalize CRLF line endings across the WHOLE file the moment we
// write it back — fine for a read-only parse, not for a rewrite that must preserve the body
// byte-for-byte. Everything outside the two edited value spans — including the body, `version:`,
// the other frontmatter keys, and (best-effort) the file's own line-ending style — is copied
// through verbatim via string slicing, never reconstructed from parsed parts.
//
// Ported from the bridge's `src/lib/mark-implemented-doc.ts`, which targets the legacy
// `- **Status:** ...` / `- **Implemented in:** ...` bullet dialect; this module targets the
// canonical frontmatter dialect (MIL-86) instead, and folds in the note-binding resolution the
// bridge's caller (`mark-implemented.ts`) did via a separate `em export` shell-out.
//
// The three primitives above (`fieldLineRegex`/`normalizeFieldValue`/`locateFrontmatterInner`)
// now live in `./frontmatterSurgery.js` (MIL-165) — `ratify.ts` needs the exact same span-finding
// discipline for its own `status`/`ratifiedBy`/`ratifiedOn` edit, so they moved out to a shared
// module rather than being copy-pasted a second time.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { fieldLineRegex, locateFrontmatterInner, normalizeFieldValue } from "./frontmatterSurgery.js";

export type ApplyFrontmatterResult =
  | { ok: true; content: string; changed: boolean }
  | { ok: false; message: string };

/**
 * Pure text transform: flips `status:` to `implemented` and sets `implementedIn:` to `prUrl` in
 * `raw`'s frontmatter block. Idempotent (re-applying the same URL is a no-op, `changed: false`,
 * `content` returned byte-identical to `raw`); refuses (`ok: false`) rather than overwrite
 * provenance when the doc is already `status: implemented` with a *different* `implementedIn`.
 * No fs access — the caller reads/writes; see `runMarkImplemented` below.
 */
export function applyImplementedFrontmatter(raw: string, prUrl: string): ApplyFrontmatterResult {
  const trimmedUrl = prUrl.trim();
  if (!trimmedUrl) return { ok: false, message: "a PR URL is required" };
  // Refuse control characters (including an embedded \r/\n, which could splice a multi-line
  // value into the frontmatter and corrupt the fence) and internal whitespace — a URL never
  // legitimately contains either, so this is never a false positive, only a caller bug.
  if (/[\x00-\x1f\x7f\x20]/.test(trimmedUrl)) {
    return { ok: false, message: "PR URL must not contain control characters or whitespace" };
  }

  const range = locateFrontmatterInner(raw);
  if (!range) return { ok: false, message: "no frontmatter block found" };
  const inner = raw.slice(range.innerStart, range.innerEnd);

  const statusMatch = fieldLineRegex("status").exec(inner);
  if (!statusMatch) return { ok: false, message: "no `status:` field found in frontmatter" };

  const implMatch = fieldLineRegex("implementedIn").exec(inner);
  const currentStatus = normalizeFieldValue(statusMatch[2])?.toLowerCase() ?? null;
  const currentImplementedIn = implMatch ? normalizeFieldValue(implMatch[2]) : null;

  if (currentStatus === "implemented" && currentImplementedIn !== null) {
    if (currentImplementedIn === trimmedUrl) {
      return { ok: true, content: raw, changed: false }; // idempotent no-op
    }
    return {
      ok: false,
      message:
        `already marked implemented with a different URL (existing: ${currentImplementedIn}, ` +
        `requested: ${trimmedUrl}) — refusing to overwrite`,
    };
  }

  // Apply from the highest index first so an earlier edit's index stays valid — same convention
  // the bridge's applyImplementedStatus uses. `implMatch` (if present) always sits at a higher
  // or lower index than `statusMatch`; either way sorting by index descending keeps both safe to
  // splice independently. When implMatch is absent, a fresh line is inserted right after the
  // status line instead of a replacement.
  let updatedInner: string;
  if (implMatch) {
    const edits = [
      { index: statusMatch.index, oldLen: statusMatch[0].length, next: `${statusMatch[1]}implemented` },
      { index: implMatch.index, oldLen: implMatch[0].length, next: `${implMatch[1]}${trimmedUrl}` },
    ].sort((a, b) => b.index - a.index);
    updatedInner = inner;
    for (const edit of edits) {
      updatedInner = updatedInner.slice(0, edit.index) + edit.next + updatedInner.slice(edit.index + edit.oldLen);
    }
  } else {
    const statusInsertEnd = statusMatch.index + statusMatch[0].length;
    const rest = inner.slice(statusInsertEnd);
    // Match the file's own line-ending style for the freshly-inserted line rather than
    // hardcoding "\n" -- on a CRLF doc, `rest` starts with the "\r\n" that used to terminate the
    // status line; reusing it keeps the new line consistent with its neighbors instead of being
    // the one bare-LF line in an otherwise-CRLF file.
    const eol = rest.startsWith("\r\n") ? "\r\n" : "\n";
    updatedInner = inner.slice(0, statusMatch.index) + `${statusMatch[1]}implemented` + `${eol}implementedIn: ${trimmedUrl}` + rest;
  }

  const content = raw.slice(0, range.innerStart) + updatedInner + raw.slice(range.innerEnd);
  return { ok: true, content, changed: true };
}

export type RunMarkImplementedResult =
  | { ok: true; path: string; changed: boolean }
  | { ok: false; message: string };

/**
 * Resolves `sliceKey` to its bound doc via the same note-binding join `--slice-ready`/`em
 * export` use (MIL-121 cross-binding included — the doc actually edited is whichever one the
 * join resolved to, exactly like `sliceReadyValidate.ts` re-deriving its own read from
 * `doc.path`), then reads/applies/writes it. `baseDir` is the `.em` file's directory, same
 * convention every doc/note path in `em` uses.
 */
export function runMarkImplemented(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  sliceKey: string,
  prUrl: string,
): RunMarkImplementedResult {
  const sliceIndex = refs.sliceKeys.indexOf(sliceKey);
  if (sliceIndex === -1) {
    return { ok: false, message: `no slice with export key "${sliceKey}" in this model` };
  }
  const slice = model.slices[sliceIndex];
  const { doc } = resolveSliceDocJoin(slice, sliceKey, baseDir, (id) => refs.refById.get(id)!);

  if (doc.reason === "no-doc-bound") {
    return {
      ok: false,
      message: `slice "${sliceKey}" has no doc bound via \`note "slices/${sliceKey}.md"\` — bind a slice doc before marking it implemented`,
    };
  }
  if (doc.reason === "binding-missing-file") {
    return { ok: false, message: `slice "${sliceKey}" notes "${doc.path}" but no such file exists` };
  }
  if (doc.reason === "frontmatter-invalid") {
    return {
      ok: false,
      message: `slice doc "${doc.path}" has missing or invalid frontmatter — run \`em validate\` for details`,
    };
  }

  const absPath = join(baseDir, doc.path);
  const raw = readFileSync(absPath, "utf8");
  const result = applyImplementedFrontmatter(raw, prUrl);
  if (!result.ok) {
    return { ok: false, message: `${doc.path}: ${result.message}` };
  }
  if (result.changed) {
    writeFileSync(absPath, result.content, "utf8");
  }
  return { ok: true, path: doc.path, changed: result.changed };
}
