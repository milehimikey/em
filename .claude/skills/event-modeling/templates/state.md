<!--
Resumable progress state for an event model. Stored as <model>/.event-modeling.md
The skill reads this on `/event-modeling` (no arg) to resume where you left off.
Keep it current at the end of every working session.
-->

---
schemaVersion: 1
model: {{model-name}}.em
---

# Event Modeling Progress — {{Model Name}}

- **Model file:** `{{model-name}}.em`
- **Current phase:** {{discover | model | slice}}
- **Current step:** {{1–7, see methodology}}
- **Last updated:** {{YYYY-MM-DD}}

## Session inputs
- **Scope line:** {{one-line description of what's in/out of bounds for this model}}
- **PRD / spec reference:** {{path, link, or "none"}}
- **Headless/API model:** {{yes | no}}
- **Regulatory scope:** {{e.g. PCI-DSS, SOX, HIPAA, or "none"}}

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
| Slice | Id | Pattern | Doc status |
|-------|-----|---------|------------|
| {{Slice Name}} | {{slice-id}} | {{state-change/state-view/automation/translation}} | {{none / draft / reviewed / ready-to-implement}} |
