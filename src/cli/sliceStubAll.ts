// SPDX-License-Identifier: MIT
// `em slice stub-all` (MIL-184): one stub doc per undocumented slice, in one command — the
// batch counterpart to `em slice new --stub`, for an exploratory/backbone model that wants
// status coloring without hand-running `slice new` once per slice. Ruled 2026-09-08 (owner,
// MIL-184, option (b) on GH #128): no DSL `status` clause — the doc stays the single source of
// truth for `status`; this command just makes writing that doc near-free. A "backbone" slice
// (established, already shipped) is `--status implemented --implemented-in <url>`, not a made-up
// fifth status value — the reporter's exploratory-model use case maps onto the same four
// lifecycle values every other `em` command already understands.
//
// For each slice, in model declaration order (deterministic, matching every other batch command
// in this codebase):
//   - a continuation slice (MIL-208, an again-view-only instance) is skipped — it has no doc of
//     its own to scaffold (see model/continuation.ts).
//   - a slice whose doc join already resolves cleanly (`resolveSliceDocJoin`'s `reason === null`)
//     is skipped — already documented, nothing to stub.
//   - a slice `classifySlicePattern` can't assign one of the 4 doc `pattern` values to
//     (`"unclassified"` — an empty or malformed slice `em validate` already flags elsewhere) is
//     skipped — there's no frontmatter `pattern` value to write.
//   - a `no-doc-bound` slice whose canonical `slices/<key>.md` path already holds a file on disk
//     (an orphaned doc nothing notes) is skipped rather than silently overwritten — this command
//     offers no `--force`, matching the "never clobber without an explicit, visible opt-in"
//     discipline every frontmatter-surgery command here holds.
//   - a `frontmatter-invalid` doc (the file exists, is noted, but its frontmatter doesn't parse)
//     is skipped for the same reason — fix it by hand (`em validate` explains what's wrong).
// Everything else gets a stub: pattern from `classifySlicePattern`, swimlane derived from the
// slice's own shape (`deriveStubSwimlane` below), wired via the exact `wireSliceNote` `em slice
// new --wire` uses. A `binding-missing-file` doc (a note already points at the canonical path;
// just the file itself is missing) is stubbed WITHOUT re-wiring — the note is already there, and
// re-wiring would refuse ("already has a note clause").
//
// `--status` escalates a freshly-built `status: draft` stub past draft using the EXACT
// frontmatter writers `em slice review`/`em slice ratify`/`em slice mark-implemented` already
// own (`applyReviewFrontmatter`/`applyRatifyFrontmatter`/`applyImplementedFrontmatter`) — never a
// reimplementation of what "reviewed"/"ready-to-implement"/"implemented" write. Escalating to
// `reviewed` applies the review writer once; to `ready-to-implement` applies review then ratify
// (the freshly-reviewed doc always satisfies ratify's own review-gate check, so `--skip-review`
// is never needed here, unlike the standalone `em slice ratify`); to `implemented` applies
// review, then ratify, then mark-implemented. One `--by`/`on` pair stamps every escalated field
// this run touches — a batch scaffold, not a record of N separate human sessions.

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NormalizedModel, Slice } from "../model/model.js";
import { RefsResult } from "../model/refs.js";
import { continuationOf } from "../model/continuation.js";
import { classifySlicePattern } from "../catalog/classify.js";
import { resolveSliceDocJoin } from "../catalog/docJoin.js";
import { wireSliceNote } from "./sliceLink.js";
import { buildStubDocContent, SlicePattern } from "./sliceNew.js";
import { applyReviewFrontmatter } from "./review.js";
import { applyRatifyFrontmatter } from "./ratify.js";
import { applyImplementedFrontmatter } from "./markImplemented.js";

/** `--status`'s exact 4-value enum — the same lifecycle values every slice doc already uses
 *  (docs/slice-doc-schema.md); `stub-all` never invents a 5th "backbone"/"existing" value. */
export const STUB_STATUSES = ["draft", "reviewed", "ready-to-implement", "implemented"] as const;
export type StubStatus = (typeof STUB_STATUSES)[number];

export function isStubStatus(value: string): value is StubStatus {
  return (STUB_STATUSES as readonly string[]).includes(value);
}

/**
 * MIL-184: derive a stub's `swimlane` from the slice's own shape rather than asking for one per
 * slice — the slice's first `ui` element's resolved `persona`, arrow-joined to its first `event`
 * element's resolved `context`, both in declaration order (matching `wireSliceNote`'s own
 * "first candidate wins" convention). Falls back to the literal placeholder `"— → —"` when either
 * side is missing (a slice with no `ui` at all — a pure Automation/Translation reaction never
 * has a screen of its own — or, vanishingly rare, no `event` either): a placeholder is honest
 * about "nobody's filled this in yet," which is exactly a stub's whole premise, rather than
 * guessing a lane from unrelated context.
 */
export function deriveStubSwimlane(slice: Slice): string {
  const persona = slice.elements.find((el) => el.kind === "ui")?.persona;
  const context = slice.elements.find((el) => el.kind === "event")?.context;
  if (!persona || !context) return "— → —";
  return `${persona} → ${context}`;
}

export type ApplyStubStatusResult = { ok: true; content: string } | { ok: false; message: string };

/**
 * Escalates a freshly-built `status: draft` stub's content to `status`, reusing review/ratify/
 * mark-implemented's own pure frontmatter writers (see module header) — never a second
 * implementation of what those statuses write. `by`/`on` are required by the CALLER (the CLI
 * action, which enforces `--by` before compiling anything) whenever `status !== "draft"`; this
 * function has no opinion about CLI flag requiredness, only about what each writer itself
 * validates (a blank `by`, a malformed `on`). `implementedInUrl` only matters for `status ===
 * "implemented"` — required there, ignored otherwise.
 */
