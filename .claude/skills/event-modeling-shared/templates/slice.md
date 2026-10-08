<!--
Rich slice design document. One per slice, stored in <model>/slices/<slice-name>.md and
linked from the .em model with:  note "slices/<slice-name>.md"  on the slice's defining element.
Fill every section through Socratic questioning. Leave "Open Questions" rather than guessing.
Replace the bracketed placeholders; delete guidance comments before finishing.

The frontmatter below is the canonical, machine-read metadata dialect — `em`'s own parser
(src/catalog/sliceDoc.ts) reads `status:`, `version:`, `pattern:`, and the lineage keys
(`split-from:`/`merged-from:`/`superseded-by:`) from it. `pattern` is kebab-case
(state-change/state-view/automation/translation) even though the skill's prose always says
"State Change"/"State View"/etc. — the frontmatter value is a machine key, not a display label.
Older docs using a `- **Status:** ...` bullet line instead of frontmatter still parse (legacy/
accepted input), but new docs should always use this frontmatter form; `version` and lineage
have no legacy form — frontmatter-only from day one.

`version` is this slice's own ratified-content version — starts at `1`, bumps when a delta is
ratified — distinct from `schemaVersion`, which versions the frontmatter dialect itself, not
this slice. When a ratified change lands on an already-`implemented` slice: bump `version`,
flip `status` back to `ready-to-implement` (it tracks the CURRENT version's implementation
state — `implementedIn` legitimately keeps naming the PRIOR version's PR until the new version
ships; that mismatch is an intended drift signal, not a bug), and fill in the `## Delta` section
below with this hop's change, replacing whatever it held before (it always shows only the latest
hop — full history lives in git, same-commit-ratification convention). Full grammar — the fixed
heading, the four operation subsections, why the heading never varies, the replace-not-accumulate
lifecycle — is documented in ../reference/slice-doc-schema.md#delta-section-grammar-and-lifecycle; treat
it the same Socratic way as every other section here, don't generate it mechanically.

The three lineage keys only apply when this doc was produced by a split, merge, or rename —
delete them otherwise; most slices never carry them. Grammar: `<slice-key>@v<N>`, where
`<slice-key>` is the referenced slice's kebab-case filename stem.

`covers` only applies when this doc is also the ratified doc for a DIFFERENT slice — typically
the bare `view` half of the two-slice Automation/Translation shape, which has nothing of its own
to write up. Delete it otherwise; most docs never carry it. Requires a matching
`note "slices/{{this-slice-name}}.md"` on an element in the OTHER slice — this key alone doesn't
bind anything. Plain slice keys, comma-separated — not the `<slice-key>@v<N>` ref grammar above.

