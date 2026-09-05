// SPDX-License-Identifier: MIT
// The single declarative registry of every diagnostic `code` `em validate` (and its fs-aware
// siblings in src/catalog/) can emit — severity, a short human title, a static "fix" hint, and
// a usage-log category string, separate from the dynamic per-instance `message` each call site
// still writes inline (MIL-92).
//
// This exists so the skill's own reference docs can be *generated* from the same source the
// tool executes (scripts/generate-skill-docs.ts) instead of hand-copied and left to drift —
// the failure mode MIL-86 hit once already. `pushDiag`/`makeDiag` are the enforcement
// mechanism: severity is looked up here, never hand-typed a second time at the call site, so a
// code and its severity can't silently disagree, and a code used but never registered throws
// immediately rather than shipping an undocumented rule. `usageCategory` is generated into
// docs/usage-data.md's Categories tables the same way (MIL-97) — the fixed vocabulary a
// `.event-modeling.md` Usage log line picks from, so it can't drift from RULES either.
//
// `optIn: true` marks the 4 codes `em validate --slice-ready <key>` adds (MIL-87) — never part
// of a plain `em validate` run, excluded from the generated base rule reference (but still
// included in the usage-log Categories tables — a session can hit them too).

import type { Diagnostic, Severity } from "./validate.js";

export interface RuleDef {
  severity: Severity;
  /** Short human title for a generated table row — not the dynamic per-instance `message`. */
  title: string;
  /** Static, generation-ready fix hint (e.g. "Split them into separate slices."). */
  fix: string;
  /** Fixed-vocabulary string for a `.event-modeling.md` Usage log line (docs/usage-data.md) —
   *  lowercase, terse, log-line-friendly. Deliberately not required to match `title` verbatim:
   *  these strings predate `title` in several cases and are load-bearing in already-committed
   *  usage-log lines, so changing one silently splits one count into two in the aggregation
   *  recipe (docs/usage-data.md). Never reword an existing value for that reason. */
  usageCategory: string;
  /** docs/validation.md H3 anchor this rule nests under, when one exists and covers >1 rule. */
  docAnchor?: string;
  /** True for the 4 `--slice-ready`-only codes (src/catalog/sliceReadyValidate.ts, MIL-87). */
  optIn?: true;
}

