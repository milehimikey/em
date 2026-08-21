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

That's it. No message text, no field names, no slice content, no participant names beyond
what's already in the state file's Participants/Decisions sections you already choose to commit.

## Categories

`em validate`'s `Diagnostic` type carries only `{severity, message, line}` — there's no
structured category field to copy from, and the runtime message text doesn't match
[validation.md](validation.md)'s table wording verbatim (it's generated per-instance, with
element names interpolated in). Logging the raw message would also risk leaking domain
content the rest of this convention deliberately excludes.

So the category is a fixed vocabulary instead: a `usageCategory` string on every entry in the
`RULES` registry (`src/model/rules.ts`), generated below by `scripts/generate-skill-docs.ts` —
the same mechanism that keeps [em-dsl.md](../.claude/skills/event-modeling/reference/em-dsl.md)'s
validate-rules appendix current (MIL-92, extended for this table by MIL-97). A new rule shows up
here the moment it's registered; don't hand-edit these tables — run `npm run docs:generate`.
**Use one of these exact strings** — a session that writes "read model with no source" and
another that writes "read model has no source" for the same rule silently splits one count
into two in the aggregation recipe below.

**Warnings**

<!-- GENERATED:usage-categories-warnings:start -- run `npm run docs:generate` to refresh, do not hand-edit -->
| Category |
|---|
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
| duplicate name referenced |
| duplicate slice name |
| duplicate type name |
| duplicate type ref |
| event field not provided by command |
| event has no producing command |
| event not read by any read model |
| extra doc-binding note ignored |
| implemented without link |
| invalid or missing frontmatter |
| model element missing from doc |
| open issue |
| reaction triggers no command |
| read model has no consumer |
| read model has no source |
| slice-ready slice has no doc bound |
| slice-ready slice has unchecked open questions |
| slice-ready slice not ready-to-implement |
| translation name collision |
| ui shares slice with reaction |
| ui with no view or command |
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

Every `.event-modeling.md` in a repo (or across several, if models live in more than one) can be
swept with plain `grep`. From a directory containing one or more models:

```sh
# Tally how often each phase shows up in a Usage log line
find . -name '.event-modeling.md' -exec grep -h '^- .*phases:' {} + \
  | grep -oE 'phases: [^—]+' | tr ',' '\n' | sed 's/phases: //' \
  | awk '{$1=$1;print}' | sort | uniq -c | sort -rn

# Tally how often each validate diagnostic category shows up
find . -name '.event-modeling.md' -exec grep -h '^- .*validate:' {} + \
  | grep -oE 'validate: .+$' | sed 's/validate: //' | tr ',' '\n' \
  | awk '{$1=$1;print}' | grep -v '^none$' | sort | uniq -c | sort -rn
```

(Both lines split on the em dash, `—`, so they need a UTF-8 locale — the default on macOS and
most CI images. Under `LC_ALL=C` the split can misbehave; run `export LC_ALL=en_US.UTF-8`
first if that's the environment.)

That's the raw material for the next roadmap engagement's facilitation and CI-urgency calls —
which skill phases the team actually spends time in, and which validate warnings recur often
enough to be worth designing around, instead of guessing from the code. Counts are only as
clean as entries sticking to the fixed [Categories](#categories) list above.
