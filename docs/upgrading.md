# Upgrading a model repo

`em upgrade <model>.em` brings a model repo forward to match the installed `em` — the
mechanical parts, at least. This doc is a release-by-release ledger of what actually
changed on the repo side (state-file bullets, slice-doc frontmatter, `.em` syntax, the
`.claude/skills/` bundle shape, generated CI files, `constitution.md`, `model-versions/`
manifests) since 1.7.0, and whether `em upgrade` handles each change on its own or needs a
human.

## Running it

```bash
em upgrade model.em            # dry run — report only
em upgrade model.em --apply    # apply, one git commit per step
em upgrade model.em --check    # CI mode: exit 1 only on a hard incompatibility
```

Dry-run is the default: `em upgrade` reports what it would do and stops. `--apply` makes
**one git commit per applicable step**, in a fixed order, so a reviewer can inspect or
cherry-pick each one individually:

1. `skill-bundle` — refresh the vendored `.claude/skills/` bundle (same logic as `em skill
   sync`).
2. `reaction-shape` — rewrite a pre-1.7.1 two-slice Automation/Translation into the merged
   single-slice shape (same logic as `em migrate`).
3. `state-file` — add any missing state-file bullets with their defaults, byte-for-byte
   otherwise.
4. `ci-block` — refresh the generated block in `.github/workflows/em-ci.yml`, only when
   that block already exists.
5. `constitution` — scaffold `constitution.md` (draft, unratified) when it's absent and the
   repo has no `.specify/` directory.

Each step is detected first and applied only under `--apply`; a step that finds nothing to
do makes no commit. `--apply` refuses to start on a dirty working tree, or with no git
identity configured (`git config user.name`/`user.email` — needed before `git commit` can
work at all), and stops at the first failing step with the prior steps' commits intact. Once
every applicable step has
run, `--apply` writes the final `Em version: <to>` bullet to the state file as its own last
commit — that write happens every run, independent of which of the five steps applied.

`from` is read from the state file's `Em version:` bullet; when that bullet is absent (a
state file predating this feature), `em upgrade` infers `from` from other evidence and says
so in its output. `to` is the installed `em`'s own version.

