# Design: The `extract` Phase (issue #9) — ADR + Implementation Plan

**Status:** Accepted (2026-07-23). **Decision:** Option B — progressive disclosure. A ~12–15
line `extract` dispatch stub in `SKILL.md`; the full playbook in a new on-demand
`reference/extract.md`; state-template and trigger-description updates; a compact
stance-reconciliation section in `methodology.md`. **No CLI changes** in v1, and **no
restructuring** of the existing four phases.

Why in one breath: it keeps the always-loaded budget flat for greenfield sessions, loads
extract's cost only when extract runs, physically quarantines extract's current-state-only
stance from the greenfield "model what the business needs, not what the system does" stance
(the two are logical inverses — see `findings/skill-anatomy.md` §2), matches the pattern the
skill already uses for `methodology.md`/`em-dsl.md`, and matches Anthropic's sanctioned
progressive-disclosure skill-authoring pattern. Distribution is already solved: the skill ships
in the npm tarball and `em skill install` copies recursively, so a new reference file is
first-class with zero packaging work.

---

## Part 1 — Alternatives considered

Baseline numbers: `SKILL.md` 197 lines ≈ 3,100 tokens always loaded; `methodology.md` ≈ 3,000
and `em-dsl.md` ≈ 2,500 tokens on demand. The extract playbook is estimated at 120–160 lines
(~1,800 tokens).

| Criterion | A. Inline in SKILL.md | **B. Progressive disclosure** | C. Sibling skill | D. CLI/scripts |
|---|---|---|---|---|
| Greenfield always-load | ~3,700–4,000 tok (extract tax every session) | **~3,250 tok** (stub only) | 2 skill descriptions competing | = B |
| Extract-session load | in base | **+~1,800 tok, on demand** | full 2nd SKILL.md re-runs preconditions | = B (LLM still does the work) |
| Stance conflict | **unresolved** — both stances co-resident | **quarantined** in extract.md | resolved via duplication (drift risk) | n/a |
| Triggering | fine | **fine** (description gains extract terms) | overlap → wrong-skill misfires | not a trigger surface |
| Fidelity to #9 | full | **full** | full | partial |
| Maintainability | every future phase bloats core | **matches existing refs** | two files drift | new CLI surface, little gain |

**A. Inline expansion — rejected.** Adds ~600–900 tokens to every greenfield session for
content it never uses. The fatal flaw isn't size (still under the ~500-line SKILL.md budget) —
it's stance collision: the current-state-only override would sit permanently beside
methodology's "existing system behavior is a common source of fake events" posture, degrading
both flows. Also sets the precedent that every new phase grows the always-loaded core.

**C. Separate sibling skill (`event-modeling-extract`) — rejected.** Both skill descriptions
would always be loaded for triggering and would overlap heavily ("event-model a system"),
risking the wrong skill firing — including extract firing on greenfield asks. Duplicates
operating principles, preconditions, and the command reference into a second file that will
drift. Cross-skill handoff through the state file is clumsier than an in-skill phase for a flow
that is continuous with `model`/`slice`.

**D. CLI/script support — rejected for v1 (an honest "no").** The intelligence in extraction —
reading a codebase, judging which behaviors are business events, running a Socratic confirm
loop — is inherently LLM work done with the agent's own Grep/Read tools. Making it
deterministic would require AST parsing, language front-ends, or LLM calls, all of which
violate em's dependency-light, no-LLM-in-CLI philosophy. Candidate deterministic pieces were
scored and failed:
- *An extraction-oriented `em init` variant*: the skill already scaffolds from `templates/`; a
  flag adds CLI surface for ~zero gain.
- *A `# TBD` counter in `em validate`*: the only plausible piece — but it changes validate's
  contract from structural rules to authoring-progress telemetry, and the agent can
  `grep -c "# TBD"` trivially. **Parked** as a possible future nicety, not built.

**E. Hybrid B + minimal CLI — collapses to B**, since no CLI piece survived D's scrutiny.

**Restructuring the existing skill — deferred.** SKILL.md is 197 lines, well under budget, and
its four phase sections are terse (~15–25 lines each). Moving them to `phases/*.md` adds a
file-hop per phase and churns working content for zero token win. Extract alone earns
externalization because it is heavier (two modes + seven rounds) and carries the dangerous
stance override. If extract.md proves the pattern and more phases accrete, a uniform `phases/`
move can be reconsidered then.

---

## Part 2 — Implementation plan (for the BUILD engagement)

### Chaining decision (resolved)

`extract` is **discover's sibling for existing systems**, not a replacement for `model`. Its
seven rounds converge the same outputs as steps 1–4 (events, ordering, commands, views) but
*derived from the system* rather than invented. It ends with its own light completeness pass +
`em validate`, then chains into `model` (steps 5–7). An extracted model **skips `discover`**.

### 1. `SKILL.md` (modify)

- **Frontmatter description:** add `extract` to the phase list — "`extract` (derive a
  current-state model from an existing system/codebase)" — and extend the "Use when" clause:
  "…extract, reverse-engineer, or capture the current state of an existing/legacy/monolith or
  event-driven system as an event model." This wording is what makes the skill fire for the
  target ask.
- **Preconditions step 3** (`$ARGUMENTS` dispatch, lines 61–62): recognize `extract`; one-line
  note that for an existing system, `extract` replaces `discover`.
