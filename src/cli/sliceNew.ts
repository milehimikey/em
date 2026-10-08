// SPDX-License-Identifier: MIT
// `em slice new` (MIL-97 item 3): scaffolds a fresh slices/<key>.md doc's mechanical
// frontmatter + heading (MIL-266: plus the full template skeleton — see buildSliceDocContent;
// the paragraph below describes the frontmatter, which is unchanged) — exactly the 5 keys docs/slice-doc-schema.md's required-vs-optional
// table requires at `status: draft` (schemaVersion/pattern/swimlane/status/version), nothing
// else — no `implementedIn` (only required once a slice has ever reached `implemented`), no
// lineage keys (`split-from`/`merged-from`/`superseded-by` only apply to a split/merge/rename
// doc), no commented-out guidance cruft. The skill's `slice` phase still writes every judgment
// section by hand (Intent, Command, Scenarios, Open Questions, ...) — this command only kills
// the copy-paste-the-template-and-fill-in-the-frontmatter step, the one purely mechanical part
// that was silently drifting when hand-typed (a placeholder left unedited, a key forgotten).
//
// Deliberately fs-free/pure — src/cli.ts owns the write, the existing-file/--force check, and
// the printed `note` reminder, same split as sliceIndex.ts (buildSliceIndexTable vs
// runSliceIndex/CLI wiring).

import { kebabSlug } from "../util/slug.js";
import {
  GeneratedRegion,
  INVARIANTS_ELABORATE_COMMENT,
  placeholderRegions,
  regionEndLine,
  RegionKind,
  regionStartLine,
} from "../catalog/sliceSections.js";

/** `pattern`'s exact 4-value enum — docs/slice-doc-schema.md's "Canonical keys" table. */
export const SLICE_PATTERNS = ["state-change", "state-view", "automation", "translation"] as const;
export type SlicePattern = (typeof SLICE_PATTERNS)[number];

export function isSlicePattern(value: string): value is SlicePattern {
  return (SLICE_PATTERNS as readonly string[]).includes(value);
}

/** Current frontmatter dialect version (docs/slice-doc-schema.md, "schemaVersion vs version"):
 *  one value, the same across every doc using this dialect, bumped only by `em` maintainers
 *  when the dialect's canonical keys change — unrelated to any one slice's own `version`.
 *  Unchanged since MIL-86. */
const SCHEMA_VERSION = 1;

/** The filename stem a slice's display name maps to — `slices/<key>.md`, and the same key a
 *  `note "slices/<key>.md"` binding on the slice's primary element must match. Always derive
 *  it with this (kebabSlug, the same helper `em scaffold` uses) rather than letting a caller
 *  pass a pre-slugged key of their own, so the two can never drift apart. */
export function sliceDocKey(displayName: string): string {
  return kebabSlug(displayName);
}

/**
 * Build the full contents of a fresh `slices/<key>.md` (MIL-266: the whole template skeleton).
 * Frontmatter: exactly the 5 keys required at `status: draft`, in the same order
 * templates/slice.md's own frontmatter block uses. Body: the `# Slice: <name>` heading, the
 * diagram-image stub, then every template section in template order (`## Delta` excepted — a
 * version-1 doc has no delta yet). The GENERATED regions (command/event/view field tables, the
 * Invariants list — catalog/sliceSections.ts) are filled from `regions`: the model's own regions
 * when `em slice new --wire` compiled one, else the template's placeholder regions, which
 * `em slice sync` fills once the doc is bound. Authored sections carry the template's
 * placeholder bullets and stay hand-written.
 */