`--check` is what CI runs: it exits 1 only on a hard incompatibility (an unparseable state
file, an `.em` shape `em migrate` can't cleanly rewrite) and otherwise exits 0, listing both
the mechanical and human items on stderr.

**Version support.** `em upgrade` handles a repo authored under em 1.6 forward. Anything
older may need `em migrate` (or other manual prep) run by hand first — see the "repo
predates 1.6" item under 1.7.0/1.7.1 below.

## Human items

Some changes are judgment calls `em upgrade` deliberately never applies for you — it only
detects and reports them:

- **no model version yet** — `Model version: none` with at least one `implemented` slice:
  run `em model version bump <model>.em --by <name>` (MIL-218).
- **docs on continuation slices** — slices flagged by `continuation-has-own-doc`: an
  `again`-view continuation that still carries its own doc, which should fold into its
  originating slice's doc instead (MIL-208).
- **`ready-to-implement` docs lacking `ratifiedBy`** — should go through `em slice ratify
  --by <name>` (MIL-165).
- **coverage default-scope change** — the generated CI block runs `em coverage --strict`
  and the model has zero `implemented` docs: since MIL-207, `--strict` counts only
  `implemented` docs by default, so a repo with none yet gets a trivially-green gate.
- **unratified constitution** — `constitution.md` (or `.specify/memory/constitution.md`)
  exists but its `ratifiedBy:` frontmatter is empty: still a draft (MIL-202).
- **repo predates 1.6** — the `reaction-shape` detector recognizes an old two-slice shape
  but can't cleanly auto-migrate it: run `em migrate` by hand first, then re-run `em
  upgrade`.

## 1.7.0

The slice-doc frontmatter contract lands, and slice docs become machine-read.

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| YAML frontmatter (`schemaVersion`, `pattern`, `swimlane`, `status`, `version`, optional `implementedIn` and lineage keys) becomes the canonical slice-doc metadata dialect; the old `- **Status:** ...` bullet stays accepted for pre-frontmatter docs | no action needed — old-style docs keep parsing |
| Typed `## Delta` sections (fixed heading, Added/Modified/Removed/Renamed blocks) for re-ratified slices | no action needed — only matters the next time a doc is re-ratified |
| Multi-word `@Persona`/`@Context` tags now parse without quoting | no action needed — a syntax fix, not a required rewrite |
| `public` widened to views (previously events only) | no action needed |
| `em skill sync`/`em skill check` become the supported way to keep a vendored skill copy current | human: run `em skill sync` once to pick up the new skill and its doctested reference sections (later folded into `em upgrade`'s `skill-bundle` step) |

## 1.7.1

A patch release: fixes only, plus the reaction-shape rule that later versions' `em upgrade`
migrates automatically.

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| The "command has nothing that triggers it" check now requires an actual Automation/Translation link, not just slice-position adjacency — the pre-1.7.1 two-slice reaction shape stops validating | `reaction-shape` |
| DSL parser fixes: curly braces/nested quotes inside `issue "..."` strings, excess positional file arguments rejected, long unspaced labels wrap | no action needed |

## 1.8.0

Deterministic commands replace prose procedures; models gain codegen metadata; the live
viewer is rebuilt.

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| `em migrate` rewrites the old two-slice Automation/Translation shape into the merged single-slice shape (MIL-125) | `reaction-shape` |
| Event tag metadata (`identity`/`composite`/`external`) and `renamed from` clause added to the DSL (schema 1.6) | no action needed — opt-in syntax, nothing to migrate |
| `em scaffold`, `em slice new`, `em slice index`, `em state`, `em conform-scope` become native commands (previously prose procedures in the skill) | human: run `em skill sync` to pick up the skill text describing them (later folded into `em upgrade`'s `skill-bundle` step) |
| `em slice mark-implemented`, `em coverage` (invariant-citation checking) added | no action needed |
| Invariant IDs standardized on `INV-<MNEMONIC>-<n>`; bare `INV-n` still supported | no action needed |
| `covers:` frontmatter key for multi-slice Automation/Translation design-unit docs | no action needed — opt-in |

## 1.8.1

The slice-scoping release: attribution fixes, one new field marker.

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| New `assigned` field marker (e.g. `orderId assigned`) exempts system-assigned event fields from the fields-completeness check | no action needed — opt-in syntax |
| `em coverage` now attributes `INV-*` IDs only to the slice whose doc defines them | no action needed — a scoring fix |
| `em scaffold`/`em init`'s starter template writes the merged Automation shape instead of the deprecated two-slice split | no action needed — affects only newly scaffolded projects |

## 1.9.0

The communication-layer release: `em status`, freshness signals, ratification identity,
installed CI.

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| `em ci init` scaffolds a `GENERATED:em-ci` block in `.github/workflows/em-ci.yml` (validate, slice index --check, coverage --strict, ledger, skill check, glossary, conform cadence) | human: run `em ci init` once to install the workflow (a repo that already ran it gets ongoing refreshes via `em upgrade`'s `ci-block` step) |
| `ratifiedBy:`/`ratifiedOn:` frontmatter, written by `em slice ratify <model> <key> --by <name>` | human: `ready-to-implement` docs written before this land without `ratifiedBy` — see the human item above |
| `owner:`/`tracking:` optional per-slice frontmatter keys (schema 1.9) | no action needed — opt-in |
| The skill bundle splits from one monolithic skill into a router plus five focused SDLC-stage skills; **migration note in the release itself**: consumer repos should run `em skill sync` (not `install --force`) to reconcile the old single-directory layout | `skill-bundle` |
| `orphaned-slice-doc` warning for a slice doc left behind after a rename/removal | no action needed — advisory, nothing to rewrite |
| `em typespec` (experimental), `em slice reratify`, `em slice new --wire`, `em state log-usage`, `em usage-report` added | no action needed |
| Multi-model layout (`em scaffold --under`) ratified as the supported convention | no action needed — new-project guidance, not a rewrite of existing repos |

## 1.10.0

`em query`, the export edge list, and the seam manifest (`system.yaml`).

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| `em export` schema 1.9 → 1.10 adds `model.edges` and `model.key` — additive, no repo file changes | no action needed |
| Qualified-ref grammar (`<modelKey>:<sliceKey>/<kind>.<slug>`) and the `@milehimikey/em/refs` subpath | no action needed — a new addressing scheme, not a rewrite |
| Optional `system.yaml` seam manifest for multi-model projects, verified by `em system` | human: author `system.yaml` if the project spans multiple models and wants seams verified — a new opt-in file, not a migration |
| `em ci init` now pins the generating em's exact version in scaffolded workflows instead of floating to `latest`/`@1` | `ci-block` — re-running the step re-pins the version |

## 1.11.0

The review gate: `status: reviewed` becomes a real, enforced step before ratification.

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| **Behavior change:** `em slice ratify` now refuses a doc that hasn't passed through `status: reviewed`, unless `--skip-review` | human: no repo file needs editing for this, but the next `ratify` on an un-reviewed doc needs `em slice review --by <name>` first, or `--skip-review` |
| `reviewedBy:`/`reviewedOn:` frontmatter, written by `em slice review --by <name>` | human: same as `ratifiedBy` above — a doc reviewed before this land has no `reviewedBy`, but there's no gate demanding it retroactively |
| `loops-to "View"` clause on events (a new DSL construct) | no action needed — opt-in syntax |
| `derived` view-field marker (`status: String derived`, or `derived from "Event A"`) | no action needed — opt-in syntax |
| `constitution.md` scaffolding — `em scaffold` writes it beside the model unless `.specify/` exists | `constitution` |
| `em ledger --waive <slice-key>` / `Em-Ledger-Waive:` commit trailer | no action needed — opt-in |
| **Release note: run `em skill sync` in each consumer repo** (the bundle gained a template and new skill text) | `skill-bundle` |

## 1.12.0

Pilot findings fix the implement contract; the model stops treating a continuation view as
its own slice.

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| **Behavior change:** `em coverage` counts only `implemented` docs by default (`--include-ready` for the old scope); a missing `--tests` dir is now a warning, not an error, when nothing is in scope | human: if the generated CI block runs `em coverage --strict` and the model has zero `implemented` docs, the gate is trivially green — see the human item above |
| **Behavior change:** a `view X again` continuation slice is no longer a slice of its own — no doc, status, ratification, or PR; `em slice ratify`/`review`/`reratify`/`mark-implemented`/`new --wire` refuse its key; an existing doc on one gets a `continuation-has-own-doc` warning | human: fold a flagged continuation's doc into its originating slice's doc — see the human item above |
| **Behavior change:** date-defaulting commands (`ratify`, `review`, `state set-phase`/`set-review`/`log-usage`, `conform-supersede`, `scaffold`) now stamp the local calendar date instead of UTC | no action needed — a behavior fix, nothing in the repo to rewrite |
| The implement contract (§8 Foundation, §2 Interface obligations, one-slice-doc-one-PR, order-of-work-by-graph, §3 re-implementation mode) rewritten | human: run `em skill sync` to pick up the new contract text (later folded into `em upgrade`'s `skill-bundle` step) |
| `constitution.md` template gains an "Interface conventions" prompt | human: an existing unratified `constitution.md` doesn't get this prompt retroactively — regenerate or hand-add it if wanted; a ratified constitution is never rewritten |
| `em export` schema 1.12 adds `continuationOf`/`alsoReads` | no action needed |
| **Release note: run `em skill sync` in each consumer repo** (contract, constitution template, and design skill changed) | `skill-bundle` |

## 1.13.0

The conformance loop: certification becomes per slice per version, the model gets a design
version and a certified version, and `em upgrade` itself ships. Three behavior changes.

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| **Behavior change:** a full `em state set-conformance` refuses while any in-scope finding in `conformance/<date>-findings.json` is unruled, and certifies the *current design version* — so it refuses until a model version exists (MIL-214, MIL-218) | human: run `em model version bump --by <name>` once before the first full conformance after upgrading — the `no-model-version` human item |
| **Behavior change:** `driftSignal: in-sync` now means certified-current; a shipped slice with no `conformedVersion` reads `uncertified` (expected, never a validate warning) (MIL-214) | no action needed — run `em slice conform` per slice after the next conform sweep |
| **Behavior change:** the vendored skill bundle's preconditions STOP the agent when the installed em is a minor version or more ahead of the bundle's `em-version:` stamp (MIL-219) | `skill-bundle` |
| New state-file bullets `Model version:`, `Certified:`, `Em version:` — a state file predating them parses as `none`/`never`/`unknown`, never an error (MIL-218, MIL-219) | `state-file` adds them with their defaults; `Em version:` is `em upgrade --apply`'s own final commit |
| `model-versions/v<N>.json` manifests (new directory beside `slices/`), written by `em model version bump` and certified by a full `set-conformance` (MIL-218) | human: bump when ready — never auto-created |
| `conformance/<date>-findings.json` beside each report (new file the conform skill writes; `em conform-findings check` validates it) (MIL-214) | no action needed for existing reports — `conform-supersede`/`set-conformance` warn once and fall back to banner-only behavior when a report has no findings file |
| Slice-doc frontmatter gains `conformedVersion`/`conformedAt`/`conformedOn`, written only by `em slice conform` (MIL-214) | no action needed |
| Generated CI block gains an advisory `upgrade-check` job (MIL-219) | `ci-block` |
| `em slice new --stub` / `em slice stub-all` — optional, for models without docs (MIL-184) | no action needed |
| `em metrics --from` — reads history, writes nothing (MIL-170) | no action needed |
| **Release note: run `em upgrade <model>.em` (dry-run, then `--apply`) in each consumer repo** | `em upgrade` |
