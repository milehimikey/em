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
ships; that mismatch is an intended drift signal, not a bug), and add a
`Delta: vX → vY, ratified <date>: <summary>` line under the `# Slice:` heading below (body
prose, not frontmatter).

The three lineage keys only apply when this doc was produced by a split, merge, or rename —
delete them otherwise; most slices never carry them. Grammar: `<slice-key>@v<N>`, where
`<slice-key>` is the referenced slice's kebab-case filename stem.

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
---
# Slice: {{Slice Name}}

![Diagram](./{{slice-name}}.svg)

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
     command in the next slice). Omit for pure State View slices. -->
**Command:** `{{Command Name}}`

| Field | Type | Required | Rules / Validation |
|-------|------|----------|--------------------|
| {{field}} | {{Type}} | {{yes/no}} | {{constraints, formats, ranges}} |

## Trigger
<!-- What issues this slice's command. Required: a command nothing points at is a write nobody
     can start. Either the screen the user acts on (a `ui` in this slice), or the reaction that
     issues it (an automation/processor/translation in the PREVIOUS slice). -->
**Triggered by:** {{screen `X` @Persona | processor `Y` in slice "Z"}}

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
<!-- What must ALWAYS hold. Give each a stable ID so tests and code can reference it. -->
- **INV-1:** {{rule that the command enforces; violation ⇒ rejection}}
- **INV-2:** {{...}}

## Scenarios (Given / When / Then)
<!-- The executable specification. Cover the happy path AND the key rule boundaries. -->
- **Happy path** — Given {{starting state / prior events}}, When {{command/trigger}},
  Then {{event(s) recorded}} and {{resulting read-model change}}.
- **Rejected (INV-1)** — Given {{state}}, When {{command}}, Then {{rejected with reason}}; no event.
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
