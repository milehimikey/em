# Recording sheet (one per input x arm x rerun)

Input: <name>            Input class: PRD | spec-with-walkthroughs | mixed
Arm: A | B | C | D       Rerun: 1 | 2 | 3
Date: <yyyy-mm-dd>       Run by: <initials>
em version (`em --version`): <x.y.z>      Plugin / marketplace pin: <em@em-x-y-z>      Entry point used:
Model / effort: <id> / <level>
Profile (CLAUDE_CONFIG_DIR): <path or "fresh">      Memory disabled: yes / no
Empty work dir outside any repo: yes / no      No project CLAUDE.md, no .event-modeling.md: yes / no
Fixed opening message used verbatim: yes / no      Answering rule followed: yes / no
Reference not shown / not reachable: yes / no

## Mechanical (paste `score.mjs --json` output)

producedSlices:            referenceSlices:           reactions:
slicesPerReaction (PRIMARY):   referenceSlicesPerReaction:      sliceRatio:
aliasesUsed:               (attach aliases.json)
extraSlices:               missingSlices:
businessEventRecall:       entityClusteredRate:   (clustered / state-change slices)
`em validate` errors / warnings:

## Human-labelled

Elements labelled (commands / events / views):
Implementation-flavoured elements: <n> of <n>  ->  rate:   (list the names)
Intent-named commands: <n> of <n>  ->  rate:
Views produced: <n>   Distinct information needs in the input: <n>   Redundant views: <n>
  -> read-models-per-information-need:

## Session

Questions / STOP prompts raised: <n>   (of which "not specified" answers given: <n>)   Slices produced: <n>   -> human-routing rate:
Tokens in / out (or cost): <n> / <n>      Wall-clock minutes:      em CLI calls:
Notes (stuck points, STOP gates, anything odd):
