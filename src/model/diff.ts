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
import { Element, NormalizedModel, Slice, TypeDecl, normalizeName } from "./model.js";
import { ElementKind } from "../parser/ast.js";

export type ChangeType =
  | "slice-added"
  | "slice-removed"
  | "source-added"
  | "source-removed"
  | "source-changed"
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
  | "event-marked-public"
  | "event-unmarked-public"
  | "arrow-added"
  | "arrow-removed"
  | "type-added"
  | "type-removed"
  | "type-field-added"
  | "type-field-removed"
  | "type-field-changed";

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
  oldSource?: string;
  newSource?: string;
  oldNote?: string;
  newNote?: string;
  oldText?: string;
  newText?: string;
  from?: string;
  to?: string;
  /**
   * The canonical (old-side) element's `divergence` annotation, when this change/removal
   * involves an element that carries one — not a suppression, a citation: the finding is
   * still reported in full, annotated with the reasoned, ratified deviation a consumer (e.g.
   * the conform loop) can use to classify it as accepted rather than real drift. `null` when
   * the involved element (if any) carries no annotation, or when the change type has no
   * single canonical-side element to check (`slice-added/removed`, `arrow-added/removed`,
   * `element-added`, `element-moved` — out of scope for v1, see model.ts's `divergence` doc).
   */
  acceptedDivergence?: string | null;
}

export interface DiffCounts {
  slicesAdded: number;
  slicesRemoved: number;
  sourceChanges: number;
  elementsAdded: number;
  elementsRemoved: number;
  elementsMoved: number;
  fieldChanges: number;
  fromChanges: number;
  noteChanges: number;
  issuesOpened: number;
  issuesResolved: number;
  issuesChanged: number;
  eventsMarkedPublic: number;
  eventsUnmarkedPublic: number;
  arrowsAdded: number;
  arrowsRemoved: number;
  /** Changes/removals whose `acceptedDivergence` is non-null — cited, not subtracted, from
   *  the other counts above (an element-removed with an accepted divergence still counts
   *  toward `elementsRemoved` too; this is a cross-cutting tally, not a separate bucket). */
  acceptedDivergences: number;
  /** Declared `type` (MIL-64) additions/removals and field changes on surviving types. No
   *  move detection — types aren't slice-scoped, so there's nothing to move between. */
  typesAdded: number;
  typesRemoved: number;
  typeFieldChanges: number;
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
    sourceChanges: 0,
    elementsAdded: 0,
    elementsRemoved: 0,
    elementsMoved: 0,
    fieldChanges: 0,
    fromChanges: 0,
    noteChanges: 0,
    issuesOpened: 0,
    issuesResolved: 0,
    issuesChanged: 0,
    eventsMarkedPublic: 0,
    eventsUnmarkedPublic: 0,
    arrowsAdded: 0,
    arrowsRemoved: 0,
    acceptedDivergences: 0,
    typesAdded: 0,
    typesRemoved: 0,
    typeFieldChanges: 0,
  };
}

