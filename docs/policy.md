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
ratifiers:                        # OPTIONAL roster lists (the git host decides who may approve): slice-doc-schema.md#who-may-ratify
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
| `review` | `session` | `pull-request` declares that the pull-request review is the review session (GH #494, 1.23.0): `em slice ratify --by` on a doc still `status: draft` does not refuse for the missing review and needs no `--skip-review`; it writes `reviewedBy:`/`reviewedOn:` (the same name and date as the sign-off) and **no** `reviewSkipped:` line, applies `em slice review`'s Open Questions gate (an unchecked item refuses with the file untouched; ratify has no `--allow-open`), checks `--by` against `reviewers:` when that list exists, and says so once on stderr (batch ratify too). A doc already `reviewed` keeps its own review. `session` (or no key) leaves ratify as it was, `--skip-review` and its marker included. See [cli.md](cli.md#em-slice-ratify-file-slice-key---by-name). |
| `ratification.inline` | `internal` | Read by [`em inline-check`](cli.md#em-inline-check-file---base-rev) (GH #496): which slices may be ratified on the same branch as their implementation. `internal` reports a public-touching slice ratified inline, `never` reports any, `always` none. |
| `ratification.inline-violation` | `advisory` | Severity of an `em inline-check` finding: `advisory` prints a warning and exits 0, `error` exits non-zero. |
| `amendment.prose-sections` | em's list: `Intent`, `Trigger & Actor`, `Dependencies & Read Models Affected`, `Consumed by` | Replaces the list that classifies a slice doc's sections as prose or behaviour. A heading not listed is behaviour. Decides what [`em slice amend`](cli.md#em-slice-amend-file-slice-key---by-name) may re-sign in place, and classes the per-slice `sections` in `em export --doc-json`. |
| `ratifiers`, `reviewers` | none (the git host decides) | The optional roster: same shape and meaning as in [slice-doc-schema.md](slice-doc-schema.md#who-may-ratify). Declare it only if you have no host enforcement; see [the roster is optional](#the-roster-is-optional). |

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

## The roster is optional

The git host (CODEOWNERS and branch protection) is the authority on who may approve a change; see
[ci.md](ci.md#codeowners-routing-ratification-review). The roster is a second, weaker list that
stays available as an opt-in for teams with no host enforcement. **`ratifiedBy:` is a record of who
signed, not a permission.** `--by` is free text and unauthenticated; the authenticated approval is
the host's review of the pull request that carries the sign-off. With no `ratifiers:`/`reviewers:`
lists, em checks nothing about who signs, `em ci init` emits no roster job, and `em status` reads
`roster: none`. With a roster declared, every roster check works exactly as before.

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
