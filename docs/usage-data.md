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

- **Phase(s) touched** — `discover`, `extract`, `model`, `slice`, `conform`, `validate`, `watch`.
- **Validate diagnostic categories hit** — the *rule name* from the tables in
  [validation.md](validation.md#warnings) (e.g. "command nothing triggers"), not the full
  instance message. `none` if `em validate` came back clean.

That's it. No message text, no field names, no slice content, no participant names beyond
what's already in the state file's Participants/Decisions sections you already choose to commit.

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

That's the raw material for the next roadmap engagement's facilitation and CI-urgency calls —
which skill phases the team actually spends time in, and which validate warnings recur often
enough to be worth designing around, instead of guessing from the code.
