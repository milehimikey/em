# Decision Log — extract-phase-architecture (INVESTIGATE → BUILD)

## Decisions

- 2026-07-23: **Mode INVESTIGATE**, deliverable = design doc + implementation plan; build in a
  follow-up engagement. — User sign-off during clarification.
- 2026-07-23: Restructuring the existing skill and CLI changes both *in scope* for the
  analysis; no pilot system, so both source modes weighted equally. — User sign-off.
- 2026-07-23: Recon split: skill anatomy read directly by the orchestrator (high-judgment
  input to the design); CLI/packaging mapped by an Explore agent. Skipped broader recon —
  terrain fully covered by these two.
- 2026-07-23: Design produced by one Opus-rubric Plan agent (architectural tradeoff task) with
  the full verified briefing; orchestrator verified its factual claims before acceptance.
- 2026-07-23: **Accepted Option B (progressive disclosure), no CLI in v1, no restructuring of
  existing phases.** Decisive argument: stance quarantine (current-state-only vs. greenfield
  "model the business need") on top of the flat always-loaded budget. See `design.md`.

## Verification record

Agent claims spot-verified against primary sources before entering `design.md`:

- `.em` `#` comments native and lexer-stripped (`em-dsl.md:63`, `src/parser/lexer.ts:4`) →
  `# TBD` parking needs no parser change. ✔
- Skill ships in npm tarball (`package.json` `files` includes `.claude/skills`); `em skill
  install` copies recursively (`src/cli.ts:142–161`) → new reference files ship for free. ✔
- README AI Assistant section and phase command block exist as described; `docs/features.md`
  lists CLI features + roadmap. ✔
- SKILL.md `$ARGUMENTS` dispatch at preconditions step 3 (lines 61–62). ✔ (direct read)
- `em validate` is structural-rules only, no progress telemetry (`src/model/validate.ts`). ✔

## BUILD (2026-07-23)

- User approved starting the BUILD on branch `live-serve-sse` (per standing preference to stay
  on the open PR branch). Decomposition: orchestrator executed all six files directly — one
  high-judgment playbook plus five small specified edits; worker delegation would have added
  cost and lost nuance (orchestrate-goal's own inverse rule). No waves, no escalations.
- Deviation from design.md: none material. `extract.md` came in at 123 lines (est. 120–160);
  SKILL.md stub ~20 lines (est. 12–15) to include the mode/loop/TBD summary bullets.
- Verification results: see `build-report.md`. All automatable criteria pass; fresh-session
  trigger test remains manual.

## Escalations

None. No worker output failed verification.

## Open questions

- The parked `# TBD` counter/reporter for `em validate` — revisit only if real extraction
  sessions want a deterministic completeness signal.
- Uniform `phases/` restructuring of all skill phases — reconsider if more phases accrete
  after extract proves the externalized-playbook pattern.