export function applyStubStatus(
  content: string,
  sliceKey: string,
  status: StubStatus,
  by: string,
  on: string,
  implementedInUrl: string | null,
): ApplyStubStatusResult {
  if (status === "draft") return { ok: true, content };

  const reviewed = applyReviewFrontmatter(content, by, on);
  if (!reviewed.ok) return reviewed;
  if (status === "reviewed") return { ok: true, content: reviewed.content };

  const ratified = applyRatifyFrontmatter(reviewed.content, sliceKey, by, on);
  if (!ratified.ok) return ratified;
  if (status === "ready-to-implement") return { ok: true, content: ratified.content };

  // status === "implemented"
  if (!implementedInUrl) {
    return { ok: false, message: "--implemented-in <url> is required for --status implemented" };
  }
  return applyImplementedFrontmatter(ratified.content, implementedInUrl);
}

export type StubAllOutcome =
  | {
      kind: "stubbed";
      sliceKey: string;
      path: string;
      pattern: SlicePattern;
      swimlane: string;
      status: StubStatus;
      /** False only for the `binding-missing-file` case: a note already pointed at this path, so
       *  there was nothing left to wire. */
      wired: boolean;
      elementName: string | null;
    }
  | { kind: "skip"; sliceKey: string; reason: string };

export interface StubAllOptions {
  status: StubStatus;
  /** Required by the caller whenever `status !== "draft"` — `null` only ever legal for `draft`. */
  by: string | null;
  on: string;
  implementedInUrl: string | null;
  dryRun: boolean;
}

export interface StubAllResult {
  outcomes: StubAllOutcome[];
  /** The `.em` file's source text with every successful `--wire` insertion applied, in slice
   *  order — byte-identical to the input `source` when nothing needed wiring, or when `dryRun`.
   *  The caller (the CLI action) writes this back to `<file>`, same read/resolve/write split
   *  `em slice new --wire`'s own CLI action keeps. */
  source: string;
}

/**
 * Walks `model.slices` in declaration order and, for every slice with no resolvable doc, writes
 * a stub `slices/<key>.md` (skipped entirely when `opts.dryRun`) and wires it into `source` —
 * see the module header for the full per-slice decision tree. `baseDir` is the `.em` file's
 * directory, same convention every doc/note path in `em` uses. Never throws on a per-slice
 * problem — every failure becomes a `"skip"` outcome so one bad slice doesn't abort the batch.
 */
export function runStubAll(
  model: NormalizedModel,
  refs: RefsResult,
  baseDir: string,
  source: string,
  opts: StubAllOptions,
): StubAllResult {
  const outcomes: StubAllOutcome[] = [];
  let workingSource = source;

  for (let i = 0; i < model.slices.length; i++) {
    const slice = model.slices[i];
    const sliceKey = refs.sliceKeys[i];

    const continuation = continuationOf(model, refs, i);
    if (continuation) {
      outcomes.push({
        kind: "skip",
        sliceKey,
        reason: `continuation of "${continuation.sliceKey}" (view again, MIL-208) — no doc of its own`,
      });
      continue;
    }

    const { doc } = resolveSliceDocJoin(model, refs, slice, sliceKey, baseDir, (id) => refs.refById.get(id)!);
    if (doc.reason === null) {
      outcomes.push({ kind: "skip", sliceKey, reason: `already documented (${doc.path})` });
      continue;
    }

    const classified = classifySlicePattern(slice);
    if (classified === "unclassified") {
      outcomes.push({ kind: "skip", sliceKey, reason: "pattern is unclassified — nothing to stub" });
      continue;
    }
    // Safe: every classifySlicePattern() value other than "unclassified" is one of the exact 4
    // string literals sliceNew.ts's SlicePattern enumerates too.
    const pattern = classified as SlicePattern;

    const absPath = join(baseDir, doc.path);
    if (doc.reason === "no-doc-bound" && existsSync(absPath)) {
      outcomes.push({
        kind: "skip",
        sliceKey,
        reason: `${doc.path} already exists but isn't wired — bind or remove it by hand`,
      });
      continue;
    }
    if (doc.reason === "frontmatter-invalid") {
      outcomes.push({
        kind: "skip",
        sliceKey,
        reason: `${doc.path} exists but its frontmatter is invalid — fix it by hand (see em validate)`,
      });
      continue;
    }

    const swimlane = deriveStubSwimlane(slice);
    const draftContent = buildStubDocContent(slice.name, pattern, swimlane);
    const statusResult = applyStubStatus(draftContent, sliceKey, opts.status, opts.by ?? "", opts.on, opts.implementedInUrl);
    if (!statusResult.ok) {
      outcomes.push({ kind: "skip", sliceKey, reason: statusResult.message });
      continue;
    }

    // `binding-missing-file`: a note already points at this exact path — re-wiring would refuse
    // ("already has a note clause"), and there's nothing to wire anyway.
    const needsWire = doc.reason !== "binding-missing-file";
    let elementName: string | null = null;
    if (needsWire) {
      const wired = wireSliceNote(workingSource, model, refs, sliceKey, pattern, doc.path);
      if (!wired.ok) {
        outcomes.push({ kind: "skip", sliceKey, reason: `--wire failed: ${wired.message}` });
        continue;
      }
      workingSource = wired.content;
      elementName = wired.elementName;
    }

    if (!opts.dryRun) writeFileSync(absPath, statusResult.content, "utf8");
    outcomes.push({
      kind: "stubbed",
      sliceKey,
      path: doc.path,
      pattern,
      swimlane,
      status: opts.status,
      wired: needsWire,
      elementName,
    });
  }

  return { outcomes, source: opts.dryRun ? source : workingSource };
}
