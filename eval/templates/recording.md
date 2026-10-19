# Recording sheet (one per input x arm x rerun)

Input: <name>            Arm: A | B | B' | C | D            Rerun: 1 | 2 | 3
Date: <yyyy-mm-dd>       Run by: <initials>
em version: <x.y.z>      Skill bundle version: <x.y.z>      Model / effort: <id> / <level>
Fresh session, no shared context, reference not shown: yes / no

## Mechanical (paste `score.mjs --json` output)

producedSlices:            referenceSlices:
overDecompositionRate:     slicesPerReaction:
extraSlices:               missingSlices:
businessEventRecall:       entityClusteredRate:   (clustered / state-change slices)
`em validate` errors / warnings:

Renamed-but-equivalent slices reconciled by hand (produced key = reference key):

## Human-labelled

Elements labelled (commands / events / views):
Implementation-flavoured elements: <n> of <n>  ->  rate:   (list the names)
Intent-named commands: <n> of <n>  ->  rate:
Views produced: <n>   Distinct information needs in the input: <n>   Redundant views: <n>
  -> read-models-per-information-need:

## Session

Decisions escalated to the human: <n>   Slices produced: <n>   -> human-routing rate:
Tokens in / out (or cost): <n> / <n>      Wall-clock minutes:      em CLI calls:
Notes (stuck points, STOP gates, anything odd):
