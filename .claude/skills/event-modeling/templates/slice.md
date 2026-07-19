<!--
Rich slice design document. One per slice, stored in <model>/slices/<slice-name>.md and
linked from the .em model with:  note "slices/<slice-name>.md"  on the slice's defining element.
Fill every section through Socratic questioning. Leave "Open Questions" rather than guessing.
Replace the bracketed placeholders; delete guidance comments before finishing.

This is the body template only — `em slice new` injects the required frontmatter block above
this content (id, pattern, status, version, sliceElement, and the generated search fields).
Pattern and status live there now, not as prose here — see reference/frontmatter.md.
-->

# Slice: {{Slice Name}}

- **Swimlane:** {{Persona/Actor}} → {{Context/Aggregate}}

## Intent
{{Why this slice exists — the user or business goal it serves, in one or two sentences.}}

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

## Event(s) Emitted
<!-- The immutable facts recorded. List each event and its payload. -->
**Event:** `{{Event Name}}` → context `{{Context}}`

| Field | Type | Immutable Fact? | Source / Notes |
|-------|------|-----------------|----------------|
| {{field}} | {{Type}} | {{yes/no}} | {{where the value comes from}} |

## Read Model / View
<!-- For State View slices, and any read model this slice produces or feeds. -->
- **View:** `{{View Name}}` built from events: {{"Event A", "Event B"}}
- **Consumed by:** {{which UI screen or automation}}
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

## Dependencies & Read Models Affected
- **Upstream events this slice relies on:** {{...}}
- **Downstream read models / slices affected:** {{...}}

## Open Questions
<!-- Park unresolved items here instead of guessing. Mirror them into .event-modeling.md. -->
- [ ] {{question}}
