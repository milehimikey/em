# Recording sheet — GH #423 extraneous lines (library-lending, arm after)

Input: library-lending            Input class: PRD
Arm: E (1.21.0 skills, gh-423)       Rerun: 1
Date: 2026-11-04       Run by: orchestrator (sonnet worker, in-session)
em version: main after #436 (schema 1.20)      Entry point used: discover SKILL.md + design SKILL.md model phase, read from the repo skills directory
Model / effort: claude-sonnet-5-5 / default
Profile: in-session sub-agent, no project CLAUDE.md read, empty work dir outside any repo      Memory disabled: n/a (worker has no memory)
Fixed opening message used: adapted (worker prompt: follow the skills, no questions, "not specified" rule, stop after the model phase)
Reference not shown / not reachable: yes

> Deviation from the protocol: this is an in-session worker run, not a fresh Claude Code profile with the plugin pinned (1.21.0 is not released yet). Both arms ran the same way with only the skills directory differing, so the before/after comparison holds; absolute numbers are not comparable to the fresh-profile recordings.

## Mechanical (score.mjs --json)

```json
{
  "input": "library-lending",
  "reactions": 3,
  "producedSlices": 7,
  "referenceSlices": 7,
  "slicesPerReaction": 2.3333333333333335,
  "referenceSlicesPerReaction": 2.3333333333333335,
  "sliceRatio": 1,
  "aliasesUsed": 0,
  "extraSlices": [
    "my-loans",
    "check-in-book",
    "my-loans-after-return",
    "loans-awaiting-return",
    "overdue-notices"
  ],
  "missingSlices": [
    "active-loans",
    "return-book",
    "active-loans-after-return",
    "loans-to-check",
    "notice-log"
  ],
  "businessEventRecall": 0.6666666666666666,
  "stateChangeSlices": 2,
  "entityClusteredSlices": 0,
  "entityClusteredRate": 0,
  "todoViews": 1,
  "todoInboundLines": 1,
  "todoInboundLinesPerView": {
    "loans-awaiting-return/view.loans-awaiting-return": 1
  },
  "storylineReadsWithoutAfter": 0,
  "storylineReadsWithoutAfterPairs": []
}
```

## Notes

To-do view `Loans Awaiting Return from "Book Borrowed" updates from "Book Checked In"`: one inbound line, the return is housekeeping. `after` declared. The worker named the return event "Book Checked In" (reference: "Book Returned"), which is why business-event recall reads 0.67 — a naming difference, not a line-shape one.