export function buildSliceDocContent(
  displayName: string,
  key: string,
  pattern: SlicePattern,
  swimlane: string,
  regions: GeneratedRegion[] = placeholderRegions(),
): string {
  const block = (kind: RegionKind): string[] => {
    const out: string[] = [];
    for (const r of regions) {
      if (r.kind !== kind) continue;
      out.push(regionStartLine(r.name), ...r.body, regionEndLine(r.name));
    }
    return out;
  };
  const lines = [
    `---`,
    `schemaVersion: ${SCHEMA_VERSION}`,
    `pattern: ${pattern}`,
    `swimlane: ${swimlane}`,
    `status: draft`,
    `version: 1`,
    `---`,
    `# Slice: ${displayName}`,
    ``,
    `![Diagram](./${key}.svg)`,
    ``,
    `## Intent`,
    `{{Why this slice exists — the user or business goal it serves, in one or two sentences. Note the`,
    `originating ticket/conversation link here if one exists.}}`,
    ``,
    `## Trigger & Actor`,
    `{{Who or what initiates this slice and under what circumstances. For automations, the watched`,
    `read model and the triggering condition. For translations, state the trigger form: externally`,
    `triggered (the external system/source feeding us) or internally triggered (the read model whose`,
    `state we react to). Either way, name the command this reaction triggers — reactions never record`,
    `an event directly.}}`,
    ``,
    `## Command / Input`,
    ...block("command"),
    ``,
    `## Trigger`,
    "**Triggered by:** {{screen `X` @Persona | processor `Y`, also in this slice}}",
    ``,
    `## Event(s) Emitted`,
    ...block("event"),
    `**Read by:** {{which read model projects this event, and in which slice}}`,
    ``,
    `## Read Model / View`,
    ...block("view"),
    `- **Consumed by:** {{which UI screen (or API-caller persona), or reaction}}`,
    `- **Freshness / consistency expectation:** {{real-time | eventual | on-demand}}`,
    ``,
    `## Invariants / Business Rules`,
    ...block("invariants"),
    INVARIANTS_ELABORATE_COMMENT,
    ``,
    `## Scenarios (Given / When / Then)`,
    `### Scenario: Happy path`,
    `- **Given:**`,
    `  - {{starting state / prior events}}`,
    `- **When:**`,
    `  - {{command/trigger}}`,
    `- **Then:**`,
    `  - {{event(s) recorded}}`,
    `  - {{resulting read-model change}}`,
    ``,
    `## Alternate & Error Flows`,
    `- {{e.g. external call fails → retry policy / compensating event}}`,
    `- {{idempotency: what happens if the command/event arrives twice?}}`,
    ``,
    `## Non-Functional Requirements`,
    `- **Security / authz:** {{who may invoke this; role/permission checks — or "none"}}`,
    `- **PII & compliance:** {{personal data touched, retention/consent constraints — or "none"}}`,
    `- **Performance / SLA:** {{latency/throughput expectation — or "none"}}`,
    ``,
    `## Dependencies & Read Models Affected`,
    `- **Upstream events this slice relies on:** {{...}}`,
    `- **Downstream read models / slices affected:** {{...}}`,
    ``,
    `## Open Questions`,
    `- [ ] {{question}}`,
  ];
  return lines.join("\n") + "\n";
}

/**
 * Build the full contents of a fresh, near-free `slices/<key>.md` STUB (MIL-184: `em slice new
 * --stub` / `em slice stub-all`) — the same 5 frontmatter keys `buildSliceDocContent` writes
 * (nothing else, same as above), but the body is one placeholder line instead of the
 * diagram-image stub and every judgment section (Intent, Command, Scenarios, Open Questions,
 * ...) a full slice doc eventually carries. Exists purely so the slice has a real, single-
 * source-of-truth `status` — every lifecycle tool that reads `doc.status` (render coloring,
 * `em status`, `driftSignal`, `em slice index`) treats a stub exactly like any other doc, since
 * it's the same frontmatter dialect. Deepen it later with `em slice new` (no `--stub`) + `-f` to
 * overwrite this placeholder body once the team is ready to write the real spec.
 */
export function buildStubDocContent(displayName: string, pattern: SlicePattern, swimlane: string): string {
  return (
    `---\n` +
    `schemaVersion: ${SCHEMA_VERSION}\n` +
    `pattern: ${pattern}\n` +
    `swimlane: ${swimlane}\n` +
    `status: draft\n` +
    `version: 1\n` +
    `---\n` +
    `# Slice: ${displayName}\n` +
    `\n` +
    `_Stub — deepen with the slice phase (see slice-doc-schema.md)._\n`
  );
}
