# Usage data

em's own [roadmap](roadmap.md) has an admitted blind spot: there's no session transcripts,
telemetry, or feedback logs anywhere, so decisions about what to build next rest on
code-reading and judgment instead of observed pain. This is the fix — the cheapest one that
doesn't require a privacy-posture decision.

## What's captured, and where

The `event-modeling` skill's state file (`.event-modeling.md`, one per model — see
[ai-workflow.md](ai-workflow.md)) already gets updated at the end of every session with the
current phase, decisions made, and open questions. It now also gets a **Usage log** entry:

```markdown
## Usage log
- 2026-08-04: phases: discover, model — validate: command nothing triggers, read model nothing consumes
- 2026-08-11: phases: slice — validate: none
```

One line per session. Two things per line:

- **Phase(s) touched** — `discover`, `extract`, `model`, `slice`, `implement`, `conform`,
  `review`, `validate`, `watch`.
- **Validate diagnostic categories hit** — one of the fixed strings in
  [Categories](#categories) below, not the full instance message. `none` if `em validate` came
  back clean.

`em state log-usage <model>.em --phases <phase1,phase2,...>` (MIL-161, see
[cli.md](cli.md#em-state-log-usage-file)) writes this line for you: it runs the same checks
`em validate --json` runs, dedupes and sorts the diagnostics' `usageCategory` values itself, and
appends the canonically-formatted line — nothing to hand-run, dedupe, or format. That's also why
the earlier failure mode below (two sessions phrasing the same rule two different ways) can't
recur going forward: the phrasing always comes straight from the `RULES` registry, never free
recall.

That's it. No message text, no field names, no slice content, no participant names beyond
what's already in the state file's Participants/Decisions sections you already choose to commit.

## Categories

`em validate`'s `Diagnostic` type carries only `{severity, code, message, line, refs}` — no
`usageCategory` field of its own on the plain (non-`--json`) run, and the runtime message text
doesn't match [validation.md](validation.md)'s table wording verbatim (it's generated
per-instance, with element names interpolated in). Logging the raw message would also risk
leaking domain content the rest of this convention deliberately excludes. `em validate --json`
(MIL-128, see [cli.md](cli.md)) *does* carry `usageCategory` on every diagnostic, sourced from
this same table — `em state log-usage` dedupes the values straight off that array for the Usage
log line instead of re-deriving a category from the message text or the `code`. There's no
separate `--usage-categories` flag; the fixed vocabulary lives in this one field.

So the category is a fixed vocabulary instead: a `usageCategory` string on every entry in the
`RULES` registry (`src/model/rules.ts`), generated below by `scripts/generate-skill-docs.ts` —
the same mechanism that keeps [em-dsl.md](../.claude/skills/event-modeling-shared/reference/em-dsl.md)'s
validate-rules appendix current (MIL-92, extended for this table by MIL-97). A new rule shows up
here the moment it's registered; don't hand-edit these tables — run `npm run docs:generate`.
Because `em state log-usage` writes the line itself straight from this table, the historical
failure mode — a session hand-typing "read model with no source" while another hand-types "read
model has no source" for the same rule, silently splitting one count into two in
`em usage-report`'s aggregation below — can't recur for anything logged this way; it only ever
affected lines written by hand.

**Warnings**

<!-- GENERATED:usage-categories-warnings:start -- run `npm run docs:generate` to refresh, do not hand-edit -->
| Category |
|---|
| colliding slice doc path across models |
| command nothing triggers |
| command produces no event |
| cross-slice note not ratified by target doc |
| cross-slice note points nowhere |
| cross-slice note targets unusable doc |
| doc binding points at missing file |
| doc element missing from model |
| doc field table disagrees with model |
| doc pattern disagrees with model |
| duplicate element ref |
| duplicate model key |
| duplicate name referenced |
| duplicate seam |
| duplicate slice name |
| duplicate type name |
| duplicate type ref |
| event field not provided by command |
| event has no producing command |
| event not read by any read model |
| externally-fed reaction not bound by any seam |
| extra doc-binding note ignored |
| implemented without link |
| invalid or missing frontmatter |
| model element missing from doc |
| open issue |
| orphaned slice doc left behind by a rename or removal |
| public event not consumed by any seam |
| reaction triggers no command |
| read model has no consumer |
| read model has no source |
| slice-ready slice has no doc bound |
| slice-ready slice has unchecked open questions |
| slice-ready slice not ready-to-implement |
| translation name collision |
| ui shares slice with reaction |
| ui with no view or command |
| undeclared seam candidate |
| view field no source |
<!-- GENERATED:usage-categories-warnings:end -->

**Errors**

<!-- GENERATED:usage-categories-errors:start -- run `npm run docs:generate` to refresh, do not hand-edit -->
| Category |
|---|
| arrow endpoint unresolved |
| arrow points backward |
| composite tag references unknown field |
| duplicate tag key |
| event feeds earlier view instance |
| illegal connection |
| lineage forward dangling |
| lineage ref cycle |
| lineage ref malformed |
| lineage version impossible |
| reaction reads view before it exists |
| reaction references unknown read model |
| same-band collision |
| seam consumer not a reaction |
| seam endpoint unresolved |
| seam manifest invalid |
| seam manifest model key mismatch |
| seam source not public |
| slice-ready key does not exist |
| type cycle |
| view again with no earlier declaration |
| view references unknown event |
<!-- GENERATED:usage-categories-errors:end -->

A genuinely new rule gets its `usageCategory` added in `src/model/rules.ts` first — never
freelance a new string in a state file.

## Why this shape, not CLI telemetry

The alternative — instrumenting the CLI to phone home which commands run and which diagnostics
fire — was considered and set aside on purpose. It needs a privacy posture (what's collected,
where it goes, who can see it, opt-out) decided *before* any code ships, and that decision
wasn't made as part of shipping this. A git-native log sidesteps the question entirely:

- **Nothing leaves the repo.** The data lives in a file already committed alongside the model,
  under the same visibility and access control as everything else in git.
- **The team already trusts this file.** It's the same document holding the Decisions log and
  Open Questions — no new trust boundary to reason about.
- **It costs nothing to build.** No storage, no endpoint, no schema migration. Extending an
  existing markdown convention is the entire implementation.

The tradeoff: it's self-reported, so it's only as complete as the habit of filling it in — the
skill treats it the same as saving state, at the end of every session, so it isn't a task to
remember separately. If a future engagement needs richer signal, that's the point to revisit the
CLI-telemetry option deliberately, with its privacy posture decided up front.

## Aggregating across models for a retro

`em usage-report [root]` (MIL-161, see [cli.md](cli.md#em-usage-report-root)) walks `root`
(default the current directory) for every `.event-modeling.md` it can find, parses each Usage
log section, and tallies phase and category counts across all of them:

```sh
em usage-report .                # text summary: phase tally, category tally, sorted desc
em usage-report . --json         # the same counts as a versioned JSON document
```

This replaces the earlier hand-rolled `grep`/`awk`/`sort` pipeline (and its `LC_ALL=C` + UTF-8
em-dash locale caveat) with a plain, locale-independent parse — a line that doesn't match the
canonical `- YYYY-MM-DD: phases: ... — validate: ...` shape (hand-authored before `em state
log-usage` existed, or hand-edited since) is reported under `unparseableLines` instead of being
silently dropped or mis-split.

That's the raw material for the next roadmap engagement's facilitation and CI-urgency calls —
which skill phases the team actually spends time in, and which validate warnings recur often
enough to be worth designing around, instead of guessing from the code. Counts are only as
clean as entries sticking to the fixed [Categories](#categories) list above — which every line
written by `em state log-usage` always does.
