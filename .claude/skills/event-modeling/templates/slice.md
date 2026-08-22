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
lifecycle — is documented in docs/slice-doc-schema.md#delta-section-grammar-and-lifecycle; treat
it the same Socratic way as every other section here, don't generate it mechanically.

The three lineage keys only apply when this doc was produced by a split, merge, or rename —
delete them otherwise; most slices never carry them. Grammar: `<slice-key>@v<N>`, where
`<slice-key>` is the referenced slice's kebab-case filename stem.

`covers` only applies when this doc is also the ratified doc for a DIFFERENT slice — typically
the bare `view` half of the two-slice Automation/Translation shape, which has nothing of its own
to write up. Delete it otherwise; most docs never carry it. Requires a matching
`note "slices/{{this-slice-name}}.md"` on an element in the OTHER slice — this key alone doesn't
bind anything. Plain slice keys, comma-separated — not the `<slice-key>@v<N>` ref grammar above.

Full machine schema — required-vs-optional keys per `status`, value types/enums, the
unknown-key policy — is documented in docs/slice-doc-schema.md.

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
# docs/slice-doc-schema.md#lineage-grammar-and-cardinality.
# split-from: <slice-key>@v<N>
# merged-from: <slice-key>@v<N>, <slice-key>@v<N>
# superseded-by: <slice-key>@v<N>, <slice-key>@v<N>
# Cross-slice coverage — only when this doc also covers another slice with no doc of its own
# (e.g. the view-only half of a two-slice Automation/Translation, MIL-121); delete otherwise.
# Plain slice keys, comma-separated. See docs/slice-doc-schema.md#cross-slice-coverage-covers.
# covers: <slice-key>, <slice-key>
---
# Slice: {{Slice Name}}

![Diagram](./{{slice-name}}.svg)

<!-- Only on re-ratification of an already-`implemented` slice — omit this whole section on a
     slice's first version (v1 has no delta yet). The heading is always the literal `## Delta`,
     never `## Delta: vX → vY` — hop metadata is a display line inside the section instead (see
     docs/slice-doc-schema.md#delta-section-grammar-and-lifecycle for why). Replace this
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
- **GIVEN** {{...}} **WHEN** {{...}} **THEN** {{...}}

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
<!-- For State Change, and the command half of an Automation or Translation (reactions trigger a
     command in this same slice). Omit for pure State View slices. -->
**Command:** `{{Command Name}}`

| Field | Type | Required | Rules / Validation |
|-------|------|----------|--------------------|
| {{field}} | {{Type}} | {{yes/no}} | {{constraints, formats, ranges}} |

## Trigger
<!-- What issues this slice's command. Required: a command nothing points at is a write nobody
     can start. Either the screen the user acts on (a `ui` in this slice), or the reaction that
     issues it (an automation/processor/translation, also in this slice). -->
**Triggered by:** {{screen `X` @Persona | processor `Y`, also in this slice}}

## Event(s) Emitted
<!-- The immutable facts recorded. List each event and its payload. -->
**Event:** `{{Event Name}}` → context `{{Context}}`
**Read by:** {{which read model projects this event, and in which slice}}
<!-- Required, not optional. Every event must be read by a read model — an event nothing
     projects is a write nobody can see, and `em validate` warns on it. A reaction consuming
     it does NOT count: reactions read views, not events. If the honest answer is "nothing
     reads it", that's a question for the business, not a field to leave blank. -->

| Field | Type | Immutable Fact? | Source / Notes |
|-------|------|-----------------|----------------|
| {{field}} | {{Type}} | {{yes/no}} | {{where the value comes from}} |

## Read Model / View
<!-- For State View slices, and any read model this slice produces or feeds. -->
- **View:** `{{View Name}}` built from events: {{"Event A", "Event B"}}
- **Consumed by:** {{which UI screen (or API-caller persona), or reaction}}
<!-- "Consumed by" is required, not optional. A read model nothing displays or watches is
     information projected out of the system and then dropped, and `em validate` warns. Every
     instance of a repeated view needs its own consumer, not just the last one. -->
- **Freshness / consistency expectation:** {{real-time | eventual | on-demand}}

## Invariants / Business Rules
<!-- What must ALWAYS hold. Give each a stable ID so tests and code can reference it:
     `INV-<MNEMONIC>-<n>`, where `<MNEMONIC>` is a short (2-4 letter/digit), slice-unique
     abbreviation of this slice's key (e.g. slice `checkout` -> `INV-CHK-1`) — see
     docs/slice-doc-schema.md. Add a letter suffix for a closely-related sub-invariant
     (`INV-CHK-3a`). -->
- **INV-{{MNEMONIC}}-1:** {{rule that the command enforces; violation ⇒ rejection}}
- **INV-{{MNEMONIC}}-2:** {{...}}

## Scenarios (Given / When / Then)
<!-- The executable specification. Cover the happy path AND the key rule boundaries. -->
- **Happy path** — Given {{starting state / prior events}}, When {{command/trigger}},
  Then {{event(s) recorded}} and {{resulting read-model change}}.
- **Rejected (INV-{{MNEMONIC}}-1)** — Given {{state}}, When {{command}}, Then {{rejected with reason}}; no event.
- **{{Edge case}}** — Given {{...}}, When {{...}}, Then {{...}}.

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
<!-- Park unresolved items here instead of guessing. Mirror them into .event-modeling.md. -->
- [ ] {{question}}
