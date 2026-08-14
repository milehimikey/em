// SPDX-License-Identifier: MIT
// The single declarative registry of every diagnostic `code` `em validate` (and its fs-aware
// siblings in src/catalog/) can emit — severity, a short human title, and a static "fix" hint,
// separate from the dynamic per-instance `message` each call site still writes inline (MIL-92).
//
// This exists so the skill's own reference docs can be *generated* from the same source the
// tool executes (scripts/generate-skill-docs.ts) instead of hand-copied and left to drift —
// the failure mode MIL-86 hit once already. `pushDiag`/`makeDiag` are the enforcement
// mechanism: severity is looked up here, never hand-typed a second time at the call site, so a
// code and its severity can't silently disagree, and a code used but never registered throws
// immediately rather than shipping an undocumented rule.
//
// `optIn: true` marks the 4 codes `em validate --slice-ready <key>` adds (MIL-87) — never part
// of a plain `em validate` run, excluded from the generated base rule reference.

import type { Diagnostic, Severity } from "./validate.js";

interface RuleDef {
  severity: Severity;
  /** Short human title for a generated table row — not the dynamic per-instance `message`. */
  title: string;
  /** Static, generation-ready fix hint (e.g. "Split them into separate slices."). */
  fix: string;
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
  },
  "automation-shares-slice-with-command": {
    severity: "warning",
    title: "Automation shares slice with its command",
    fix: "Put the triggered command in the next slice.",
  },
  "ui-shares-slice-with-automation": {
    severity: "warning",
    title: "`ui` shares slice with a reaction, no command",
    fix: "Move the `ui` to the read-model slice, or to the slice with the command this triggers.",
  },
  "both-ends-of-a-flow/command-no-event": {
    severity: "warning",
    title: "Command without event",
    fix: "Add the event this command records.",
    docAnchor: "both-ends-of-a-flow",
  },
  "view-no-source": {
    severity: "warning",
    title: "Read model without source",
    fix: 'Add `from "Event"`, or place the view in a slice with an event.',
  },
  "view-from-unresolved": {
    severity: "error",
    title: "Unknown event source",
    fix: "Fix the `from` reference to name an existing event.",
  },
  "view-from-future-event": {
    severity: "error",
    title: "Backward timeline (view reads a future event)",
    fix: "Move the source to a later `view X again` instance.",
  },
  "fields-completeness/view-field-no-source": {
    severity: "warning",
    title: "View field with no source",
    fix: "Add the field to a source event, or remove it from the view.",
    docAnchor: "fields-completeness",
  },
  "fields-completeness/event-field-no-source": {
    severity: "warning",
    title: "Event field not from a command",
    fix: "Add the field to a command in the slice, or remove it from the event.",
    docAnchor: "fields-completeness",
  },
  "reaction-from-unresolved": {
    severity: "error",
    title: "Unknown read-model source",
    fix: "Project the event into a view first, or fix the `from` reference.",
  },
  "reaction-from-future-view": {
    severity: "error",
    title: "Backward timeline (reaction reads a future view)",
    fix: "Declare the view in or before the reaction's slice.",
  },
  "view-again-without-earlier": {
    severity: "error",
    title: "`again` without an earlier declaration",
    fix: "Declare the view plainly the first time it appears.",
  },
  "both-ends-of-a-flow/command-untriggered": {
    severity: "warning",
    title: "Command with no trigger",
    fix: "Add a `ui` in this slice, or a reaction in the previous slice.",
    docAnchor: "both-ends-of-a-flow",
  },
  "both-ends-of-a-flow/view-unconsumed": {
    severity: "warning",
    title: "Read model with no consumer",
    fix: "Add a `ui` or reaction that consumes it, or drop this instance.",
    docAnchor: "both-ends-of-a-flow",
  },
  "both-ends-of-a-flow/event-unread": {
    severity: "warning",
    title: "Event nobody reads",
    fix: "Project it into a view, or reconsider recording it.",
    docAnchor: "both-ends-of-a-flow",
  },
  "arrow-backward": {
    severity: "error",
    title: "Backward arrow",
    fix: "Restructure so the target comes later.",
  },
  "connection-legality/illegal-pair": {
    severity: "error",
    title: "Illegal connection",
    fix: "Only ui→command→event→view→ui and view→reaction→command are legal — the message names the missing step.",
    docAnchor: "connection-legality",
  },
  "arrow-unresolved-source": {
    severity: "error",
    title: "Arrow source unresolved",
    fix: "Fix the arrow's source name.",
  },
  "arrow-unresolved-target": {
    severity: "error",
    title: "Arrow target unresolved",
    fix: "Fix the arrow's target name.",
  },
  "open-issue": {
    severity: "warning",
    title: "Open issue",
    fix: "Resolve the question, then remove the `issue` clause.",
  },
  "duplicate-name": {
    severity: "warning",
    title: "Duplicate name",
    fix: "Rename one of the duplicates.",
  },
  "duplicate-type-name": {
    severity: "warning",
    title: "Duplicate type name",
    fix: "Rename one of the duplicate `type` declarations.",
  },
  "type-cycle": {
    severity: "error",
    title: "Cyclic type reference",
    fix: "Break the cycle, or route the self/mutual reference through an array.",
  },
  "lineage-ref-malformed": {
    severity: "error",
    title: "Malformed lineage ref",
    fix: "Fix the value to `<slice-key>@v<N>`, or remove it.",
    docAnchor: "lineage",
  },
  "lineage-ref-cycle": {
    severity: "error",
    title: "Lineage cycle",
    fix: "Break the cycle — a slice can't be its own ancestor.",
    docAnchor: "lineage",
  },
  "lineage-forward-dangling": {
    severity: "error",
    title: "Dangling forward lineage ref",
    fix: "Fix the key, or remove the stale successor.",
    docAnchor: "lineage",
  },
  "lineage-version-impossible": {
    severity: "error",
    title: "Impossible lineage version",
    fix: "Fix the referenced version, or ratify the target slice first.",
    docAnchor: "lineage",
  },
  "frontmatter-coherence-implemented-without-link": {
    severity: "warning",
    title: "Implemented without a link",
    fix: "Add `implementedIn` once the slice ships.",
    docAnchor: "frontmatter-coherence",
  },
  "binding-missing-file": {
    severity: "warning",
    title: "Doc binding points at a missing file",
    fix: "Create the slice doc, or fix the `note` path.",
  },
  "frontmatter-invalid": {
    severity: "warning",
    title: "Invalid or missing frontmatter",
    fix: "Add the required frontmatter keys, or add a frontmatter block.",
  },
  "duplicate-slice-name": {
    severity: "warning",
    title: "Duplicate slice name",
    fix: "Rename the slice so its export key is unique.",
  },
  "duplicate-element-ref": {
    severity: "warning",
    title: "Duplicate element ref",
    fix: "Rename the element so its export ref is unique.",
  },
  "duplicate-type-ref": {
    severity: "warning",
    title: "Duplicate type ref",
    fix: "Rename the type so its export ref is unique.",
  },
  "slice-ready-unknown-slice": {
    severity: "error",
    title: "Unknown --slice-ready key",
    fix: "Pass a valid export key that exists in this model.",
    docAnchor: "slice-readiness",
    optIn: true,
  },
  "slice-ready-no-doc-bound": {
    severity: "warning",
    title: "No doc bound",
    fix: 'Bind a slice doc via `note "slices/<key>.md"`.',
    docAnchor: "slice-readiness",
    optIn: true,
  },
  "slice-ready-status-not-ready": {
    severity: "warning",
    title: "Not ready-to-implement",
    fix: "Set `status: ready-to-implement`.",
    docAnchor: "slice-readiness",
    optIn: true,
  },
  "slice-ready-open-questions-unchecked": {
    severity: "warning",
    title: "Unchecked Open Questions",
    fix: "Check off the remaining Open Questions.",
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