export const RULES = {
  "grid-collision": {
    severity: "error",
    title: "Band collision",
    fix: "Split the colliding elements into separate slices.",
    usageCategory: "same-band collision",
  },
  "ui-shares-slice-with-automation": {
    severity: "warning",
    title: "`ui` shares slice with a reaction",
    fix: "Move the `ui` to the slice that displays the read model, or drop it.",
    usageCategory: "ui shares slice with reaction",
  },
  "both-ends-of-a-flow/command-no-event": {
    severity: "warning",
    title: "Command without event",
    fix: "Add the event this command records.",
    usageCategory: "command produces no event",
    docAnchor: "both-ends-of-a-flow",
  },
  "view-no-source": {
    severity: "warning",
    title: "Read model without source",
    fix: 'Add `from "Event"`, or place the view in a slice with an event.',
    usageCategory: "read model has no source",
  },
  "view-from-unresolved": {
    severity: "error",
    title: "Unknown event source",
    fix: "Fix the `from` reference to name an existing event.",
    usageCategory: "view references unknown event",
  },
  "view-from-future-event": {
    severity: "error",
    title: "Backward timeline (view reads a future event)",
    fix: "Move the source to a later `view X again` instance.",
    usageCategory: "event feeds earlier view instance",
  },
  "fields-completeness/view-field-no-source": {
    severity: "warning",
    title: "View field with no source",
    fix: "Add the field to a source event, or remove it from the view.",
    usageCategory: "view field no source",
    docAnchor: "fields-completeness",
  },
  "fields-completeness/event-field-no-source": {
    severity: "warning",
    title: "Event field not from a command",
    fix: "Add the field to a command in the slice, or remove it from the event.",
    usageCategory: "event field not provided by command",
    docAnchor: "fields-completeness",
  },
  "reaction-from-unresolved": {
    severity: "error",
    title: "Unknown read-model source",
    fix: "Project the event into a view first, or fix the `from` reference.",
    usageCategory: "reaction references unknown read model",
  },
  "reaction-from-future-view": {
    severity: "error",
    title: "Backward timeline (reaction reads a future view)",
    fix: "Declare the view in or before the reaction's slice.",
    usageCategory: "reaction reads view before it exists",
  },
  "view-again-without-earlier": {
    severity: "error",
    title: "`again` without an earlier declaration",
    fix: "Declare the view plainly the first time it appears.",
    usageCategory: "view again with no earlier declaration",
  },
  "both-ends-of-a-flow/command-untriggered": {
    severity: "warning",
    title: "Command with no trigger",
    fix: "Add a `ui` or the reaction that issues it, both in this slice.",
    usageCategory: "command nothing triggers",
    docAnchor: "both-ends-of-a-flow",
  },
  "both-ends-of-a-flow/reaction-no-command": {
    severity: "warning",
    title: "Reaction with no command",
    fix: "Add the command it triggers, in this slice, or an explicit arrow to one.",
    usageCategory: "reaction triggers no command",
    docAnchor: "both-ends-of-a-flow",
  },
  "both-ends-of-a-flow/view-unconsumed": {
    severity: "warning",
    title: "Read model with no consumer",
    fix: "Add a `ui` or reaction that consumes it, or drop this instance.",
    usageCategory: "read model has no consumer",
    docAnchor: "both-ends-of-a-flow",
  },
  "both-ends-of-a-flow/event-unread": {
    severity: "warning",
    title: "Event nobody reads",
    fix: "Project it into a view, or reconsider recording it.",
    usageCategory: "event not read by any read model",
    docAnchor: "both-ends-of-a-flow",
  },
  "both-ends-of-a-flow/event-unproduced": {
    severity: "warning",
    title: "Event with no producing command",
    fix: "Add the command that records it, or an explicit arrow from one.",
    usageCategory: "event has no producing command",
    docAnchor: "both-ends-of-a-flow",
  },
  "both-ends-of-a-flow/ui-unbacked": {
    severity: "warning",
    title: "`ui` with no read model or command",
    fix: "Add a `view` it displays, or the command it triggers.",
    usageCategory: "ui with no view or command",
    docAnchor: "both-ends-of-a-flow",
  },
  "arrow-backward": {
    severity: "error",
    title: "Backward arrow",
    fix: "Restructure so the target comes later.",
    usageCategory: "arrow points backward",
  },
  "connection-legality/illegal-pair": {
    severity: "error",
    title: "Illegal connection",
    fix: "Only ui→command→event→view→ui and view→reaction→command are legal — the message names the missing step.",
    usageCategory: "illegal connection",
    docAnchor: "connection-legality",
  },
  "arrow-unresolved-source": {
    severity: "error",
    title: "Arrow source unresolved",
    fix: "Fix the arrow's source name.",
    usageCategory: "arrow endpoint unresolved",
  },
  "arrow-unresolved-target": {
    severity: "error",
    title: "Arrow target unresolved",
    fix: "Fix the arrow's target name.",
    usageCategory: "arrow endpoint unresolved",
  },
  "open-issue": {
    severity: "warning",
    title: "Open issue",
    fix: "Resolve the question, then remove the `issue` clause.",
    usageCategory: "open issue",
  },
  "duplicate-name": {
    severity: "warning",
    title: "Duplicate name",
    fix: "Rename one of the duplicates.",
    usageCategory: "duplicate name referenced",
  },
  "translation-name-collision": {
    severity: "warning",
    title: "Translation name reused for different producers",
    fix: "Use a distinct name per producer to avoid confusion.",
    usageCategory: "translation name collision",
  },
  "duplicate-type-name": {
    severity: "warning",
    title: "Duplicate type name",
    fix: "Rename one of the duplicate `type` declarations.",
    usageCategory: "duplicate type name",
  },
  "tag-composite-unknown-field": {
    severity: "error",
    title: "Composite tag names an unknown field",
    fix: "Fix the field name, or add it to the event's fields.",
    usageCategory: "composite tag references unknown field",
  },
  "tag-duplicate-key": {
    severity: "error",
    title: "Duplicate tag key",
    fix: "Rename one of the tags so every key on the event is unique.",
    usageCategory: "duplicate tag key",
  },
  "type-cycle": {
    severity: "error",
    title: "Cyclic type reference",
    fix: "Break the cycle, or route the self/mutual reference through an array.",
    usageCategory: "type cycle",
  },
  "lineage-ref-malformed": {
    severity: "error",
    title: "Malformed lineage ref",
    fix: "Fix the value to `<slice-key>@v<N>`, or remove it.",
    usageCategory: "lineage ref malformed",
    docAnchor: "lineage",
  },
  "lineage-ref-cycle": {
    severity: "error",
    title: "Lineage cycle",
    fix: "Break the cycle — a slice can't be its own ancestor.",
    usageCategory: "lineage ref cycle",
    docAnchor: "lineage",
  },
  "lineage-forward-dangling": {
    severity: "error",
    title: "Dangling forward lineage ref",
    fix: "Fix the key, or remove the stale successor.",
    usageCategory: "lineage forward dangling",
    docAnchor: "lineage",
  },
  "lineage-version-impossible": {
    severity: "error",
    title: "Impossible lineage version",
    fix: "Fix the referenced version, or ratify the target slice first.",
    usageCategory: "lineage version impossible",
    docAnchor: "lineage",
  },
  "frontmatter-coherence-implemented-without-link": {
    severity: "warning",
    title: "Implemented without a link",
    fix: "Add `implementedIn` once the slice ships.",
    usageCategory: "implemented without link",
    docAnchor: "frontmatter-coherence",
  },
  "binding-missing-file": {
    severity: "warning",
    title: "Doc binding points at a missing file",
    fix: "Create the slice doc, or fix the `note` path.",
    usageCategory: "doc binding points at missing file",
  },
  "frontmatter-invalid": {
    severity: "warning",
    title: "Invalid or missing frontmatter",
    fix: "Add the required frontmatter keys, or add a frontmatter block.",
    usageCategory: "invalid or missing frontmatter",
  },
  "note-binding-extra": {
    severity: "warning",
    title: "Extra doc-binding note, ignored",
    fix: "Remove the note, or point it at the slice's actual bound doc.",
    usageCategory: "extra doc-binding note ignored",
    docAnchor: "note-binding-mismatch",
  },
  "note-binding-dangling": {
    severity: "warning",
    title: "Dangling cross-slice note",
    fix: "Create the doc at that path, or fix/remove the note.",
    usageCategory: "cross-slice note points nowhere",
    docAnchor: "note-binding-mismatch",
  },
  "note-binding-unusable": {
    severity: "warning",
    title: "Cross-slice note to a doc with unusable frontmatter",
    fix: "Fix that doc's frontmatter, or fix/remove the note.",
    usageCategory: "cross-slice note targets unusable doc",
    docAnchor: "note-binding-mismatch",
  },
  "note-binding-unratified": {
    severity: "warning",
    title: "Unratified cross-slice note",
    fix: "Add `covers: <this-slice-key>` to that doc's frontmatter, or correct the note's path.",
    usageCategory: "cross-slice note not ratified by target doc",
    docAnchor: "note-binding-mismatch",
  },
  "doc-model-pattern-mismatch": {
    severity: "warning",
    title: "Doc/model pattern mismatch",
    fix: "Fix the doc's `pattern:` frontmatter to match the model, or restructure the slice to match the doc.",
    usageCategory: "doc pattern disagrees with model",
    docAnchor: "doc-model-consistency",
  },
  "doc-model-element-not-in-model": {
    severity: "warning",
    title: "Doc names an element the model doesn't have",
    fix: "Add the element to the model, or fix/remove it in the doc.",
    usageCategory: "doc element missing from model",
    docAnchor: "doc-model-consistency",
  },
  "doc-model-element-not-in-doc": {
    severity: "warning",
    title: "Model element the doc doesn't mention",
    fix: "Add the matching marker to the doc, or remove the element from the model.",
    usageCategory: "model element missing from doc",
    docAnchor: "doc-model-consistency",
  },
  "doc-model-field-mismatch": {
    severity: "warning",
    title: "Doc/model field mismatch",
    fix: "Reconcile the field table with the model's fields — names and types.",
    usageCategory: "doc field table disagrees with model",
    docAnchor: "doc-model-consistency",
  },
  "orphaned-slice-doc": {
    severity: "warning",
    title: "Orphaned slice doc",
    fix: "Rename it to a current slice's key, add `covers:` (plus a `note` binding) to attach it to a live slice, or delete it.",
    usageCategory: "orphaned slice doc left behind by a rename or removal",
    docAnchor: "orphaned-slice-doc",
  },
  "duplicate-slice-name": {
    severity: "warning",
    title: "Duplicate slice name",
    fix: "Rename the slice so its export key is unique.",
    usageCategory: "duplicate slice name",
  },
  "duplicate-element-ref": {
    severity: "warning",
    title: "Duplicate element ref",
    fix: "Rename the element so its export ref is unique.",
    usageCategory: "duplicate element ref",
  },
  "duplicate-type-ref": {
    severity: "warning",
    title: "Duplicate type ref",
    fix: "Rename the type so its export ref is unique.",
    usageCategory: "duplicate type ref",
  },
  // MIL-193: two models in one multi-model invocation whose model keys (kebab-slugged declared
  // names, model/qualifiedRef.ts) collide — the later one takes a `~n` suffix, exactly as
  // `duplicate-slice-name` handles a slice-key collision. Raised by computeModelKeys(), which
  // only ever runs where more than one model is in play (`em query`, MIL-194's `em system`);
  // a single-model compile can never see it.
  "duplicate-model-key": {
    severity: "warning",
    title: "Duplicate model key",
    fix: "Give each model a unique `model \"Name\"` so its key (and every cross-model ref) is stable.",
    usageCategory: "duplicate model key",
  },
  // MIL-160: two input models sharing a directory (so both resolve slice docs at
  // `<that-directory>/slices/<key>.md`) whose compiled slice keys overlap — nothing before this
  // caught it, since computeRefs() dedupes slice keys only within one model's own compile. Raised
  // by src/catalog/modelCollisionValidate.ts, the only cross-model check in the codebase — every
  // other rule is a single-model concern, so this one lives outside model/validate.ts's pipeline
  // and is instead wired directly into the two commands that ever compile more than one model in
  // the same run (`em status`, `em catalog`).
  "cross-model-slice-doc-collision": {
    severity: "warning",
    title: "Colliding slice doc path across models",
    fix: "Give each model its own directory (see docs/cli.md, \"Multi-model projects\").",
    usageCategory: "colliding slice doc path across models",
  },
  // MIL-194: the nine codes `em system <manifest>` raises while verifying a seam manifest
  // (docs/cli.md "em system") against each model's export document — the cross-model half of
  // "both ends of a flow": every `public` event/view needs a declared reader somewhere in the
  // system, every externally-fed reaction needs a declared producer. Raised by
  // src/system/verify.ts (pure, over export JSON only — never a compiled model) and
  // src/system/manifest.ts (the manifest's own shape). Registered here, like
  // `cross-model-slice-doc-collision`, so severity/title/fix generate into the same reference
  // tables every other code does; none of them is ever raised by `em validate` itself.
  "system-manifest-invalid": {
    severity: "error",
    title: "Seam manifest invalid",
    fix: "Fix the manifest: required keys, `systemSchemaVersion: \"1.0\"`, a readable `source` per model, and only declared model keys in seam refs.",
    usageCategory: "seam manifest invalid",
    docAnchor: "seam-manifest",
  },
  "system-model-key-mismatch": {
    severity: "error",
    title: "Manifest model key differs from the export's `model.key`",
    fix: "Rename the manifest's `models:` key to the computed key the message prints.",
    usageCategory: "seam manifest model key mismatch",
    docAnchor: "seam-manifest",
  },
  "seam-endpoint-unresolved": {
    severity: "error",
    title: "Seam endpoint does not resolve",
    fix: "Fix the ref to an element the named model actually exports (`em export` lists every ref), or re-declare the seam after a rename.",
    usageCategory: "seam endpoint unresolved",
    docAnchor: "seam-manifest",
  },
  "seam-source-not-public": {
    severity: "error",
    title: "Seam source is not `public`",
    fix: "Mark the event/view `public` in its model, or point the seam at the element that is.",
    usageCategory: "seam source not public",
    docAnchor: "seam-manifest",
  },
  "seam-consumer-not-reaction": {
    severity: "error",
    title: "Seam consumer is not a reaction",
    fix: "Point `to` at a translation/automation element (or a slice containing exactly one).",
    usageCategory: "seam consumer not a reaction",
    docAnchor: "seam-manifest",
  },
  "seam-duplicate": {
    severity: "warning",
    title: "Duplicate seam",
    fix: "Remove the repeated `from`/`to` pair.",
    usageCategory: "duplicate seam",
    docAnchor: "seam-manifest",
  },
  "dangling-public-event": {
    severity: "warning",
    title: "Public event/view no seam consumes",
    fix: "Declare the seam that reads it, or drop `public` if nothing outside the model does.",
    usageCategory: "public event not consumed by any seam",
    docAnchor: "seam-manifest",
  },
  "unbound-translation": {
    severity: "warning",
    title: "Externally-fed reaction no seam feeds",
    fix: "Declare the seam whose `to` is this reaction, or give it an in-model `from`.",
    usageCategory: "externally-fed reaction not bound by any seam",
    docAnchor: "seam-manifest",
  },
  "undeclared-seam-candidate": {
    severity: "warning",
    title: "Looks connected across models, no seam declared",
    fix: "Declare the seam, or rename one side so the name match stops looking like a link.",
    usageCategory: "undeclared seam candidate",
    docAnchor: "seam-manifest",
  },
  "slice-ready-unknown-slice": {
    severity: "error",
    title: "Unknown --slice-ready key",
    fix: "Pass a valid export key that exists in this model.",
    usageCategory: "slice-ready key does not exist",
    docAnchor: "slice-readiness",
    optIn: true,
  },
  "slice-ready-no-doc-bound": {
    severity: "warning",
    title: "No doc bound",
    fix: 'Bind a slice doc via `note "slices/<key>.md"`.',
    usageCategory: "slice-ready slice has no doc bound",
    docAnchor: "slice-readiness",
    optIn: true,
  },
  "slice-ready-status-not-ready": {
    severity: "warning",
    title: "Not ready-to-implement",
    fix: "Set `status: ready-to-implement`.",
    usageCategory: "slice-ready slice not ready-to-implement",
    docAnchor: "slice-readiness",
    optIn: true,
  },
  "slice-ready-open-questions-unchecked": {
    severity: "warning",
    title: "Unchecked Open Questions",
    fix: "Check off the remaining Open Questions.",
    usageCategory: "slice-ready slice has unchecked open questions",
    docAnchor: "slice-readiness",
    optIn: true,
  },
} as const satisfies Record<string, RuleDef>;

export type RuleCode = keyof typeof RULES;

/** Build one diagnostic, severity looked up from the registry — the per-instance `message`
 *  (and optional `line`/`refs`) is all a call site supplies. Throws on an unregistered code:
 *  a typo here is a bug in the validator itself, not a model-quality finding, so it fails loud
 *  rather than shipping a diagnostic with no matching rule doc. */
export function makeDiag(code: RuleCode, extra: { message: string; line?: number; refs?: string[] }): Diagnostic {
  const rule = RULES[code];
  if (!rule) throw new Error(`makeDiag: unknown rule code "${code}" — register it in src/model/rules.ts`);
  return { severity: rule.severity, code, ...extra };
}

/** `diags.push(makeDiag(...))`, spelled as one call — the common case at every validator site. */
export function pushDiag(diags: Diagnostic[], code: RuleCode, extra: { message: string; line?: number; refs?: string[] }): void {
  diags.push(makeDiag(code, extra));
}
