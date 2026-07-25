// SPDX-License-Identifier: MIT
// Structural diff between two NormalizedModels, for `em diff`. Identity is
// export identity: slices are matched by their `em export` key, elements by
// their `em export` ref (see computeRefs() in ../emit/json.ts) — the same
// edit-stable scheme `em export` already guarantees (inserting/reordering
// slices doesn't change an existing element's ref). A rename (same slot,
// different name) is therefore NOT tracked as a rename — it reads as a
// remove+add, deliberately: a rename IS a model change. A cross-slice MOVE
// (same kind + normalized name, different slice) is detected separately and
// reported once, not as add+remove.

import { computeRefs } from "../emit/json.js";
import { Element, NormalizedModel, normalizeName } from "./model.js";
import { ElementKind } from "../parser/ast.js";

export type ChangeType =
  | "slice-added"
  | "slice-removed"
  | "element-added"
  | "element-removed"
  | "element-moved"
  | "field-added"
  | "field-removed"
  | "field-changed"
  | "from-added"
  | "from-removed"
  | "note-added"
  | "note-removed"
  | "note-changed"
  | "issue-opened"
  | "issue-resolved"
  | "issue-changed"
  | "arrow-added"
  | "arrow-removed";

/**
 * One reported change. Not every field applies to every `type` — see
 * formatEntry() for which fields each variant reads.
 */
export interface ChangeEntry {
  type: ChangeType;
  kind?: ElementKind;
  name?: string;
  sliceName?: string;
  fromSlice?: string;
  toSlice?: string;
  field?: string;
  fieldType?: string | null;
  oldType?: string | null;
  newType?: string | null;
  source?: string;
  oldNote?: string;
  newNote?: string;
  oldText?: string;
  newText?: string;
  from?: string;
  to?: string;
}

export interface DiffCounts {
  slicesAdded: number;
  slicesRemoved: number;
  elementsAdded: number;
  elementsRemoved: number;
  elementsMoved: number;
  fieldChanges: number;
  fromChanges: number;
  noteChanges: number;
  issuesOpened: number;
  issuesResolved: number;
  issuesChanged: number;
  arrowsAdded: number;
  arrowsRemoved: number;
}

export interface ModelDiff {
  /** Additions and changes, in new-file document order. */
  changes: ChangeEntry[];
  /** Removals, in old-file document order. */
  removals: ChangeEntry[];
  counts: DiffCounts;
}

function emptyCounts(): DiffCounts {
  return {
    slicesAdded: 0,
    slicesRemoved: 0,
    elementsAdded: 0,
    elementsRemoved: 0,
    elementsMoved: 0,
    fieldChanges: 0,
    fromChanges: 0,
    noteChanges: 0,
    issuesOpened: 0,
    issuesResolved: 0,
    issuesChanged: 0,
    arrowsAdded: 0,
    arrowsRemoved: 0,
  };
}

interface RefEntry {
  el: Element;
  sliceKey: string;
  sliceName: string;
}

const arrowKey = (from: string, to: string): string => `${normalizeName(from)}->${normalizeName(to)}`;

