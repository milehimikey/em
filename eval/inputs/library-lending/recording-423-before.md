# Recording sheet — GH #423 extraneous lines (library-lending, arm before)

Input: library-lending            Input class: PRD
Arm: C (1.20.0 skills, main at 28523a9)       Rerun: 1
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
    "my-active-loans",
    "check-in-book",
    "my-loans-without-returned-book",
    "loans-awaiting-return",
    "notify-member-of-overdue-loan",
    "overdue-notices-sent"
  ],
  "missingSlices": [
    "active-loans",
    "return-book",
    "active-loans-after-return",
    "loans-to-check",
    "send-overdue-notice",
    "notice-log"
  ],
  "businessEventRecall": 1,
  "stateChangeSlices": 2,
  "entityClusteredSlices": 0,
  "entityClusteredRate": 0,
  "todoViews": 1,
  "todoInboundLines": 2,
  "todoInboundLinesPerView": {
    "loans-awaiting-return/view.loans-awaiting-return": 2
  },
  "storylineReadsWithoutAfter": 0,
  "storylineReadsWithoutAfterPairs": []
}
```

## Notes

To-do view `Loans Awaiting Return from "Book Borrowed", "Book Returned"`: both sources drawn (2 inbound lines). `after` declared on the chase storyline (0 reads without after).
