# Recording sheet — GH #423 extraneous lines (toolshed, arm before)

Input: toolshed            Input class: spec-with-walkthroughs (reconstructed from the toolshed-v2 slice docs; see input.md header)
Arm: C (1.20.0 skills, main at 28523a9)       Rerun: 1
Date: 2026-11-04       Run by: orchestrator (sonnet worker, in-session)
em version: main after #436 (schema 1.20)      Entry point used: discover SKILL.md + design SKILL.md model phase, read from the main checkout's skills directory
Model / effort: claude-sonnet-5-5 / default
Profile: in-session sub-agent, empty work dir outside any repo      Memory disabled: n/a
Fixed opening message used: adapted (worker prompt: follow the skills, no questions, "not specified" rule, stop after the model phase)
Reference not shown / not reachable: yes

> Deviation from the protocol: in-session worker run, not a fresh profile with the plugin pinned. Same setup for both arms; only the skills directory differed. Slicing-granularity metrics do not apply to this input; the line-shape metrics do.

## Mechanical (score.mjs --json)

```json
{
  "input": "toolshed",
  "reactions": 8,
  "producedSlices": 63,
  "referenceSlices": 29,
  "slicesPerReaction": 7.875,
  "referenceSlicesPerReaction": 3.625,
  "sliceRatio": 2.1724137931034484,
  "aliasesUsed": 0,
  "extraSlices": [
    "add-tool",
    "tool-inventory",
    "tool-catalog",
    "register-neighbor",
    "neighbors",
    "my-account",
    "change-email",
    "my-account-email-changed",
    "check-out-tool",
    "tool-inventory-and-catalog-checked-out",
    "my-loans",
    "extend-loan",
    "my-loans-and-tool-inventory-extended",
    "return-tool",
    "my-loans-and-tool-inventory-returned",
    "tool-catalog-returned",
    "my-loans-notice-sent",
    "my-loans-notice-failed",
    "place-hold",
    "my-holds",
    "tool-catalog-hold-placed",
    "undelivered-notices-and-my-holds-pickup-notice-failed",
    "cancel-hold",
    "my-holds-hold-cancelled",
    "tool-catalog-hold-cancelled",
    "neighbors-flagged",
    "suspend-neighbor",
    "neighbors-and-my-account-suspended",
    "reinstate-neighbor",
    "neighbors-and-my-account-reinstated",
    "retire-tool",
    "tool-inventory-and-my-holds-tool-retired",
    "tool-catalog-tool-retired",
    "my-loans-tool-retired",
    "record-tool-lost",
    "tool-inventory-and-my-holds-tool-lost",
    "tool-catalog-tool-lost",
    "my-loans-tool-lost",
    "close-account",
    "my-account-and-neighbors-account-closed",
    "my-holds-account-closed",
    "tool-catalog-account-closed"
  ],
  "missingSlices": [
    "my-loans-overdue-notice-sent",
    "my-loans-overdue-notice-failed",
    "undelivered-notices-hold-collected",
    "my-holds-pickup-notice-failed",
    "undelivered-notices-pickup-notice-failed",
    "my-loans-hold-expired",
    "undelivered-notices-hold-expired",
    "neighbors-neighbor-flagged"
  ],
  "businessEventRecall": 1,
  "stateChangeSlices": 13,
  "entityClusteredSlices": 0,
  "entityClusteredRate": 0,
  "todoViews": 6,
  "todoInboundLines": 9,
  "todoInboundLinesPerView": {
    "overdue-loans-to-notify/view.overdue-loans-to-notify": 3,
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

63 slices, 7 storylines chained with `after` (0 cross-story reads without `after` — the 1.20.0 skills already push `after`). No `updates from` (the 1.20.0 skills do not know the clause), so every legitimate source of a to-do list is drawn: see the per-view counts above. `validate`: 0 errors, 7 `view-lookup-source` warnings, left as genuine cross-context row changes.
