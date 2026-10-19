# Results summary (comes back from the day job; contains no input text)

Run period: <dates>      Run by: <initials>
em version(s): <...>     Model / effort: <...>
Inputs: <n> real pairs, labelled P1..Pn (shape: PRD | spec-with-walkthroughs | mixed). No names, no text.
Public set run too: yes / no

## Per arm (repeat the table for each arm run: A, B, B', C, D)

| Input | Slices run1/run2/run3 | Spread | Reference slices | Over-decomp (median) | Event recall (median) | Entity-clustered (median) | Impl-flavoured | Intent-named cmds | Read-models per need | Human-routing | Cost per input |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | 12/14/13 | 2 | 10 | 1.3 | 0.9 | 0.0 | 0.10 | 0.90 | 1.0 | 0.2 | 40k tokens |

## Rerun agreement (per input, per arm)

| Input | `em diff --json` (1,2): +added/-removed/~changed | (1,3) | (2,3) |
| --- | --- | --- | --- |
| P1 | +2/-1/~3 | +1/-1/~2 | +3/-2/~4 |

## Verdicts

- Arm where improvement flattened:
- Arm C spread > 2 on any input (arm D trigger): yes / no (inputs: )
- H0 (pipeline alone sufficient): holds / does not hold, because
- Arm D run: yes / no. If yes: H1 (more consistent across reruns): supported / not supported; H2 (better models): supported / not supported
- Recommendation on the Jev spike (MIL-252 / GH #300):

## Free-text observations (element names may be quoted; no input text)
