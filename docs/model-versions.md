# Model versions

MIL-218's model-level counterpart to per-slice certification (MIL-214, see
[slice-doc-schema.md](slice-doc-schema.md)): two facts about *the model as a whole*, kept
deliberately separate, because they answer different questions —

- **Design version** — what was *decided*. An explicit, human-bumped integer, `em model version
  bump <model>.em --by <name>` ([cli.md](cli.md#em-model-version-bump-file---by-name)).
- **Certified version** — what was *proven*. "Design version N was certified at revision R on
  date D," written by a full (non-`--partial`) `em state set-conformance`
  ([cli.md](cli.md#em-state-set-conformance)).

See [process.md#model-versions](process.md#model-versions) for when to bump and the
warn-never-auto rule; this document covers only the manifest's on-disk shape.

## Where it lives

`model-versions/v<N>.json`, one file per design version, sibling of `slices/` and
`conformance/` in the model's own directory:

```
my-model/
  my-model.em
  .event-modeling.md
  slices/
  conformance/
  model-versions/
    v1.json
    v2.json
```

This is **history, not progress** — every version a model has ever been bumped to stays on
disk, same as `conformance/*-report.md`. It is deliberately *not* referenced from
`.event-modeling.md` directly; the state file carries only a pointer (see below).

## Shape

```json
{
  "modelVersionSchemaVersion": "1.0",
  "model": "my-model.em",
  "version": 2,
  "bumpedBy": "Alex Rivera",
  "bumpedOn": "2026-09-08",
  "emVersion": "1.13.0",
  "modelHash": "8f12ed8f...  (sha256, 64 hex chars)",
  "slices": {
    "cancel-order": 2,
    "place-order": 1
  },
  "certified": {
    "at": "8f12ed8",
    "on": "2026-09-08",
    "report": "conformance/2026-09-08-report.md",
    "findings": "conformance/2026-09-08-findings.json"
  }
}
```

| Field | Meaning |
|---|---|
| `modelVersionSchemaVersion` | This document's own schema version (`"1.0"`), independent of the npm package and `em export`'s `schemaVersion` — same convention every em JSON surface holds. Additive-only: a new field is a minor bump, noted in `src/cli/modelVersion.ts`'s history comment. |
| `model` | The `.em` file's own basename — disambiguates within a directory that (like `conformance/`) can hold more than one model's manifests. |
| `version` | This design version's number. Versions start at 1 and only ever go up; there is no delete. |
| `bumpedBy` / `bumpedOn` | Who bumped this version, and when — the same "recorded with a name and a date" discipline `ratifiedBy`/`ratifiedOn` hold. |
| `emVersion` | The running `em`'s own version at bump time — provenance; `em` never reads this back. |
| `modelHash` | sha256 of the `.em` file's bytes, after normalizing every line ending to `\n` first (so a CRLF-vs-LF checkout difference never reads as a content change on its own). |
| `slices` | Every non-continuation slice's export key → that slice's doc `version:` at bump time (`null` when the slice had no usable doc bound yet). A continuation slice (MIL-208 — a later `view X again` instance with no doc of its own) is excluded; the originating slice's own entry already covers it. |
| `certified` | `null` until a full `em state set-conformance` run certifies this version; `{ at, on, report, findings }` afterward — `at`/`on` are the conformance revision/date, `report` the conformance report path, `findings` the sibling findings JSON path (`null` if none existed, the pre-MIL-214 migration path). Only the CURRENT design version's manifest is ever written to by certification — an older manifest keeps whatever `certified` value it already had. |

Deterministic serialization through one writer (`serializeModelVersionDoc`,
`src/cli/modelVersion.ts`): keys in fixed alphabetical order (both top-level and inside
`certified`), `slices` keys sorted, 2-space indent, trailing newline — same discipline
`conformance/*-findings.json` (MIL-214) holds.

## The state file's pointer

`.event-modeling.md` carries two bullets, right after `Last conformance:`:

```
- **Model version:** 2
- **Certified:** v2 @ 8f12ed8 (2026-09-08)
```

(or `none`/`never` before the first bump/certify — and, migration-tolerant, when either bullet
is missing entirely from a state file predating this feature). These are pointers only — the
manifest files are the source of truth; `em model version show <model>.em` reads the manifests
directly and never trusts a possibly-stale bullet.

## Who finds what which way

| Question | Answer via |
|---|---|
| "What's the current design version, and has it been certified?" | `em model version show <model>.em [--json]` |
| "Has the vector moved since the last bump?" | `em status --json`'s `modelVersion[]`, `em validate`'s `model-version-stale` warning (silent when no manifest exists at all), or the `warn:` line `em slice ratify`/`reratify` print |
| "What did version N look like?" | `model-versions/vN.json` directly |
| Programmatic / cross-tool | `em export`'s `model.version: { design, certified: { version, at, on } | null }` |

`system.yaml` referencing model versions is a later milestone — untouched by MIL-218.
