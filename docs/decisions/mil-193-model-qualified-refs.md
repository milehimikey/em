# MIL-193 — model-qualified refs: one addressing scheme across models

**Status:** decided, implemented (em 1.10.0). [MIL-193](https://linear.app/milehimikey/issue/MIL-193).

## Problem

Element refs (`<sliceKey>/<kind>.<slug>`) are deliberately model-unqualified. `em query`
(MIL-168) was the first surface to name an element across model boundaries and minted its own
qualifier, `<modelKey>:<ref>`, with `modelKey` derived from the input *filename*. MIL-194's
seam manifest, em-portal deep links, and em-tracker-bridge all need the same thing; if each
picked its own key source, MIL-162's "one addressing scheme" constraint would be dead on arrival.

## Decision

The qualified form is `<modelKey>:<ref>` — exactly what `em query` already printed. What
changes is where `modelKey` comes from, and that one shared module owns it.

Three candidate key sources were weighed:

| Source | Stable under file move | Stable under file rename | Unique in a system | Works for one export alone |
|---|---|---|---|---|
| **Declared `model "Name"`** (kebab-slugged) | yes | yes | if names are unique | yes |
| File basename | yes | **no** | if basenames are unique | yes |
| Directory name | **no** | yes | one model per directory only | needs the path |

**Declared name wins.** Every other export identity (slice keys, element refs, type refs) is
the kebab-slug of a declared name and never a path; a model key that broke that rule would be
the one identity a `git mv` could silently change. It also means a single-model `em export`
can publish `model.key` with no system context, so consumers never invent keys.

**Fallback.** A file with no `model "Name"` line has nothing to slug (the parser titles it
"Event Model"), so its key is the file's kebab-slugged basename, extension stripped. The
parser now records whether the name was declared so the default title can't become a key.

**Collisions.** Keys are deduped only across the models of one multi-model invocation:
`~2`, `~3`, … in file-list order (first wins the bare key) plus a `duplicate-model-key`
warning naming both files — the same posture as `duplicate-slice-name`. A single-model
context never sees a suffix.

**Unqualified refs stay valid** everywhere they are valid today. The only surface whose output
changed is `em query`, whose key now derives from the declared name instead of the filename.

## Consequences

- `src/model/qualifiedRef.ts` is the one implementation, published as `@milehimikey/em/refs`.
- `em export` carries `model.key` (schema 1.10, same cycle as MIL-191); `--slice` carries `modelKey`.
- A deep link minted against the old basename key needs re-minting once where the declared
  name slugs differently from the filename.
