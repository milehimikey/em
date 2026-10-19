# PRD triage example

`prd-triage.json` is a worked `discovery/prd-triage.json` (prdTriageSchemaVersion 1.0) for the
Meridian Goods ordering PRD, the same input the eval protocol uses
(`../../eval/inputs/meridian-goods/input.md`; the triage file's `source` points at it, relative to
the triage file). It shows the discover skill's PRD/spec path
(`.claude/skills/event-modeling-discover/reference/prd-spec-path.md`): four storylines from the
PRD's numbered walkthrough (the main one is items 1-3, place and pay), every claim a single
statement quoting the PRD, grouped by trigger and acting system, with the background and scope
lines parked and a reason recorded.

Check it (run from this directory):

```bash
em discover triage-check prd-triage.json
em discover triage-check prd-triage.json --markdown   # the human-readable view
```

The checker verifies shape, the rubric version, that every quote appears verbatim in the PRD, and
the outcome and walkthrough-anchoring rules. It cannot tell you the triage is *right*; that is the
human review.
