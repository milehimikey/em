# GH #450 — implement/engagement: capture bindings at implement time

## What was built

Skill/agent/doc prose only — no `src/` changes, no behavior change to any CLI command.

1. **`event-modeling-implement` skill** (`.claude/skills/event-modeling-implement/`):
   - `reference/implement.md` §5 (Definition of done) gains a new bullet: the implementer writes
     or updates `conformance/bindings/<slice-key>.yaml` per `docs/bindings.md`'s schema as part
     of done-ness, and must run `em conform bindings check <model>.em --repo <path> --slice
     <slice-key> --exit-code` (exit 0 required) before calling the slice done. Notes that a
     continuation (`again`) key has no bindings file of its own — its bindings live in the
     originating slice's file.
   - `SKILL.md`'s "In short" summary paragraph gets the matching one-line addition so the
     condensed contract isn't silently out of step with the full reference.

2. **`em-implementer` agent** (`.claude/agents/em-implementer.md`): new "## Bindings file"
   section, phrased for the dispatched worker — same write-it/verify-it-before-reporting-done
   contract, worded for the engagement context (slice key + worktree it was given).

3. **`event-modeling-conform` skill** (`.claude/skills/event-modeling-conform/`):
   - `reference/conform.md` §2 ("Anchored, evidence-first verification") gains a new lead-in
     before the numbered walk: check for `conformance/bindings/<key>.yaml` first. If it exists,
     verify with `em conform bindings check ... --slice <key>` and scope the rest of the walk
     through it (re-read only what the check reports failing, or what `conform-scope`'s
     `changedPaths` says moved) — never re-derive evidence the file already gives clean. If it
     doesn't exist, walk the slice normally and **backfill** the file from that walk's own
     evidence once gathered — explicitly framed as advisory tooling catching up a gap, not a
     model/doc edit, so the existing "advisory-only, never gates, never an unprompted edit"
     stance (the file's own "Stance" section) stays intact.
   - Two new Anti-patterns entries: re-deriving evidence a verified bindings file already gives,
     and skipping the backfill when a slice has none.
   - `SKILL.md`'s "In short" paragraph gets the matching one-line addition.

4. **`event-modeling-engagement` skill**: its validator/reviewer checklists DO enumerate the
   implementer's deliverables — `.claude/agents/em-validator.md`'s numbered `## Checks` list
   (1-7, mechanical PASS/FAIL checks) and `reference/engagement.md`'s evidence-bundle table
   (copied verbatim into what the human sees). Both gained a matching row:
   - `em-validator.md`: new check 8 — `conformance/bindings/<key>.yaml` exists and `em conform
     bindings check <model.em> --repo <worktree path> --slice <key> --exit-code` exits 0.
   - `reference/engagement.md`: a matching row in the evidence-bundle's validator table so the
     human sees the same check reported back.
   `em-reviewer.md`/`em-critic.md` have no deliverables enumeration (their job is judgment —
   spec fidelity, isolation, constitution conformance, cited findings) — left untouched, nothing
   to join there.

5. **`docs/bindings.md`**: new "Who writes this file" section (placed right after the intro,
   before "Why per-slice") — implementer at implement time (any implementer, em-aware or not,
   since this is a file contract); a slice that ships without one gets it backfilled by its
   first scoped conform walk; every walk after that verifies and scopes through it. Cross-links
   `process.md#handing-a-slice-to-an-agent` and the implement skill's §5.
   `docs/process.md`'s "Handing a slice to an agent" list gained a new step 3 (old steps 3-4
   renumbered 4-5) pointing back at bindings.md and naming the same verify command. Checked
   `docs/ai-workflow.md` too — its phase table is a compact one-line-per-phase summary that
   doesn't itemize other per-phase artifacts (e.g. `mark-implemented`, `em slice index`) either,
   so I left it alone rather than adding an inconsistent level of detail there; process.md's
   numbered hand-off list was the natural, and sufficient, anchor.

Regenerated plugin copies: `npm run docs:generate` (writes `plugin/agents/em-implementer.md`,
`plugin/agents/em-validator.md`, `plugin/skills/conform/{SKILL.md,reference/conform.md}`,
`plugin/skills/engagement/reference/engagement.md`, `plugin/skills/implement/{SKILL.md,
reference/implement.md}`). `npm run docs:check` passes (parity gate green).

## Upgrading note

nothing — process/skill guidance; existing projects unaffected.

## Files touched

- `.claude/agents/em-implementer.md`
- `.claude/agents/em-validator.md`
- `.claude/skills/event-modeling-conform/SKILL.md`
- `.claude/skills/event-modeling-conform/reference/conform.md`
- `.claude/skills/event-modeling-engagement/reference/engagement.md`
- `.claude/skills/event-modeling-implement/SKILL.md`
- `.claude/skills/event-modeling-implement/reference/implement.md`
- `docs/bindings.md`
- `docs/process.md`
- `plugin/agents/em-implementer.md`
- `plugin/agents/em-validator.md`
- `plugin/skills/conform/SKILL.md`
- `plugin/skills/conform/reference/conform.md`
- `plugin/skills/engagement/reference/engagement.md`
- `plugin/skills/implement/SKILL.md`
- `plugin/skills/implement/reference/implement.md`

## Test evidence

- `npm run typecheck` -- clean (`tsc -p tsconfig.test.json`, no output).
- `npm run build` -- clean (`tsc -p tsconfig.json`, no output).
- `npm run docs:check` -- `docs:check — ok, generated sections match the committed skill docs`.
- `npm test` (full suite, foreground): **154 passed, 1 failed** test files; **3850 passed, 1
  skipped, 1 failed** of 3852 tests. The one failure is `test/apiSurfaceJson.test.ts` > "field
  type resolution (R7, shared with em api generate/check) > resolves every table scalar, bare
  and array" -- expects `tsType: "string"` for a `uuid` scalar field, gets `tsType: "Uuid"`.
  Re-ran that file in isolation (`npx vitest run test/apiSurfaceJson.test.ts`) and got the exact
  same deterministic failure both times -- not a timeout flake. This PR touches no `src/` or
  `test/` file (`git diff --name-only -- src/ test/` is empty), so the failure pre-exists on
  `main` at this branch's base commit (`2c08db26`, GH #449's merge) and is unrelated to #450's
  scope (a `uuid`-TypeScript-type-mapping question in `em api surface`/`em api generate`, not
  bindings). Noted here per the briefing's instruction to record both runs rather than silently
  re-run-until-green; not touched, since it's outside this ticket's scope.

## Deviations from the issue

None. The issue's four asks (implement skill, em-implementer agent, conform skill backfill-and-
verify rule, engagement validator-checklist join) and the docs/bindings.md "who writes this"
section were all implemented as described in GH #450 and the #449 schema it depends on.
