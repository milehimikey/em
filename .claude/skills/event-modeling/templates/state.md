<!--
Resumable progress state for an event model. Stored as <model>/.event-modeling.md
The skill reads this on `/event-modeling` (no arg) to resume where you left off.
Keep it current at the end of every working session.
-->

# Event Modeling Progress — {{Model Name}}

- **Model file:** `{{model-name}}.em`
- **Current phase:** {{extract | discover | model | slice}}
- **Current step:** {{1–7, see methodology; or extraction round R1–R7}}
- **Last updated:** {{YYYY-MM-DD}}

## Session inputs
- **Scope line:** {{one-line description of what's in/out of bounds for this model}}
- **PRD / spec reference:** {{path, link, or "none"}}
- **Headless/API model:** {{yes | no}}
- **Source mode:** {{greenfield | extract-event-driven | extract-procedural}}
- **Existing system refs:** {{repo paths, event-schema/topic locations, docs — or "n/a"}}

## Extraction progress (existing-system models only — delete for greenfield)
- [ ] R1. Candidate events (extracted/synthesized, filtered, confirmed)
- [ ] R2. Timeline order (as-is narrative, actors/callers, first render)
- [ ] R3. Commands / inputs
- [ ] R4. Read models / outputs (validate from here)
- [ ] R5. Boundaries & reactions (two-slice splits)
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
<!-- Resolved choices, with the reasoning, so they aren't re-litigated. -->
- {{YYYY-MM-DD}}: {{decision}} — {{why}}

## Open questions / parking lot
<!-- Unresolved items to bring back to the user. Never guess these. -->
- [ ] {{question}}

## Slice inventory
| Slice | Pattern | Doc status |
|-------|---------|------------|
| {{Slice Name}} | {{State Change/View/Automation/Translation}} | {{none / draft / reviewed / ready-to-implement}} |
