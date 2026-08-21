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

## Implementing outside Claude Code

The facilitation phases (`discover`/`extract` → `model` → `slice`) are Claude Code sessions,
but the `implement` phase's [agent guide](../.claude/skills/event-modeling/reference/implement.md)
is written to apply to *any* implementing agent. `em contract` prints that guide to stdout —
no `.claude/` awareness or vendored skill copy required — and `em skill install`/`em skill
sync` write a matching pointer into the repo's `AGENTS.md` by default, alongside the
readiness gate (`em validate --slice-ready --json`) and the machine-readable read path
(`em export --slice`). See [cli.md](cli.md#em-contract) and
[cli.md](cli.md#working-with-an-ai-agent-the-agentsmd-managed-section).

An agent that speaks MCP natively can skip the shell entirely: `em-mcp` (or `em mcp`) starts a
stdio MCP server exposing the same contract, readiness gate, and read path — plus full
`validate`/`export`/marker-listing access — as tools instead of CLI flags. See
[mcp.md](mcp.md).

## Phases

`/event-modeling` takes an optional phase argument. With no argument it resumes wherever
the previous session left off.

Most phases run once per model, in roughly the order below — but `implement` runs **once per
ratified slice**, and `conform` is a **recurring** one, run again whenever the codebase has
moved. [workflow.md](workflow.md) puts these phases
in the context of a model's whole life, alongside the CLI commands (`em diff`, `em changelog`)
that live between sessions.

| Phase | What it does | What it leaves behind |
|---|---|---|
| `discover` | Steps 1–4 for a greenfield process: brainstorm past-tense events, storyboard them, find the commands and read models | A draft `.em` with the happy-path spine |
| `extract` | The as-is sibling of discover: derives a current-state model from an existing system (event-driven or procedural), confirming each round with you | A validated as-is `.em`, unknowns parked as `# TBD` |
| `model` | Steps 5–7: group events into contexts, classify every slice as one of the [four patterns](patterns.md), check completeness | A structurally complete, validated model |
| `slice` | Deep-dive one slice at a time: fields, invariants, Given/When/Then scenarios, error flows | One implementation-ready `slices/<name>.md` per slice, wired in via `note` |
| `implement` | Builds one **ratified** slice into code, following the bundled [agent guide](../.claude/skills/event-modeling/reference/implement.md): readiness-gated (`em validate --slice-ready`), slice doc treated as the read-only spec, gaps surfaced to you rather than decided silently | A merged PR; the slice doc flipped to `implemented` with its `implementedIn` link |
| `conform` | Checks a ratified model (and its slice docs) against the codebase that implements it: evidence-first per-slice walk, `em diff --json` for structural drift, findings classified with cited evidence | An advisory `conformance/<date>-report.md` with proposed red notes you ratify |
| `watch` | Starts `em watch --serve` in the background for a live team view | A running live viewer |
| `review` | Facilitated stakeholder walkthrough: steps the live viewer's Review mode through slices one at a time, capturing anything the room raises as `issue "..."` red notes | Triaged issues; a `Last stakeholder review:` marker in the state file |
| `validate` | Walks every diagnostic with you and applies fixes, plus the one check the validator can't do itself | A clean `em validate` |

## What a session produces

```
<model-name>/
  <model-name>.em               # the model
  <model-name>.svg              # kept fresh by em watch
  live.html                     # no-server fallback viewer (file://, ~2s poll)
  README.md                     # overview + slice index
  .event-modeling.md            # session state — this is what makes sessions resumable
  slices/<slice-name>.md        # one implementation spec per slice
  conformance/<date>-report.md  # conform-phase drift reports (advisory)
```

The `.event-modeling.md` state file records the current phase, decisions made, open questions,
and a Usage log (phases touched, validate diagnostic categories hit — see
[usage-data.md](usage-data.md)), so you can stop mid-session and pick up in a fresh conversation
days later.

## A complete worked example

The [em-with-ai repository](https://github.com/milehimikey/em-with-ai) is a full AI-built
model of a headless CPQ system — around 50 slices with slice specs — and shows what the
skill produces at real-world scale.