/** Push `acceptedDivergence` onto an entry and tally it, when the canonical element carries one. */
function annotate(entry: ChangeEntry, counts: DiffCounts, divergence: string | undefined): ChangeEntry {
  entry.acceptedDivergence = divergence ?? null;
  if (divergence) counts.acceptedDivergences++;
  return entry;
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

  // Slice key -> old Slice, for diffing `source` on slices that survive
  // (i.e. aren't themselves added/removed) between the two models.
  const oldSliceByKey = new Map<string, Slice>();
  oldModel.slices.forEach((slice, i) => {
    oldSliceByKey.set(oldRefs.sliceKeys[i], slice);
  });

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
  newModel.slices.forEach((slice, i) => {
    const targetIsNew = !oldSliceKeySet.has(newRefs.sliceKeys[i]);
    for (const el of slice.elements) {
      const ref = newRefs.refById.get(el.id)!;
      if (oldElByRef.has(ref)) continue;
      const key = `${el.kind}::${normalizeName(el.name)}`;
      const bucket = removedQueue.get(key);
      if (bucket && bucket.length > 0) {
        const origin = bucket.shift()!;
        // A slice rename changes every element's ref (the ref embeds the slice
        // key), so each element pairs up as a "move" from the old slice name to
        // the new one. That's noise: the slice add/remove lines already tell the
        // story. Suppress the per-element move when its origin slice was removed
        // AND its target slice is new (the rename signature) — mark the origin as
        // "moved" so the removal pass stays quiet, but don't record a move line
        // (and, since the target slice is new, the additions pass won't enumerate
        // it as an add either). Genuine moves — into a new slice from a surviving
        // origin, or from a removed slice into a surviving target — still report.
        const originRemoved = !newSliceKeySet.has(origin.sliceKey);
        movedOldRefs.add(origin.ref);
        if (!(targetIsNew && originRemoved)) {
          movedNewRefs.set(ref, { fromSlice: origin.sliceName });
        }
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
    } else {
      pushSliceChanges(changes, counts, oldSliceByKey.get(sliceKey)!, slice);
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
        removals.push(
          annotate(
            { type: "element-removed", kind: el.kind, name: el.name, sliceName: slice.name },
            counts,
            el.divergence,
          ),
        );
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

  // --- declared types (MIL-64): identity is export ref, same as elements — no slice
  // scoping and no move detection (types aren't slice-scoped, so there's nothing to move
  // between). A rename reads as remove+add, same convention as elements.
  const oldTypeByRef = new Map<string, TypeDecl>();
  oldModel.types.forEach((t, i) => oldTypeByRef.set(oldRefs.refByTypeId.get(t.id) ?? String(i), t));
  const newTypeByRef = new Map<string, TypeDecl>();
  newModel.types.forEach((t, i) => newTypeByRef.set(newRefs.refByTypeId.get(t.id) ?? String(i), t));

  for (const t of newModel.types) {
    const ref = newRefs.refByTypeId.get(t.id)!;
    const oldType = oldTypeByRef.get(ref);
    if (oldType) {
      pushTypeFieldChanges(changes, counts, oldType, t);
    } else {
      changes.push({ type: "type-added", name: t.name });
      counts.typesAdded++;
    }
  }
  for (const t of oldModel.types) {
    const ref = oldRefs.refByTypeId.get(t.id)!;
    if (newTypeByRef.has(ref)) continue; // matched pair, already diffed above
    removals.push({ type: "type-removed", name: t.name });
    counts.typesRemoved++;
  }

  return { changes, removals, counts };
}

/** Diff a surviving slice's `source` clause (added/removed/changed), same lifecycle shape as note. */
function pushSliceChanges(
  changes: ChangeEntry[],
  counts: DiffCounts,
  oldSlice: Slice,
  newSlice: Slice,
): void {
  if (oldSlice.source === newSlice.source) return;
  if (!oldSlice.source && newSlice.source) {
    changes.push({ type: "source-added", sliceName: newSlice.name, newSource: newSlice.source });
  } else if (oldSlice.source && !newSlice.source) {
    changes.push({ type: "source-removed", sliceName: newSlice.name, oldSource: oldSlice.source });
  } else {
    changes.push({
      type: "source-changed",
      sliceName: newSlice.name,
      oldSource: oldSlice.source,
      newSource: newSlice.source,
    });
  }
  counts.sourceChanges++;
}

/** Diff a declared type's own fields for a type present on both sides (same ref) — a fields-
 *  only subset of `pushElementChanges()` below, since a `type` declaration has no slice, from,
 *  note, issue, public, or divergence dimension to diff. */
function pushTypeFieldChanges(
  changes: ChangeEntry[],
  counts: DiffCounts,
  oldType: TypeDecl,
  newType: TypeDecl,
): void {
  const oldFields = new Map(oldType.fields.map((f) => [normalizeName(f.name), f]));
  const newFields = new Map(newType.fields.map((f) => [normalizeName(f.name), f]));

  for (const [key, f] of newFields) {
    if (!oldFields.has(key)) {
      changes.push({ type: "type-field-added", name: newType.name, field: f.name, fieldType: f.type ?? null });
      counts.typeFieldChanges++;
    }
  }
  for (const [key, f] of oldFields) {
    if (!newFields.has(key)) {
      changes.push({ type: "type-field-removed", name: newType.name, field: f.name, fieldType: f.type ?? null });
      counts.typeFieldChanges++;
    }
  }
  for (const [key, newF] of newFields) {
    const oldF = oldFields.get(key);
    if (oldF && (oldF.type ?? null) !== (newF.type ?? null)) {
      changes.push({
        type: "type-field-changed",
        name: newType.name,
        field: newF.name,
        oldType: oldF.type ?? null,
        newType: newF.type ?? null,
      });
      counts.typeFieldChanges++;
    }
  }
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

  // Every entry below reports on `oldEl`/`newEl` — the same matched-pair element on both
  // sides — so any of them may carry the canonical (`oldEl`) side's accepted-divergence
  // annotation, cited via `annotate()` alongside the finding, not in place of it.
  const div = oldEl.divergence;

  for (const [key, f] of newFields) {
    if (!oldFields.has(key)) {
      changes.push(
        annotate(
          {
            type: "field-added",
            kind: newEl.kind,
            name: newEl.name,
            sliceName,
            field: f.name,
            fieldType: f.type ?? null,
          },
          counts,
          div,
        ),
      );
      counts.fieldChanges++;
    }
  }
  for (const [key, f] of oldFields) {
    if (!newFields.has(key)) {
      changes.push(
        annotate(
          {
            type: "field-removed",
            kind: newEl.kind,
            name: newEl.name,
            sliceName,
            field: f.name,
            fieldType: f.type ?? null,
          },
          counts,
          div,
        ),
      );
      counts.fieldChanges++;
    }
  }
  for (const [key, newF] of newFields) {
    const oldF = oldFields.get(key);
    if (oldF && (oldF.type ?? null) !== (newF.type ?? null)) {
      changes.push(
        annotate(
          {
            type: "field-changed",
            kind: newEl.kind,
            name: newEl.name,
            sliceName,
            field: newF.name,
            oldType: oldF.type ?? null,
            newType: newF.type ?? null,
          },
          counts,
          div,
        ),
      );
      counts.fieldChanges++;
    }
  }

  const oldFrom = oldEl.from ?? [];
  const newFrom = newEl.from ?? [];
  const oldFromSet = new Set(oldFrom.map(normalizeName));
  const newFromSet = new Set(newFrom.map(normalizeName));
  for (const n of newFrom) {
    if (!oldFromSet.has(normalizeName(n))) {
      changes.push(annotate({ type: "from-added", kind: newEl.kind, name: newEl.name, sliceName, source: n }, counts, div));
      counts.fromChanges++;
    }
  }
  for (const n of oldFrom) {
    if (!newFromSet.has(normalizeName(n))) {
      changes.push(annotate({ type: "from-removed", kind: newEl.kind, name: newEl.name, sliceName, source: n }, counts, div));
      counts.fromChanges++;
    }
  }

  if (oldEl.note !== newEl.note) {
    if (!oldEl.note && newEl.note) {
      changes.push(
        annotate({ type: "note-added", kind: newEl.kind, name: newEl.name, sliceName, newNote: newEl.note }, counts, div),
      );
    } else if (oldEl.note && !newEl.note) {
      changes.push(
        annotate({ type: "note-removed", kind: newEl.kind, name: newEl.name, sliceName, oldNote: oldEl.note }, counts, div),
      );
    } else {
      changes.push(
        annotate(
          {
            type: "note-changed",
            kind: newEl.kind,
            name: newEl.name,
            sliceName,
            oldNote: oldEl.note,
            newNote: newEl.note,
          },
          counts,
          div,
        ),
      );
    }
    counts.noteChanges++;
  }

  // Issue lifecycle: opened / resolved / text changed. Resolved is good
  // news for the intent-capture angle — surfaced with its own positive tag,
  // not lumped in as a generic "removed".
  if (oldEl.issue !== newEl.issue) {
    if (!oldEl.issue && newEl.issue) {
      changes.push(
        annotate({ type: "issue-opened", kind: newEl.kind, name: newEl.name, sliceName, newText: newEl.issue }, counts, div),
      );
      counts.issuesOpened++;
    } else if (oldEl.issue && !newEl.issue) {
      changes.push(
        annotate({ type: "issue-resolved", kind: newEl.kind, name: newEl.name, sliceName, oldText: oldEl.issue }, counts, div),
      );
      counts.issuesResolved++;
    } else {
      changes.push(
        annotate(
          {
            type: "issue-changed",
            kind: newEl.kind,
            name: newEl.name,
            sliceName,
            oldText: oldEl.issue,
            newText: newEl.issue,
          },
          counts,
          div,
        ),
      );
      counts.issuesChanged++;
    }
  }

  // Integration-surface promotion/demotion: only ever set for `event` elements
  // (parse-gated), but checked the same generic way as the other lifecycle
  // fields above — no kind special-casing needed.
  if (oldEl.public !== newEl.public) {
    if (newEl.public) {
      changes.push({ type: "event-marked-public", kind: newEl.kind, name: newEl.name, sliceName });
      counts.eventsMarkedPublic++;
    } else {
      changes.push({ type: "event-unmarked-public", kind: newEl.kind, name: newEl.name, sliceName });
      counts.eventsUnmarkedPublic++;
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
  push(c.sourceChanges, "source change", "source changes");
  push(c.elementsAdded, "element added", "elements added");
  push(c.elementsRemoved, "element removed", "elements removed");
  push(c.elementsMoved, "element moved", "elements moved");
  push(c.fieldChanges, "field change", "field changes");
  push(c.fromChanges, "from change", "from changes");
  push(c.noteChanges, "note change", "note changes");
  push(c.issuesOpened, "issue opened", "issues opened");
  push(c.issuesResolved, "issue resolved", "issues resolved");
  push(c.issuesChanged, "issue text change", "issue text changes");
  push(c.eventsMarkedPublic, "event marked public", "events marked public");
  push(c.eventsUnmarkedPublic, "event unmarked public", "events unmarked public");
  push(c.arrowsAdded, "arrow added", "arrows added");
  push(c.arrowsRemoved, "arrow removed", "arrows removed");
  push(c.typesAdded, "type added", "types added");
  push(c.typesRemoved, "type removed", "types removed");
  push(c.typeFieldChanges, "type field change", "type field changes");
  push(c.acceptedDivergences, "accepted divergence", "accepted divergences");
  return parts.length === 0 ? "no structural changes" : parts.join(", ");
}

function typeLabel(t: string | null | undefined): string {
  return t ?? "(untyped)";
}

/** Appended to a formatted line when the entry cites a canonical `divergence` annotation. */
function divergenceSuffix(e: ChangeEntry): string {
  return e.acceptedDivergence ? ` [accepted divergence: "${e.acceptedDivergence}"]` : "";
}

function formatEntry(e: ChangeEntry): string {
  switch (e.type) {
    case "slice-added":
      return `+ slice "${e.name}"`;
    case "slice-removed":
      return `- slice "${e.name}"`;
    case "source-added":
      return `~ source added on slice "${e.sliceName}": "${e.newSource}"`;
    case "source-removed":
      return `~ source removed from slice "${e.sliceName}": "${e.oldSource}"`;
    case "source-changed":
      return `~ source changed on slice "${e.sliceName}": "${e.oldSource}" -> "${e.newSource}"`;
    case "element-added":
      return `+ ${e.kind} "${e.name}" (slice "${e.sliceName}")`;
    case "element-removed":
      return `- ${e.kind} "${e.name}" (slice "${e.sliceName}")${divergenceSuffix(e)}`;
    case "element-moved":
      return `moved: ${e.kind} "${e.name}" (slice "${e.fromSlice}" -> slice "${e.toSlice}")`;
    case "field-added":
      return `~ field "${e.field}"${e.fieldType ? `: ${e.fieldType}` : ""} added to ${e.kind} "${e.name}" (slice "${e.sliceName}")${divergenceSuffix(e)}`;
    case "field-removed":
      return `~ field "${e.field}"${e.fieldType ? `: ${e.fieldType}` : ""} removed from ${e.kind} "${e.name}" (slice "${e.sliceName}")${divergenceSuffix(e)}`;
    case "field-changed":
      return `~ field "${e.field}" type changed on ${e.kind} "${e.name}" (slice "${e.sliceName}"): ${typeLabel(e.oldType)} -> ${typeLabel(e.newType)}${divergenceSuffix(e)}`;
    case "from-added":
      return `~ from "${e.source}" added on ${e.kind} "${e.name}" (slice "${e.sliceName}")${divergenceSuffix(e)}`;
    case "from-removed":
      return `~ from "${e.source}" removed from ${e.kind} "${e.name}" (slice "${e.sliceName}")${divergenceSuffix(e)}`;
    case "note-added":
      return `~ note added on ${e.kind} "${e.name}" (slice "${e.sliceName}"): "${e.newNote}"${divergenceSuffix(e)}`;
    case "note-removed":
      return `~ note removed from ${e.kind} "${e.name}" (slice "${e.sliceName}"): "${e.oldNote}"${divergenceSuffix(e)}`;
    case "note-changed":
      return `~ note changed on ${e.kind} "${e.name}" (slice "${e.sliceName}"): "${e.oldNote}" -> "${e.newNote}"${divergenceSuffix(e)}`;
    case "issue-opened":
      return `issue opened: ${e.kind} "${e.name}" (slice "${e.sliceName}"): "${e.newText}"${divergenceSuffix(e)}`;
    case "issue-resolved":
      return `issue resolved: ${e.kind} "${e.name}" (slice "${e.sliceName}"): "${e.oldText}"${divergenceSuffix(e)}`;
    case "issue-changed":
      return `issue text changed: ${e.kind} "${e.name}" (slice "${e.sliceName}"): "${e.oldText}" -> "${e.newText}"${divergenceSuffix(e)}`;
    case "event-marked-public":
      return `event marked public: ${e.kind} "${e.name}" (slice "${e.sliceName}")`;
    case "event-unmarked-public":
      return `event unmarked public: ${e.kind} "${e.name}" (slice "${e.sliceName}")`;
    case "arrow-added":
      return `+ arrow "${e.from}" -> "${e.to}"`;
    case "arrow-removed":
      return `- arrow "${e.from}" -> "${e.to}"`;
    case "type-added":
      return `+ type "${e.name}"`;
    case "type-removed":
      return `- type "${e.name}"`;
    case "type-field-added":
      return `~ field "${e.field}"${e.fieldType ? `: ${e.fieldType}` : ""} added to type "${e.name}"`;
    case "type-field-removed":
      return `~ field "${e.field}"${e.fieldType ? `: ${e.fieldType}` : ""} removed from type "${e.name}"`;
    case "type-field-changed":
      return `~ field "${e.field}" type changed on type "${e.name}": ${typeLabel(e.oldType)} -> ${typeLabel(e.newType)}`;
  }
}

/** Full `em diff` report: rollup line + blank + one line per change, or just "no structural changes". */
export function formatModelDiff(diff: ModelDiff): string {
  const lines = [...diff.changes.map(formatEntry), ...diff.removals.map(formatEntry)];
  if (lines.length === 0) return "no structural changes";
  return [formatSummary(diff.counts), "", ...lines].join("\n");
}
