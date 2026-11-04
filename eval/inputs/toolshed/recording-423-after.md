# Recording sheet — GH #423 extraneous lines (toolshed, arm after)

Input: toolshed            Input class: spec-with-walkthroughs (reconstructed from the toolshed-v2 slice docs; see input.md header)
Arm: E (1.21.0 skills, gh-423)       Rerun: 1
Date: 2026-11-04       Run by: orchestrator (sonnet worker, in-session)
em version: main after #436 (schema 1.20)      Entry point used: discover SKILL.md + design SKILL.md model phase, read from the branch's skills directory
Model / effort: claude-sonnet-5-5 / default
Profile: in-session sub-agent, empty work dir outside any repo      Memory disabled: n/a
Fixed opening message used: adapted (worker prompt: follow the skills, no questions, "not specified" rule, stop after the model phase)
Reference not shown / not reachable: yes

> Deviation from the protocol: in-session worker run, not a fresh profile with the plugin pinned (1.21.0 unreleased). Same setup for both arms; only the skills directory differed. Slicing-granularity metrics do not apply to this input (its step names echo the reference); the line-shape metrics do.

## Mechanical (score.mjs --json)

```json
{
  "input": "toolshed",
  "reactions": 8,
  "producedSlices": 69,
  "referenceSlices": 29,
  "slicesPerReaction": 8.625,
  "referenceSlicesPerReaction": 3.625,
  "sliceRatio": 2.3793103448275863,
  "aliasesUsed": 0,
  "extraSlices": [
    "add-tool",
    "tool-inventory",
    "tool-catalog",
    "register-neighbor",
    "neighbors",
    "my-account",
    "change-email",
    "my-account-with-new-email",
    "check-out-tool",
    "tool-catalog-with-loan",
    "tool-inventory-with-loan",
    "my-loans",
    "extend-loan",
    "my-loans-extended",
    "return-tool",
    "my-loans-returned",
    "tool-catalog-returned",
    "tool-inventory-returned",
    "my-loans-notice-sent",
    "my-loans-notice-failed",
    "place-hold",
    "my-holds",
    "tool-catalog-with-hold",
    "my-holds-ready-for-pickup",
    "tool-catalog-set-aside",
    "my-holds-notice-sent",
    "my-holds-notice-failed",
    "undelivered-notices-with-pickup",
    "my-holds-expired",
    "tool-catalog-expired",
    "cancel-hold",
    "my-holds-cancelled",
    "my-holds-collected",
    "neighbors-flagged",
    "suspend-neighbor",
    "neighbors-suspended",
    "my-account-suspended",
    "reinstate-neighbor",
    "neighbors-reinstated",
    "my-account-reinstated",
    "retire-tool",
    "tool-catalog-retired",
    "tool-inventory-retired",
    "my-loans-retired",
    "my-holds-retired",
    "record-tool-lost",
    "tool-inventory-lost",
    "tool-catalog-lost",
    "my-loans-lost",
    "my-holds-lost",
    "close-account",
    "neighbors-closed",
    "my-account-closed",
    "my-holds-closed"
  ],
  "missingSlices": [
    "my-loans-overdue-notice-sent",
    "my-loans-overdue-notice-failed",
    "my-holds-hold-collected",
    "undelivered-notices-hold-collected",
    "tool-catalog-hold-fulfilled",
    "my-holds-hold-fulfilled",
    "my-holds-pickup-notice-sent",
    "my-holds-pickup-notice-failed",
    "undelivered-notices-pickup-notice-failed",
    "my-loans-hold-expired",
    "my-holds-hold-expired",
    "tool-catalog-hold-expired",
    "undelivered-notices-hold-expired",
    "neighbors-neighbor-flagged"
  ],
  "businessEventRecall": 1,
  "stateChangeSlices": 13,
  "entityClusteredSlices": 0,
  "entityClusteredRate": 0,
  "todoViews": 6,
  "todoInboundLines": 7,
  "todoInboundLinesPerView": {
    "overdue-loans-to-notify/view.overdue-loans-to-notify": 1,
    "holds-to-fulfill/view.holds-to-fulfill": 2,
    "pickup-notices-to-send/view.pickup-notices-to-send": 1,
    "pickups-to-expire/view.pickups-to-expire": 1,
    "holds-to-collect/view.holds-to-collect": 1,
    "neighbors-to-flag/view.neighbors-to-flag": 1
  },
  "storylineReadsWithoutAfter": 0,
  "storylineReadsWithoutAfterPairs": []
}
```

## Notes

69 slices, 7 storylines chained with `after` (6 `after` clauses; 0 cross-story reads without `after`). 3 `updates from` clauses. To-do inbound lines 7 over 6 to-do views: every to-do list has one drawn line except Holds To Fulfill with two (Hold Placed and Tool Returned, both genuine triggers). `validate`: 0 errors, 7 `view-lookup-source` warnings, all accepted by the worker as cross-context row changes (catalog/inventory read lending and hold events); it did not read the PRD-path and rubric references, which the prompt had not listed.