`ratifiedBy`/`ratifiedOn` record who ratified this doc's current `status`/`version`, and when —
don't hand-fill these; run `em slice ratify <model> <key> --by <name>` at the
handoff gate instead (docs/process.md#what-ratified-means), which flips `status` to
`ready-to-implement` and writes both in one edit.
public-touching slice: add --meaning-unchanged, or --contract-change "<why>"; run em api generate first.

`owner`/`tracking` are optional and, unlike `ratifiedBy`/`ratifiedOn`, hand-filled — no `em`
command writes either. `owner` is free text naming who (a person or team) holds this slice;
`tracking` is a URL into an external tracker (Jira, Linear, ...) mirroring it — the exact field
`em-tracker-bridge` reads to find the mirrored ticket. `em` only stores and displays both; it
never talks to a tracker itself. Delete both otherwise; most docs never carry them.

Full machine schema — required-vs-optional keys per `status`, value types/enums, the
unknown-key policy — is documented in ../reference/slice-doc-schema.md.

The diagram below is generated, not hand-drawn: `em render <model>.em --slice "{{Slice Name}}"
-o slices/{{slice-name}}.svg` (kebab-case the slice name to match this doc's own filename).
-->

---
schemaVersion: 1
pattern: {{state-change | state-view | automation | translation}}
swimlane: {{Persona/Actor}} → {{Context/Aggregate}}
status: {{draft | reviewed | ready-to-implement | implemented}}
version: 1
implementedIn: {{PR/commit link — fill in once status is `implemented`}}
# Lineage — only when this doc exists because of a split, merge, or rename (delete these three
# lines otherwise). Grammar: <slice-key>@v<N>. See
# ../reference/slice-doc-schema.md#lineage-grammar-and-cardinality.
# split-from: <slice-key>@v<N>
# merged-from: <slice-key>@v<N>, <slice-key>@v<N>
# superseded-by: <slice-key>@v<N>, <slice-key>@v<N>
# Cross-slice coverage — only when this doc also covers another slice with no doc of its own
# (e.g. the view-only half of a two-slice Automation/Translation, MIL-121); delete otherwise.
# Plain slice keys, comma-separated. See ../reference/slice-doc-schema.md#cross-slice-coverage-covers.
# covers: <slice-key>, <slice-key>
# Ownership / tracking — optional, hand-filled (no `em` command writes either); delete otherwise.
# owner: <person or team>
# tracking: <ticket URL>
---
# Slice: {{Slice Name}}

![Diagram](./{{slice-name}}.svg)

<!-- Only on re-ratification of an already-`implemented` slice — omit this whole section on a
     slice's first version (v1 has no delta yet). The heading is always the literal `## Delta`,
     never `## Delta: vX → vY` — hop metadata is a display line inside the section instead (see
     ../reference/slice-doc-schema.md#delta-section-grammar-and-lifecycle for why). Replace this
     section's content wholesale on the next re-ratification — it shows only the latest hop, not
     an accumulating log. Omit any of the four subsections below with no entries this hop; keep
     the remaining ones in this order (Added/Modified/Removed/Renamed). `Renamed` is for a
     requirement/invariant renamed within this slice, not a substitute for the frontmatter
     `split-from`/`merged-from`/`superseded-by` lineage keys above, which record the slice-doc
     itself splitting, merging, or being renamed. -->
## Delta
**v{{X}} → v{{Y}}, ratified {{date}}** — {{one-line summary of the ratified change}}

### Added
#### Requirement: {{title}} ({{stable ID, e.g. an INV-{{MNEMONIC}}-n from Invariants below}})
{{requirement text — same voice as an Invariants entry}}
##### Scenario: {{name}}
- **Given:** {{...}}
- **When:** {{...}}
- **Then:** {{...}}

### Modified
<!-- Same shape as Added — the stable ID names the requirement that changed. -->

### Removed
#### Requirement: {{title}} ({{stable ID}})
{{why it was removed}}

### Renamed
- {{old title}} ({{old ID}}) → {{new title}} ({{new ID}})

## Intent
{{Why this slice exists — the user or business goal it serves, in one or two sentences. Note the
originating ticket/conversation link here if one exists.}}

## Trigger & Actor
{{Who or what initiates this slice and under what circumstances. For automations, the watched
read model and the triggering condition. For translations, state the trigger form: externally
triggered (the external system/source feeding us) or internally triggered (the read model whose
state we react to). Either way, name the command this reaction triggers — reactions never record
an event directly.}}

## Command / Input
<!-- GENERATED region (MIL-266): the table between the markers is written from the model —
     `em slice new` fills it, `em slice sync <model>.em` refreshes it after any model edit. Never
     hand-edit inside the markers: change the `.em` and re-run `em slice sync`. Required = `no`
     for a field written `name?: Type`. A slice with several commands gets one region per command
     (`em-slice-command-<command-slug>`); a pure State View slice's region says it has none. -->
<!-- GENERATED:em-slice-command:start — generated from the model by `em slice sync`; do not hand-edit -->
**Command:** `{{Command Name}}`

| Field | Type | Required | Rules / Validation |
|-------|------|----------|--------------------|
| {{field}} | {{Type}} | {{yes/no}} | {{constraints, formats, ranges}} |
<!-- GENERATED:em-slice-command:end -->

## Trigger
<!-- What issues this slice's command. Required: a command nothing points at is a write nobody
     can start. Either the screen the user acts on (a `ui` in this slice), or the reaction that
     issues it (an automation/processor/translation, also in this slice). -->
**Triggered by:** {{screen `X` @Persona | processor `Y`, also in this slice}}

## Event(s) Emitted
<!-- The immutable facts recorded. The marker line and payload table are a GENERATED region (one
     per event; `em-slice-event-<event-slug>` when the slice records several): Source / Notes
     names the command field a value is copied from, `assigned` for a system-assigned field, or
     `{{ }}` where the model cannot tell. `**Read by:**` below the region is authored. -->
<!-- GENERATED:em-slice-event:start — generated from the model by `em slice sync`; do not hand-edit -->
**Event:** `{{Event Name}}` → context `{{Context}}`

| Field | Type | Immutable Fact? | Source / Notes |
|-------|------|-----------------|----------------|
| {{field}} | {{Type}} | {{yes/no}} | {{where the value comes from}} |
<!-- GENERATED:em-slice-event:end -->
**Read by:** {{which read model projects this event, and in which slice}}
<!-- Required, not optional. Every event must be read by a read model — an event nothing
     projects is a write nobody can see, and `em validate` warns on it. A reaction consuming
     it does NOT count: reactions read views, not events. If the honest answer is "nothing
     reads it", that's a question for the business, not a field to leave blank. -->

## Read Model / View
<!-- For State View slices, and any read model this slice produces or feeds. The `- **View:**`
     line and field table are a GENERATED region (one per read model; `em-slice-view-<view-slug>`
     when there are several): Source / Notes names the source event a field is copied from, or
     `Derived` for a field marked `derived` in the `.em` (docs/dsl.md#derived-fields) — say how
     it is derived in prose below the region. `{{ }}` marks a field the model cannot trace. -->
<!-- GENERATED:em-slice-view:start — generated from the model by `em slice sync`; do not hand-edit -->
- **View:** `{{View Name}}` built from events: {{"Event A", "Event B"}}

| Field | Type | Source / Notes |
|-------|------|----------------|
| {{field}} | {{Type}} | {{which event field it's copied from, or `Derived: <rule>`}} |
<!-- GENERATED:em-slice-view:end -->
- **Consumed by:** {{which UI screen (or API-caller persona), or reaction}}
<!-- "Consumed by" is required, not optional. A read model nothing displays or watches is
     information projected out of the system and then dropped, and `em validate` warns. Every
     instance of a repeated view needs its own consumer, not just the last one. -->
- **Freshness / consistency expectation:** {{real-time | eventual | on-demand}}

## Invariants / Business Rules
<!-- IDs and rule sentences are declared in the MODEL (MIL-265): an `invariant INV-<MNEMONIC>-<n>
     "rule"` line after the command or event it guards (docs/dsl.md#invariants). The list between
     the markers is GENERATED from those lines (`em slice sync`); never edit it. Below it, cite
     each ID as a plain mention and elaborate — `- INV-CHK-1 — why it holds, edge cases, the error
     a violation returns` — never re-declare it with the `**INV-CHK-1:**` label
     (`invariants/declared-in-both`). A rule not (yet) in the model may still be declared below
     with that label; em reads it as the fallback. -->
<!-- What must ALWAYS hold. Give each a stable ID so tests and code can reference it:
     `INV-<MNEMONIC>-<n>`, where `<MNEMONIC>` is a short (2-4 letter/digit), slice-unique
     abbreviation of this slice's key (e.g. slice `checkout` -> `INV-CHK-1`) — see
     ../reference/slice-doc-schema.md. Keep the rule statement itself to one line. If it needs
     more — why the rule exists, what "violation" looks like in practice, an edge case worth
     calling out — add that as a nested bullet under the elaboration line instead of one long
     run-on sentence: this section renders as HTML (`em catalog`/`em render`/`em watch`), and a
     nested bullet stays visually distinct where a wrapped sentence collapses into a wall of
     text. The ID must stay on the top-level bullet line — `em coverage` extracts INV IDs from
     that line only, never from a nested elaboration bullet underneath it. -->
<!-- GENERATED:em-slice-invariants:start — generated from the model by `em slice sync`; do not hand-edit -->
- **INV-{{MNEMONIC}}-1** — {{rule, as declared by `invariant INV-{{MNEMONIC}}-1 "rule"` in the model}}
<!-- GENERATED:em-slice-invariants:end -->
<!-- elaborate below this list; IDs are declared in the model -->
- INV-{{MNEMONIC}}-1 — {{elaboration of the model-declared rule: why it holds, what a violation looks like, the error returned}}
  - {{optional: edge-case detail — its own bullet}}
- **INV-{{MNEMONIC}}-2:** {{a rule not yet in the model, declared here as the fallback — move it into the model when you can}}

## Scenarios (Given / When / Then)
<!-- The executable specification — authored, in a constrained shape `em` reads back (`em export
     --json` → slice.doc.scenarios). Cover the happy path AND the key rule boundaries, one block
     per case: a `### Scenario: <title>` heading, then exactly the three column-0 bullets
     `- **Given:**`, `- **When:**`, `- **Then:**`, each with its beats as nested `  - ` bullets.
     A block missing any of the three is flagged `slice-doc/structured-section-malformed`. -->
### Scenario: Happy path
- **Given:**
  - {{starting state / prior events}}
- **When:**
  - {{command/trigger}}
- **Then:**
  - {{event(s) recorded}}
  - {{resulting read-model change}}

## Alternate & Error Flows
<!-- Failure paths, retries, compensations, timeouts, idempotency. -->
- {{e.g. external call fails → retry policy / compensating event}}
- {{idempotency: what happens if the command/event arrives twice?}}

## Non-Functional Requirements
<!-- Short checklist. Idempotency is covered above under Alternate & Error Flows — not repeated
     here. -->
- **Security / authz:** {{who may invoke this; role/permission checks — or "none"}}
- **PII & compliance:** {{personal data touched, retention/consent constraints — or "none"}}
- **Performance / SLA:** {{latency/throughput expectation — or "none"}}

## Dependencies & Read Models Affected
- **Upstream events this slice relies on:** {{...}}
- **Downstream read models / slices affected:** {{...}}

## Open Questions
<!-- Park unresolved items here instead of guessing. Mirror them into .event-modeling.md.

     Lifecycle across versions: while THIS version is still being worked, a resolved item
     (`- [x]`) can stay checked here as a visible record of what's already been decided this
     round. On the same commit that ratifies the NEXT version (bumps `version`, rewrites
     `## Delta` above) — prune every already-checked item from this list; keep only what's still
     open, plus anything new the delta itself surfaced. Same "replace, never accumulate" stance
     as `## Delta`, for the same reason: an ever-growing scroll of resolved questions goes stale
     exactly like an accumulating Delta log would, and full history already lives in git
     (`git log -p slices/<name>.md`) — this section is a live worklist, not an audit trail. See
     ../reference/slice-doc-schema.md#open-questions-section-lifecycle. -->
- [ ] {{question}}
