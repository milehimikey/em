<!--
Resumable progress state for an event model. Stored as <model>/.event-modeling.md
The skill reads this on `/event-modeling` (no arg) to resume where you left off.
Keep it current at the end of every working session.
-->

# Event Modeling Progress — {{Model Name}}

- **Model file:** `{{model-name}}.em`
- **Current phase:** {{discover | extract | model | slice | implement | conform | review | validate}}
- **Current step:** {{1–7, see methodology; or extraction round R1–R7}}
- **Last updated:** {{YYYY-MM-DD}}
- **Last conformance:** {{YYYY-MM-DD @ <target-repo revision> — report: conformance/<date>-report.md | never}}
- **Last stakeholder review:** {{YYYY-MM-DD — attendees: see Participants | never}}

## Session inputs
- **Scope line:** {{one-line description of what's in/out of bounds for this model}}
- **PRD / spec reference:** {{path, link, or "none"}}
- **Headless/API model:** {{yes | no}}
- **Source mode:** {{greenfield | extract-event-driven | extract-procedural}}
- **Existing system refs:** {{repo paths, event-schema/topic locations, docs — or "n/a"}}

## Participants
<!-- Populate at session start. Live workshop: one human proxy relays questions to the room;
     attribute every answer/decision in the Decisions log to a named participant here. -->
- {{Name}} — {{role}} — {{domain area}}

## Extraction progress (existing-system models only — delete for greenfield)
- [ ] R1. Candidate events (extracted/synthesized, filtered, confirmed)
- [ ] R2. Timeline order (as-is narrative, actors/callers, first render)
- [ ] R3. Commands / inputs
- [ ] R4. Read models / outputs (validate from here)
- [ ] R5. Boundaries & reactions (reaction shares its slice with the command it triggers)
- [ ] R6. Gap & TBD reconciliation
- [ ] R7. Convergence (render + validate clean, user confirmed as-is)

## Steps completed
- [ ] 1. Brainstorm events
- [ ] 2. Plot / storyboard (personas + UI)
- [ ] 3. Inputs (commands)
- [ ] 4. Outputs (read models)
- [ ] 5. Swimlanes & apply patterns
- [ ] 6. Elaborate scenarios
- [ ] 7. Evaluate completeness (`em validate` clean)

## Decisions log
<!-- Resolved choices, with the reasoning, so they aren't re-litigated. In a live workshop,
     attribute each entry to the participant who made the call (see Participants above). -->
- {{YYYY-MM-DD}}: {{decision}} — {{why}} — by {{participant, if a live workshop}}

## Usage log
<!-- The team's only usage signal today (see docs/usage-data.md) — cheap and coarse on purpose.
     One line per session: phase(s) touched, and validate diagnostic *categories* hit (one of
     the exact fixed strings in docs/usage-data.md#categories, e.g. "read model has no
     consumer" — never the full instance message or any domain content). Append, never edit
     past entries. -->
- {{YYYY-MM-DD}}: phases: {{discover | extract | model | slice | implement | conform | review | validate | watch, ...}} — validate: {{diagnostic category (docs/usage-data.md#categories), ... | none}}

## Open questions / parking lot
<!-- Unresolved items to bring back to the user. Never guess these. Metadata is optional and
     flat — add only what's known: source (ticket/conversation that spawned it), blocked on
     (who/what), revisit (when). -->
- [ ] {{question}} — source: {{ticket/conversation link, optional}} — blocked on: {{who/what, optional}} — revisit: {{when, optional}}

## Slice inventory
<!-- Deliberately NOT a table: the canonical slice index (slice, pattern, status, doc link)
     lives in README.md's "Slices" section — one source of truth, updated there. This file
     only tracks resumable session state. -->
See `README.md` → **Slices** for the slice index and per-slice doc status.
