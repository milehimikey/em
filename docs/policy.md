# `em-policy.yaml` — process policy, declared once

Process choices that used to be remembered per run (`--no-ref`, a hand-kept list of prose
sections) are declared in one project file, `em-policy.yaml` (GH #493, em 1.23.0). It is its own
page rather than a section of [cli.md](cli.md) because it is a file format with a schema and a
discovery rule that several commands read, not a command.

```yaml
policySchemaVersion: "1.0"        # required
merge: squash                     # squash | rebase | merge-commit
review: pull-request              # session | pull-request
ratification:
  inline: internal                # internal | never | always
  inline-violation: advisory      # advisory | error
amendment:
  prose-sections:                 # overrides em's default prose list
    - Intent
    - Notes
ratifiers:                        # the roster lists, unchanged: see slice-doc-schema.md#who-may-ratify
  - name: Alex
reviewers:
  - name: Sam
```

Every key except `policySchemaVersion` is optional. **No file means today's behaviour for every
key; nothing here is breaking.**

## Keys

| Key | Default | Effect today |
|---|---|---|
| `merge` | `merge-commit` | `squash` and `rebase` make `em slice ratify` record the hash only, as if `--no-ref` were passed, and say so on stderr. `merge-commit` (or no key) records `ratifiedRef:` as before. |
| `review` | `session` | **Parsed and shown in `em status`; no command changes yet.** Reserved for the review-by-pull-request work (GH #494). |
| `ratification.inline` | `internal` | Read by [`em inline-check`](cli.md#em-inline-check-file---base-rev) (GH #496): which slices may be ratified on the same branch as their implementation. `internal` reports a public-touching slice ratified inline, `never` reports any, `always` none. |
| `ratification.inline-violation` | `advisory` | Severity of an `em inline-check` finding: `advisory` prints a warning and exits 0, `error` exits non-zero. |
| `amendment.prose-sections` | em's list: `Intent`, `Trigger & Actor`, `Dependencies & Read Models Affected`, `Consumed by` | Replaces the list that classifies a slice doc's sections as prose or behaviour. A heading not listed is behaviour. Used today by `em export --doc-json`'s per-slice `sections`. |
| `ratifiers`, `reviewers` | none (unrestricted) | The roster: same shape and meaning as in [slice-doc-schema.md](slice-doc-schema.md#who-may-ratify). |

Unknown keys, a missing or unsupported `policySchemaVersion`, and a value outside its allowed set are
`policy-invalid` errors that name the key and the allowed values ([validation.md](validation.md)).
`em slice ratify` refuses on one rather than fall back to defaults; `em status` reports it per model
and still succeeds.

## Discovery

Exactly like the roster: the nearest `em-policy.yaml` walking up from the model's directory to the
repo root (the directory holding `.git`); with no `.git` above the model, only the model's own
directory is searched. One file can serve several models.

## Flags and policy

An explicit flag on the command line always works. `em slice ratify --no-ref` keeps recording the
hash only under any `merge:` value. There is **no flag to force a `ratifiedRef:` against
`merge: squash|rebase`** in this release: change the policy for that.

## The roster moved here

The roster used to live in `ratifiers.yaml` (`rosterSchemaVersion: "1.0"`). It is now the
`ratifiers:`/`reviewers:` lists of `em-policy.yaml`, with identical shape and behaviour.

- A repo with only a `ratifiers.yaml` keeps working: it is read, with a one-line deprecation notice
  on stderr naming `em upgrade`.
- With both files in one directory, `em-policy.yaml` wins and a notice says the other is ignored.
- `em upgrade`'s `policy-file` step (since 1.23.0) moves a `ratifiers.yaml` into `em-policy.yaml`:
  content verbatim, comments kept, `rosterSchemaVersion` replaced by `policySchemaVersion`. It
  refuses rather than guess when an `em-policy.yaml` already exists beside it.
- `--roster <path>` accepts either file. `em roster init` writes `em-policy.yaml`; `em roster check`
  and `em ci init`'s roster job work with either.
- An `em-policy.yaml` with no `ratifiers:`/`reviewers:` does not make a roster (nobody is
  restricted), and does not hide a legacy `ratifiers.yaml` further up.

## Seeing the effective policy

`em status` prints the effective policy for each model, each key with where its value came from (the
file path, or `default`); `--json` carries the same under `policy` (status schema `1.13`,
[cli.md](cli.md#em-status-files)).
