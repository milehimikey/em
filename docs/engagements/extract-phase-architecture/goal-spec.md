# Goal-Spec: Extract-Phase Architecture for em (issue #9)

Signed off 2026-07-23. Mode: **INVESTIGATE** — deliverable is `design.md` (ADR + implementation
plan); implementation happens in a follow-up BUILD engagement.

## Goal statement

Determine and document the best architecture for adding an "extract a current-state event model
from an existing system" capability (GitHub issue #9) to em, explicitly deciding where the
capability lives: skill directives, on-demand reference files, scripts, first-class `em` CLI
support, or a hybrid.

## Why now / decision informed

Issue #9 is blocked on an architecture decision, not on ideas. The result decides what the
follow-up BUILD engagement builds, and sets the precedent for how future phases are added
without degrading the skill.

## Success criteria

1. ≥ 3 distinct architectures evaluated against explicit criteria: token/context cost per
   session type, skill-triggering effectiveness, maintainability, and fidelity to issue #9's
   requirements (two source modes, ~7-round confirm loop, current-state-only capture, `# TBD`
   parking, `em validate`/`render` integration).
2. Each architecture's context-cost impact estimated concretely (what loads when, approximate
   line/token counts) — not hand-waved.
3. A single recommendation with ADR-style rationale and rejected-alternative reasoning.
4. The implementation plan names files to create/modify with enough detail that a BUILD
   engagement can execute without re-deriving the design.
5. The design addresses how `extract` chains into the existing `discover`/`model`/`slice`
   phases and the `.event-modeling.md` state file.

## In scope / out of scope

**In:** restructuring the existing skill (e.g., per-phase files) if analysis favors it; new
`em` CLI commands/scripts if favored; both source modes (event-driven and procedural
synthesis) designed generically.

**Out:** implementing anything; modeling any specific real system; `.em` DSL or renderer
changes beyond what extract strictly needs.

## Deliverable form and location

`docs/engagements/extract-phase-architecture/` in the em repo: this spec, `findings/`,
`decisions.md`, and the final `design.md` (ADR + implementation plan).

## Constraints

- Preserve the methodology's discipline: confirm loops, current-state-only capture, TBD parking.
- Must not degrade the existing skill's effectiveness for greenfield modeling.
- em stays dependency-light (Node ≥ 18, self-contained, no LLM calls in the CLI).

## Quality bar

Publishable design doc; audience is the maintainer plus a future implementing agent
(agent-friendly-docs standards).

## Assumptions and known unknowns

- Assumes the skill continues to ship inside the em repo at `.claude/skills/event-modeling/`
  (verified: it also ships in the npm tarball via `files`, installed by `em skill install`).
- No pilot system chosen, so both source modes are weighted equally.
- Skill-loading mechanics for on-demand reference files were verified during recon (the skill
  already uses the pattern for `reference/methodology.md` and `reference/em-dsl.md`), not assumed.