export function diffModels(oldModel: NormalizedModel, newModel: NormalizedModel): ModelDiff {
  const oldRefs = computeRefs(oldModel);
  const newRefs = computeRefs(newModel);

  const oldSliceKeySet = new Set(oldRefs.sliceKeys);
  const newSliceKeySet = new Set(newRefs.sliceKeys);

  // Whole-model ref indexes (not just surviving slices) — move detection and
  // matched-pair diffing both need to see every element on both sides.
  const oldElByRef = new Map<string, RefEntry>();
  oldModel.slices.forEach((slice, i) => {
    const sliceKey = oldRefs.sliceKeys[i];
    for (const el of slice.elements) {
      oldElByRef.set(oldRefs.refById.get(el.id)!, { el, sliceKey, sliceName: slice.name });
    }
  });
  const newElByRef = new Map<string, RefEntry>();
  newModel.slices.forEach((slice, i) => {
    const sliceKey = newRefs.sliceKeys[i];
    for (const el of slice.elements) {
      newElByRef.set(newRefs.refById.get(el.id)!, { el, sliceKey, sliceName: slice.name });
    }
  });

  // Move detection: pair up refs that only exist on one side, by (kind,
  // normalized name). Queue removed candidates in old document order; drain
  // the queue as matching added candidates are found in new document order,
  // so a move always lands on the *first* still-unmatched same-name origin.
  const removedQueue = new Map<string, (RefEntry & { ref: string })[]>();
  for (const [ref, entry] of oldElByRef) {
    if (newElByRef.has(ref)) continue;
    const key = `${entry.el.kind}::${normalizeName(entry.el.name)}`;
    const bucket = removedQueue.get(key);
    if (bucket) bucket.push({ ...entry, ref });
    else removedQueue.set(key, [{ ...entry, ref }]);
  }
  const movedOldRefs = new Set<string>();
  const movedNewRefs = new Map<string, { fromSlice: string }>();
  // Walk new-model elements in document order so the pairing itself is deterministic.
  newModel.slices.forEach((slice) => {
    for (const el of slice.elements) {
      const ref = newRefs.refById.get(el.id)!;
      if (oldElByRef.has(ref)) continue;
      const key = `${el.kind}::${normalizeName(el.name)}`;
      const bucket = removedQueue.get(key);
      if (bucket && bucket.length > 0) {
        const origin = bucket.shift()!;
        movedOldRefs.add(origin.ref);
        movedNewRefs.set(ref, { fromSlice: origin.sliceName });
      }
    }
  });

  const changes: ChangeEntry[] = [];
  const removals: ChangeEntry[] = [];
  const counts = emptyCounts();

  // --- additions/changes, in new-file document order ---
  newModel.slices.forEach((slice, i) => {
    const sliceKey = newRefs.sliceKeys[i];
    const sliceIsNew = !oldSliceKeySet.has(sliceKey);
    if (sliceIsNew) {
      changes.push({ type: "slice-added", name: slice.name });
      counts.slicesAdded++;
    }
    for (const el of slice.elements) {
      const ref = newRefs.refById.get(el.id)!;
      const oldEntry = oldElByRef.get(ref);
      if (oldEntry) {
        pushElementChanges(changes, counts, oldEntry.el, el, slice.name);
        continue;
      }
      const moved = movedNewRefs.get(ref);
      if (moved) {
        changes.push({
          type: "element-moved",
          kind: el.kind,
          name: el.name,
          fromSlice: moved.fromSlice,
          toSlice: slice.name,
        });
        counts.elementsMoved++;
      } else if (!sliceIsNew) {
        // A genuinely new element in a slice that already existed. (A new
        // element inside a brand-new slice is implied by "+ slice" above —
        // element add/remove reporting is scoped to surviving slices.)
        changes.push({ type: "element-added", kind: el.kind, name: el.name, sliceName: slice.name });
        counts.elementsAdded++;
      }
    }
  });

  for (const a of newModel.arrows) {
    const key = arrowKey(a.from, a.to);
    if (!oldModel.arrows.some((oa) => arrowKey(oa.from, oa.to) === key)) {
      changes.push({ type: "arrow-added", from: a.from, to: a.to });
      counts.arrowsAdded++;
    }
  }

  // --- removals, in old-file document order ---
  oldModel.slices.forEach((slice, i) => {
    const sliceKey = oldRefs.sliceKeys[i];
    const sliceIsRemoved = !newSliceKeySet.has(sliceKey);
    if (sliceIsRemoved) {
      removals.push({ type: "slice-removed", name: slice.name });
      counts.slicesRemoved++;
    }
    for (const el of slice.elements) {
      const ref = oldRefs.refById.get(el.id)!;
      if (newElByRef.has(ref)) continue; // matched pair, already diffed above
      if (movedOldRefs.has(ref)) continue; // reported as "moved:" already
      if (!sliceIsRemoved) {
        removals.push({ type: "element-removed", kind: el.kind, name: el.name, sliceName: slice.name });
        counts.elementsRemoved++;
      }
    }
  });

  for (const a of oldModel.arrows) {
    const key = arrowKey(a.from, a.to);
    if (!newModel.arrows.some((na) => arrowKey(na.from, na.to) === key)) {
      removals.push({ type: "arrow-removed", from: a.from, to: a.to });
      counts.arrowsRemoved++;
    }
  }

  return { changes, removals, counts };
}

