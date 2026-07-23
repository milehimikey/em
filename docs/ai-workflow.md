# Modeling with AI

Two commands get you a guided session:

```bash
em skill install     # copies the skill into .claude/skills/event-modeling/
```

then, in Claude Code:

```
/event-modeling
```

## What the skill is

`em` ships a Claude Code skill inside the npm package. It turns a modeling session into a
facilitated conversation: the AI asks focused questions one at a time — who acts, what fact
gets recorded, what must always be true — and builds the `.em` model from your answers. It
never invents domain facts; anything unresolved is parked as an open question instead of
guessed. Behind the scenes it drives the `em` CLI, re-rendering after each increment and
running `em validate` to keep the diagram honest.

`em skill install` copies the skill into your project (`--force` to overwrite an existing
copy), so it's versioned with your repo and works for anyone who opens it in Claude Code.

## Phases

`/event-modeling` takes an optional phase argument. With no argument it resumes wherever
the previous session left off.

| Phase | What it does | What it leaves behind |
|---|---|---|
| `discover` | Steps 1–4 for a greenfield process: brainstorm past-tense events, storyboard them, find the commands and read models | A draft `.em` with the happy-path spine |
| `extract` | The as-is sibling of discover: derives a current-state model from an existing system (event-driven or procedural), confirming each round with you | A validated as-is `.em`, unknowns parked as `# TBD` |
| `model` | Steps 5–7: group events into contexts, classify every slice as one of the [four patterns](patterns.md), check completeness | A structurally complete, validated model |
| `slice` | Deep-dive one slice at a time: fields, invariants, Given/When/Then scenarios, error flows | One implementation-ready `slices/<name>.md` per slice, wired in via `note` |
| `watch` | Starts `em watch --serve` in the background for a live team view | A running live viewer |
| `validate` | Walks every diagnostic with you and applies fixes, plus the one check the validator can't do itself | A clean `em validate` |

## What a session produces

```
<model-name>/
  <model-name>.em          # the model
  <model-name>.svg         # kept fresh by em watch
  live.html                # no-server fallback viewer (file://, ~2s poll)
  README.md                # overview + slice index
  .event-modeling.md       # session state — this is what makes sessions resumable
  slices/<slice-name>.md   # one implementation spec per slice
```

The `.event-modeling.md` state file records the current phase, decisions made, and open
questions, so you can stop mid-session and pick up in a fresh conversation days later.

## A complete worked example

The [em-with-ai repository](https://github.com/milehimikey/em-with-ai) is a full AI-built
model of a headless CPQ system — around 50 slices with slice specs — and shows what the
skill produces at real-world scale.
