# Results summary (comes back from the day job; contains no input text)

Run period: <dates>      Run by: <initials>
Model / effort: <...>
Inputs: <n> real pairs, labelled P1..Pn, each with its class (PRD | spec-with-walkthroughs | mixed). No names, no text.
Public set run too: yes / no

## Reference slicings

| Input | Author (initials) | Written before any arm ran | Blind to arm outputs | Reviewed by | Pre-check passed (validate clean; self-score 1.00 / recall 1.00 / clustered 0 / empty extra+missing) | Reference slices / reactions |
| --- | --- | --- | --- | --- | --- | --- |
| P1 | | yes/no | yes/no | | yes/no | 10 / 6 |

## Arms

| Arm | em version | Plugin pin | Entry point |
| --- | --- | --- | --- |
| A | | | |
| B | | | |
| C | | | |

## Per arm (repeat for A, B, C and D if run)

Per-run primary = slices per business reaction; reference value alongside.

| Input | Class | Slices run1/run2/run3 | Spread | Reference slices | Slices per reaction run1/run2/run3 (reference) | Median | Aliases used (r1/r2/r3) | Event recall (median) | Entity-clustered (median) | Impl-flavoured | Intent-named cmds | Read-models per need | Human-routing | Cost per input |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | PRD | 12/14/13 | 2 | 10 | 2.0/2.3/2.2 (1.7) | 2.2 | 1/0/2 | 0.9 | 0.0 | 0.10 | 0.90 | 1.0 | 0.2 | 40k tokens |

Inter-labeller agreement on the first input of this arm (human-labelled metrics): <percent>

## Rerun agreement (per input, per arm; diagnostic only, key-matched)

Added = slicesAdded + elementsAdded + typesAdded; removed = slicesRemoved + elementsRemoved + typesRemoved; changed = fieldChanges + fromChanges + sourceChanges + elementsMoved.

| Input | (1,2): +added/-removed/~changed | (1,3) | (2,3) |
| --- | --- | --- | --- |
| P1 | +2/-1/~3 | +1/-1/~2 | +3/-2/~4 |

## Verdicts

- Arm C spread > 2 on any input (arm D trigger): yes / no (input classes: )
- Flattening: C vs B primary within 0.1 on every input: yes / no
- H0 (C within 0.9 to 1.25 of the reference slices per reaction, recall >= 0.9, spread <= 2, on every input): holds / does not hold, because
- Arm D run: yes / no. If yes: H1 (more consistent across reruns): supported / not supported; H2 (better models): supported / not supported. If no: H1 moot.
- Recommendation on the Jev spike (MIL-252 / GH #300):

## Free-text observations (element names may be quoted; no input text)