/** Diff field/from/note/issue changes for an element present on both sides (same ref). */
function pushElementChanges(
  changes: ChangeEntry[],
  counts: DiffCounts,
  oldEl: Element,
  newEl: Element,
  sliceName: string,
): void {
  const oldFields = new Map((oldEl.fields ?? []).map((f) => [normalizeName(f.name), f]));
  const newFields = new Map((newEl.fields ?? []).map((f) => [normalizeName(f.name), f]));

  for (const [key, f] of newFields) {
    if (!oldFields.has(key)) {
      changes.push({
        type: "field-added",
        kind: newEl.kind,
        name: newEl.name,
        sliceName,
        field: f.name,
        fieldType: f.type ?? null,
      });
      counts.fieldChanges++;
    }
  }
  for (const [key, f] of oldFields) {
    if (!newFields.has(key)) {
      changes.push({
        type: "field-removed",
        kind: newEl.kind,
        name: newEl.name,
        sliceName,
        field: f.name,
        fieldType: f.type ?? null,
      });
      counts.fieldChanges++;
    }
  }
  for (const [key, newF] of newFields) {
    const oldF = oldFields.get(key);
    if (oldF && (oldF.type ?? null) !== (newF.type ?? null)) {
      changes.push({
        type: "field-changed",
        kind: newEl.kind,
        name: newEl.name,
        sliceName,
        field: newF.name,
        oldType: oldF.type ?? null,
        newType: newF.type ?? null,
      });
      counts.fieldChanges++;
    }
  }

  const oldFrom = oldEl.from ?? [];
  const newFrom = newEl.from ?? [];
  const oldFromSet = new Set(oldFrom.map(normalizeName));
  const newFromSet = new Set(newFrom.map(normalizeName));
  for (const n of newFrom) {
    if (!oldFromSet.has(normalizeName(n))) {
      changes.push({ type: "from-added", kind: newEl.kind, name: newEl.name, sliceName, source: n });
      counts.fromChanges++;
    }
  }
  for (const n of oldFrom) {
    if (!newFromSet.has(normalizeName(n))) {
      changes.push({ type: "from-removed", kind: newEl.kind, name: newEl.name, sliceName, source: n });
      counts.fromChanges++;
    }
  }

  if (oldEl.note !== newEl.note) {
    if (!oldEl.note && newEl.note) {
      changes.push({ type: "note-added", kind: newEl.kind, name: newEl.name, sliceName, newNote: newEl.note });
    } else if (oldEl.note && !newEl.note) {
      changes.push({ type: "note-removed", kind: newEl.kind, name: newEl.name, sliceName, oldNote: oldEl.note });
    } else {
      changes.push({
        type: "note-changed",
        kind: newEl.kind,
        name: newEl.name,
        sliceName,
        oldNote: oldEl.note,
        newNote: newEl.note,
      });
    }
    counts.noteChanges++;
  }

  // Issue lifecycle: opened / resolved / text changed. Resolved is good
  // news for the intent-capture angle — surfaced with its own positive tag,
  // not lumped in as a generic "removed".
  if (oldEl.issue !== newEl.issue) {
    if (!oldEl.issue && newEl.issue) {
      changes.push({ type: "issue-opened", kind: newEl.kind, name: newEl.name, sliceName, newText: newEl.issue });
      counts.issuesOpened++;
    } else if (oldEl.issue && !newEl.issue) {
      changes.push({ type: "issue-resolved", kind: newEl.kind, name: newEl.name, sliceName, oldText: oldEl.issue });
      counts.issuesResolved++;
    } else {
      changes.push({
        type: "issue-changed",
        kind: newEl.kind,
        name: newEl.name,
        sliceName,
        oldText: oldEl.issue,
        newText: newEl.issue,
      });
      counts.issuesChanged++;
    }
  }
}

export function hasChanges(diff: ModelDiff): boolean {
  return diff.changes.length > 0 || diff.removals.length > 0;
}