- **New `## Phase: extract` stub** (~12–15 lines) immediately after the `discover` section,
  plus a one-line pointer at the top of `discover` ("For an existing system, use `extract`
  instead"). Stub contents, and nothing more:
  - Goal: a faithful **current-state** model of an existing system.
  - First line: "Read `reference/extract.md` before doing any extract work — it carries a
    stance override that inverts methodology step 1."
  - The two modes, one line each (event-driven; procedural/monolith synthesis).
  - Extract replaces discover; unknowns parked as `# TBD`, never guessed; on convergence,
    chain to `model`.
- **em command reference:** unchanged (extract reuses `render`/`validate`).

### 2. `reference/extract.md` (create — the playbook, ~120–160 lines)

1. **Load contract:** read before running extract; this file overrides methodology step 1's
   stance for the duration of extraction.
2. **Stance override (current-state-only):** capture how the system behaves *today*; never
   invent future/desired state; don't idealize away warts. **Keep** the "is it an event?"
   filter (derived values and telemetry still aren't events). **Suspend** the
   anti-current-system caution — here the existing system *is* the subject. Unknown or
   ambiguous behavior → park as `# TBD`, never guess intended design.
3. **Mode detection** (agent's own Grep/Read over the codebase/docs): event-driven signals —
   event schemas, topics/streams, message/CDC handlers, an existing event vocabulary;
   procedural signals — transaction scripts, service methods, procedural docs, no event names.
   Agree the scope line with the user first; inventory the sources for the chosen mode.
4. **Mode-specific sourcing:** event-driven — lift past-tense facts from the emitted/consumed
   vocabulary, then filter; procedural — synthesize candidate events from observed state
   changes in behavior/docs, then filter.
5. **The ~7-round confirm-and-clarify loop** (each round converges one thing; mirror back and
   re-render between rounds):
   - **R1 — Candidate events:** extract/synthesize past-tense facts; apply the event test;
     ambiguous → `# TBD`.
   - **R2 — Timeline order:** as-is narrative order; actual actors/callers and real UI/API
     surfaces. First `em render` here.
   - **R3 — Commands/inputs:** map each event to the request that actually produces it today
     (imperative name); unclear triggers → `# TBD`.
   - **R4 — Read models/outputs:** the projections/queries the system actually serves; wire
     `from "Event"`. Start running `em validate`.
   - **R5 — Boundaries & reactions:** current automations/translations as-is (schedulers,
     integrations, consumers); respect the two-slice reaction → command → event split.
   - **R6 — Gap & TBD reconciliation:** walk the parked list; resolve only what the user can
     confirm as a *current-state fact*; the rest stay parked. Do **not** invent desired state.
   - **R7 — Convergence:** final `em render` + `em validate`; user confirms the current-state
     model; mark extraction complete in the state file; hand off to `model`.
6. **TBD convention:** inline `# TBD: <question>` comments in the `.em` next to the relevant
   element (native comment syntax — no parser change), mirrored 1:1 with the state file's Open
   Questions list. Never replace a `# TBD` with a guessed element.
7. **Validate/render cadence:** first render at R2, validate from R4 on, both at R7 (same
   reflect-and-re-render principle as the other phases).
8. **Handoff:** state file marks Source mode, extraction rounds ticked, decision logged; seed
   the slice inventory as `draft`; suggest `/event-modeling model`.
9. **Anti-patterns:** inventing desired state; importing screens/tables as events; guessing an
   unclear trigger instead of parking it.

### 3. `reference/methodology.md` (modify — compact, not a duplicate)

A short section (~15–20 lines): name the extract phase and purpose; state the stance inversion
authoritatively (current-state-only, faithful as-is; derived/telemetry filter still applies);
add a one-line guard at step 1 ("In extract mode this caution is deliberately suspended — see
`reference/extract.md`"); cross-reference extract.md for procedure. Methodology owns *stance*;
extract.md owns *procedure*.

### 4. `templates/state.md` (modify)

- Phase enum: `{{extract | discover | model | slice}}`.
- Session inputs: add `**Source mode:** {{greenfield | extract-event-driven |
  extract-procedural}}` and `**Existing system refs:** {{repo paths, schema/topic locations,
  docs}}`.
- New `## Extraction (existing-system) progress` block: the 7 rounds as checkboxes (extract
  sessions only); the existing steps 1–7 checklist stays for the `model`/`slice` phases that
  follow.

### 5. Docs (modify)

- `README.md` AI Assistant section: add `/event-modeling extract  # derive a current-state
  model from an existing system/codebase` to the command block, plus one sentence that the
  skill models greenfield **or extracts a current-state model from an existing event-driven or
  procedural system**.
- `docs/features.md`: one line noting current-state extraction support.

### 6. CLI and tests

**None.** Explicitly no `src/` changes. The parked `# TBD` validate reporter is documented
here as a possible future nicety only.

### Verification (BUILD engagement exit criteria)

1. **Triggering:** in a fresh session, "extract an event model from this codebase" and
   "reverse-engineer the events in this service" both fire the skill.
2. **Dispatch:** `/event-modeling extract` reads `reference/extract.md` and begins mode
   detection — not a greenfield brainstorm.
3. **Greenfield unaffected:** `/event-modeling discover` runs steps 1–4 without loading
   extract.md; no-arg resume still works; methodology step 1 text unchanged apart from the
   guard line; SKILL.md stays ~210 lines.
4. **State:** a short extract run writes Source mode + system refs, ticks rounds, sets phase
   `extract`, then suggests `model`.
5. **TBD:** `# TBD` comments render and validate cleanly (parser strips comments — verified)
   and mirror the Open Questions list.
6. **Packaging:** `em skill install --force` into a scratch project lands
   `reference/extract.md` (recursive copy — verified).