/** One-line rollup, e.g. "2 slices added, 1 element moved, 1 issue resolved, 3 field changes". */
function formatSummary(c: DiffCounts): string {
  const parts: string[] = [];
  const push = (n: number, singular: string, plural: string) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? singular : plural}`);
  };
  push(c.slicesAdded, "slice added", "slices added");
  push(c.slicesRemoved, "slice removed", "slices removed");
  push(c.elementsAdded, "element added", "elements added");
  push(c.elementsRemoved, "element removed", "elements removed");
  push(c.elementsMoved, "element moved", "elements moved");
  push(c.fieldChanges, "field change", "field changes");
  push(c.fromChanges, "from change", "from changes");
  push(c.noteChanges, "note change", "note changes");
  push(c.issuesOpened, "issue opened", "issues opened");
  push(c.issuesResolved, "issue resolved", "issues resolved");
  push(c.issuesChanged, "issue text change", "issue text changes");
  push(c.arrowsAdded, "arrow added", "arrows added");
  push(c.arrowsRemoved, "arrow removed", "arrows removed");
  return parts.length === 0 ? "no structural changes" : parts.join(", ");
}

function typeLabel(t: string | null | undefined): string {
  return t ?? "(untyped)";
}

function formatEntry(e: ChangeEntry): string {
  switch (e.type) {
    case "slice-added":
      return `+ slice "${e.name}"`;
    case "slice-removed":
      return `- slice "${e.name}"`;
    case "element-added":
      return `+ ${e.kind} "${e.name}" (slice "${e.sliceName}")`;
    case "element-removed":
      return `- ${e.kind} "${e.name}" (slice "${e.sliceName}")`;
    case "element-moved":
      return `moved: ${e.kind} "${e.name}" (slice "${e.fromSlice}" -> slice "${e.toSlice}")`;
    case "field-added":
      return `~ field "${e.field}"${e.fieldType ? `: ${e.fieldType}` : ""} added to ${e.kind} "${e.name}" (slice "${e.sliceName}")`;
    case "field-removed":
      return `~ field "${e.field}"${e.fieldType ? `: ${e.fieldType}` : ""} removed from ${e.kind} "${e.name}" (slice "${e.sliceName}")`;
    case "field-changed":
      return `~ field "${e.field}" type changed on ${e.kind} "${e.name}" (slice "${e.sliceName}"): ${typeLabel(e.oldType)} -> ${typeLabel(e.newType)}`;
    case "from-added":
      return `~ from "${e.source}" added on ${e.kind} "${e.name}" (slice "${e.sliceName}")`;
    case "from-removed":
      return `~ from "${e.source}" removed from ${e.kind} "${e.name}" (slice "${e.sliceName}")`;
    case "note-added":
      return `~ note added on ${e.kind} "${e.name}" (slice "${e.sliceName}"): "${e.newNote}"`;
    case "note-removed":
      return `~ note removed from ${e.kind} "${e.name}" (slice "${e.sliceName}"): "${e.oldNote}"`;
    case "note-changed":
      return `~ note changed on ${e.kind} "${e.name}" (slice "${e.sliceName}"): "${e.oldNote}" -> "${e.newNote}"`;
    case "issue-opened":
      return `issue opened: ${e.kind} "${e.name}" (slice "${e.sliceName}"): "${e.newText}"`;
    case "issue-resolved":
      return `issue resolved: ${e.kind} "${e.name}" (slice "${e.sliceName}"): "${e.oldText}"`;
    case "issue-changed":
      return `issue text changed: ${e.kind} "${e.name}" (slice "${e.sliceName}"): "${e.oldText}" -> "${e.newText}"`;
    case "arrow-added":
      return `+ arrow "${e.from}" -> "${e.to}"`;
    case "arrow-removed":
      return `- arrow "${e.from}" -> "${e.to}"`;
  }
}

/** Full `em diff` report: rollup line + blank + one line per change, or just "no structural changes". */
export function formatModelDiff(diff: ModelDiff): string {
  const lines = [...diff.changes.map(formatEntry), ...diff.removals.map(formatEntry)];
  if (lines.length === 0) return "no structural changes";
  return [formatSummary(diff.counts), "", ...lines].join("\n");
}
