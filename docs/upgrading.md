# Upgrading a model repo

`em upgrade <model>.em` brings a model repo forward to match the installed `em` — the
mechanical parts, at least. This doc is a release-by-release ledger of what actually
changed on the repo side (state-file bullets, slice-doc frontmatter, `.em` syntax, the
`.claude/skills/` bundle shape or the plugin pin in `.claude/settings.json`, generated CI files,
`constitution.md`, `model-versions/` manifests, `system.yaml`) since 1.7.0, and whether `em upgrade` handles each change on its own or needs a
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

1. `skill-plugin` — migrate a vendored bundle to the pinned em plugin in one commit (see
   [1.14.0](#1140)): removes the eight bundle directories, writes the pinned
   `extraKnownMarketplaces`/`enabledPlugins` entries into `.claude/settings.json`, and refreshes the
   `AGENTS.md` managed section with the `/em:*` skill names. The per-machine registration is a
   human item (`plugin-install-locally`). It runs first so `skill-bundle` never makes a throwaway
   sync commit of directories this step deletes.
2. `skill-bundle` — refresh the vendored `.claude/skills/` bundle (same logic as `em skill
   sync`). Not applicable once the plugin is declared or `skill-plugin` is pending.
3. `reaction-shape` — rewrite a pre-1.7.1 two-slice Automation/Translation into the merged
   single-slice shape (same logic as `em migrate`).
4. `state-file` — add any missing state-file bullets with their defaults, byte-for-byte
   otherwise.
5. `ci-block` — refresh the generated block in `.github/workflows/em-ci.yml`, only when
   that block already exists.
6. `constitution` — scaffold `constitution.md` (draft, unratified) when it's absent and the
   repo has no `.specify/` directory.
7. `ratified-signoff` — grandfather `ready-to-implement` docs that never recorded a sign-off (see
   [1.14.0](#1140)).
8. `ratified-hash-scope` — re-stamp every `ratifiedHash:` recorded before 1.17.0 (whole-body
   scope) with the 1.17-scope hash of the same body — the `## Open Questions` heading and its
   `deferred to v<n>` items are outside the hash now (GH #253, see [1.17.0](#1170)) — and move
   any question 1.16's `em slice defer` queued in `.event-modeling.md` into its doc as a deferred
   item. A doc whose body no longer matches its hash is reported and left alone.
9. `collapse-alternative-events`, `fold-continuations` (opt-in), `view-doc-sources-stale`, `slice-index-stale`,
   `parking-lot-fragments` — five 1.18.0 steps (see [1.18.0](#1180-unreleased)); they run just before
   `system-manifest`, which stays last. The first two rewrite the `.em`; the steps after them see the rewritten model.
10. `system-manifest` — migrate the nearest `system.yaml` (found by walking up from the model to
   the repository root) from schema 1.0 to 2.0. Each 1.0 seam becomes a
   `consumes <model>:<kind>.<slug>` clause on the consuming translation, and each model's
   `owner:` becomes `owner "…"` on that model's header. The seam's `description` is kept as a
   `#` comment above the translation. The manifest keeps `name` and `models: {key: {source}}`
   only. This is the one step that edits *other* models' files, and it does it all in one
   commit. A second run, from any member model, finds the manifest already at 2.0 and does
   nothing. It refuses, and writes nothing, when a seam's consumer isn't a `translation`
   (`consumes` is translation-only) or a member is an export `.json` rather than a `.em` file.

Each step is detected first and applied only under `--apply`; a step that finds nothing to
do makes no commit. `--apply` refuses to start on a dirty working tree, or with no git
identity configured (`git config user.name`/`user.email` — needed before `git commit` can
work at all), and stops at the first failing step with the prior steps' commits intact. Once
every applicable step has
run, `--apply` writes the final `Em version: <to>` bullet to the state file as its own last
commit — that write happens every run, independent of which of the eight steps applied.

Every `--apply` commit carries an `Em-Upgrade:` trailer naming its step, in a paragraph of its
own after the subject. The final stamp commit uses `Em-Upgrade: em-version`:

```
em upgrade: system-manifest (1.13.1 → 1.14.0)

Em-Upgrade: system-manifest
```

Read the trailer with `git log --format='%(trailers:key=Em-Upgrade,valueonly)'`. CI gates use it
to recognize a mechanical migration commit, for example to exempt one from a cross-model
change-set check.

`from` is read from the state file's `Em version:` bullet; when that bullet is absent (a
state file predating this feature), `em upgrade` infers `from` from other evidence and says
so in its output. `to` is the installed `em`'s own version.

`--check` is what CI runs: it exits 1 only on a hard incompatibility (a state file that exists
but is unparseable, an `.em` shape `em migrate` can't cleanly rewrite) and otherwise exits 0,
listing both the mechanical and human items on stderr. The final line names the cause. A repo
with no state file at all is not a failure: the `state-file` step scaffolds one under `--apply`.

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
- **`ready-to-implement` docs lacking `ratifiedBy`** — since 1.14 only `version > 1` docs, i.e.
  reratified and awaiting a fresh sign-off (version-1 docs are grandfathered by the
  `ratified-signoff` step); run `em slice ratify --by <name>` (MIL-165, MIL-259).
- **coverage default-scope change** — the generated CI block runs `em coverage --strict`
  and the model has zero `implemented` docs: since MIL-207, `--strict` counts only
  `implemented` docs by default, so a repo with none yet gets a trivially-green gate.
- **unratified constitution** — `constitution.md` (or `.specify/memory/constitution.md`)
  exists but its `ratifiedBy:` frontmatter is empty: still a draft (MIL-202).
- **repo predates 1.6** — the `reaction-shape` detector recognizes an old two-slice shape
  but can't cleanly auto-migrate it: run `em migrate` by hand first, then re-run `em
  upgrade`.
- **plugin install locally** (`plugin-install-locally`) — the em plugin is (or is about to be)
  declared in `.claude/settings.json` but not registered on this machine. `em upgrade` cannot do the
  per-user registration; run `claude plugin marketplace add milehimikey/em@v<ver> --scope project`
  then `claude plugin install em@em-<ver-dashed> --scope project`, on each developer machine and in
  CI (the generated workflow does it).
- **stale region in a signed doc** (`slice-doc-stale-signed`, 1.18.0) — a ratified or shipped doc whose
  generated region (view, event, …) is stale against the model; the steps never touch it (syncing would move its
  `ratifiedHash`): `em slice revise <key>`, then `em slice sync`.
- **missing lineage back-link** (`lineage-backlink-missing`, 1.18.0) — an archived doc names a signed successor in
  `superseded-by` that lacks `merged-from: <key>@v<N>`; add the line (frontmatter is outside the hash).
- **fold continuations** (`fold-continuations-opt-in`, 1.18.0) — the opt-in step has a proposal; run
  `em upgrade --apply --fold-continuations` to take it.
- **shared event** (`shared-event-now-legal`, 1.18.0) — information only: an event recorded by several
  commands is one logical event now; nothing to change.
- **public field types unresolved** (`public-field-types-unresolved`) — fields of `public`
  elements (or of declared types they reach) whose type is outside the strict public type
  table, listed as `<element>.<field>: <type>`: pick a table type or a declared `type`, or drop
  `public` (MIL-237, see [dsl.md](dsl.md#strict-public-types)).

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

## 1.13.1

The fix release: checks that passed without checking, an upgrade check that failed without
saying why, and a generated CI scaffold that could not pass a lint gate. Two behavior changes.

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| **Behavior change:** `em upgrade --check` no longer fails on a repo with no state file — the `state-file` step scaffolds one (phase `discover`, step 1, no conformance or review claimed). A state file that exists but is unparseable still fails, and the final line now names the file and the missing bullets (MIL-257) | `state-file` — then run `em state set-phase` to record the model's real phase |
| **Behavior change:** `em ci init` refuses to replace a managed block that was generated for a different model, unless `--force`; `--check` reports it as `different model`, not `stale` (MIL-256) | human: superseded in 1.14.0 by set-based identity (MIL-233, see the 1.14.0 table) |
| Generated CI block changed: shellcheck-clean `run:` scripts and ASCII-only text, so `em ci init --check` reports `stale` until the block is refreshed (MIL-256) | `ci-block` |
| `em slice reratify` also accepts a ratified, not-yet-implemented doc (`ready-to-implement` with `ratifiedBy:`): bumps `version:`, clears the sign-off, leaves `status:` alone; re-sign with `em slice ratify --by` (MIL-258) | no action needed — a new path; re-ratifying a shipped doc is unchanged |
| `em coverage --slice <key>` — the pre-merge check for one slice whatever its status; with `--strict` it fails on an uncited invariant or on a slice that is not ratified. The default form is unchanged and still counts `implemented` docs only (MIL-255) | no action needed — switch a per-slice pre-merge check to `--slice` |
| `--json` schema versions, both additive: coverage 1.1 → 1.2 (`slice`, `continuationOf`); upgrade 1.0 → 1.1 (`stateFileError` is `null` for an absent state file) (MIL-255, MIL-257) | no action needed |
| **Release note: run `em skill sync` in each consumer repo** (implement contract §4 and §5 changed; the design skill gained a sibling-slice invariant check; four summaries corrected) (MIL-254, MIL-255, MIL-258, #189) | `skill-bundle` |

## 1.14.0

Strict seams, API first. A model now owns its contract and its rules. A `public` element must have
strict types, and `em api generate` turns the public surface into the model's TypeSpec contract
(`<model dir>/contracts/<model key>.tsp`). A consuming model declares the dependency on its own
side, as `consumes` on a translation, so `system.yaml` 2.0 only lists the models. Review is
enforced along those seams by generated CODEOWNERS entries and three gates: the API-first
readiness gate, the consumer-adaptation check and the scope gate. Invariants can be declared in
the model, and new slice docs get generated field tables. The skill bundle ships as the pinned
`em` Claude Code plugin. Thirteen behavior changes; the seam lifecycle end to end is in
[process.md](process.md#seams-between-models-who-does-what).

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| **Behavior change:** strict public types. Every field of a `public` command, event or view, and of any declared `type` it reaches, must use the fixed table (`string, text, int, long, decimal, boolean, uuid, date, datetime, duration, bytes`, case-insensitive), `X[]`, or a declared `type`. Anything else, an untyped field included, is the error `public-field-type-unresolved`. Internal elements keep free-text types (MIL-237, [dsl.md](dsl.md#strict-public-types)) | human (`public-field-types-unresolved`): the item lists every offending field as `<element>.<field>: <type>` |
| **Behavior change:** `--slice-ready` requires a recorded ratification. A `ready-to-implement` doc with no `ratifiedBy` (for example right after `em slice reratify`) is not ready: `slice-ready-not-ratified`, `gates.ratified` (MIL-259) | `ratified-signoff`: writes `ratifiedBy: "grandfathered (unsigned before em 1.14)"` and today's `ratifiedOn:` on `version: 1` docs that lack one. A reratified (`version > 1`) doc stays a human item: `em slice ratify --by <name>` |
| **Behavior change:** the API-first gate. `--slice-ready` on a public-touching slice (one that owns a `public` command, event or view) requires a current contract. A missing `<model dir>/contracts/<model key>.tsp`, or one whose text differs from a fresh `em api generate`, is the error `slice-ready-contract-stale`; the message names the regenerate command, and `gates.contractCurrent` reports it. Slices with no `public` element are unaffected (MIL-238) | human: run `em api generate <model>.em` and commit `contracts/` |
| **Behavior change:** `em slice ratify` and `em slice reratify` on a public-touching slice refuse without `--meaning-unchanged` or `--contract-change "<why>"`. The answer is recorded as `meaningConfirmed: true` or `contractChange: "<why>"` frontmatter (exported as `slice.doc.meaningConfirmed` / `slice.doc.contractChange`); reratify clears the previous version's answer (MIL-238) | human: add the flag to scripted ratify/reratify calls. `em status` counts ratified or shipped public-touching slices with no answer recorded (`publicSlicesUnconfirmed`); re-run `em slice ratify` with the same `--by`/`--on` plus a flag to record one |
| **Behavior change:** `system.yaml` schema 2.0 holds `name` + `models: {key: {source}}` only. Seams are declared on the consuming side, `translation … consumes <model>:<event\|view>.<slug>`, and owners on the model header, `model "Name" owner "…"`. `seams:`/`owner:` in a 2.0 manifest are errors. A 1.0 manifest is still read, with a `system-manifest-outdated` warning, and verifies the same as after migration. `em validate` checks the `consumes` grammar only; `em system` resolves the refs (`consumes-unknown-model`, `consumes-unknown-element`) (MIL-235, [dsl.md](dsl.md#consuming-another-models-public-surface)) | `system-manifest`: rewrites the manifest to 2.0, writes `consumes` onto every consuming translation and `owner` onto every member model's header, in one commit |
| **Behavior change:** `em validate` errors with `public-name-not-unique` when two `public` elements of one kind in a model share a slug, because a `consumes` ref could not tell them apart (MIL-235) | human: rename one, or drop `public` from one |
| **Behavior change:** `em system` errors with `consumer-not-adapted` when a consuming translation declares a field its producer's `public` element no longer has (removed or renamed) or types differently. The message names both sides, the fields and the producer commit. A producer change that only adds fields stays clean (MIL-239) | human: update the consumer's field block; `em system` lists the failing bindings |
| **Behavior change:** the scope gate. `em system scope --base <rev>` exits 1 when one change set alters a producer's public surface or contract file and a model that consumes it (`seam-crossing`). Other multi-model change sets, new public surface nobody consumes yet, and code spanning a seam only warn. Files changed only by `em upgrade` commits (`Em-Upgrade:` trailer) are exempt. There is no override: review on the contract file is the way through (MIL-240) | `ci-block` adds the job to a multi-model block; a hand-written workflow needs the step ([ci.md](ci.md#em-system-scope-the-seam-crossing-gate)) |
| **Behavior change:** the skill bundle ships as the `em` Claude Code plugin (`/em:event-modeling`, `/em:discover`, `/em:design`, `/em:implement`, `/em:conform`, `/em:review`, with the em MCP server bundled). Each release has its own marketplace name (`em-1-14-0`), so two repos on different em versions never share an install. `em skill install` and `em skill sync` still work but are deprecated: each prints a notice on stderr naming the two plugin install commands (MIL-230, MIL-231) | `skill-plugin`: removes the seven vendored bundle directories, pins the plugin in `.claude/settings.json` and refreshes the `AGENTS.md` section, in one commit. human (`plugin-install-locally`): run the two install commands ([ai-workflow.md](ai-workflow.md#the-plugin-route)) once per machine |
| **Behavior change:** `em skill check` checks a repo that pins the plugin: the settings pin and enabled flag (`plugin-pin-mismatch`, `plugin-not-enabled`) and this machine's registration (`plugin-registered-at-different-ref`; `plugin-not-installed-locally`, which fails only under `--ci`/`CI=true`) (MIL-231) | no action needed for vendored repos |
| Four sub-agent definitions, `.claude/agents/em-{implementer,validator,reviewer,critic}.md`, ship with the package and the plugin (`em:em-*`); `em skill install|sync|check` and `em upgrade` reconcile exactly those four files in a vendored repo (`skill-bundle` syncs them, `skill-plugin` removes them) and never touch other agents in `.claude/agents/`; `em skill check --json` 1.1 gains the `agent-not-installed` and `agent-content-drift` codes (MIL-269) | `skill-bundle` / `skill-plugin`; no action for plugin repos |
| **Behavior change:** `em typespec` is a deprecated alias. It prints `warn: em typespec is deprecated — use em api generate` and runs `em api generate --stdout`. The proof-of-concept's lenient type aliases and `unknown` fallback are gone, and commands are included only when marked `public` (MIL-237) | human: switch scripts to `em api generate` (see the generator migration below) |
| **Behavior change:** `name?: Type` marks a field optional. A field written `name?` used to parse as a field literally named `name?`. `public` is now also valid on a `command` (the write API); it used to be a parse error (MIL-237) | no action needed unless a field name really ended in `?` (rename it) |
| **Behavior change (skills):** design sessions have a write scope (MIL-236, GH #193). A session is bound to its model's directory. A change it needs to another model's `public` element is recorded as a dated seam change request in this model's Decisions log (`- YYYY-MM-DD: seam change request → <producerKey>:<kind>.<slug> — <what> — <why>`), never as a cross-model edit. Design never writes generated contracts (except by running `em api generate` after marking an element `public`), `specs/`/`.specify/`, implementation source or `plugin/`, and never reads code as evidence (code is read only in `extract` and `conform`). On a pre-release model (`em status --json`: `modelVersion` entry `design: null` and no `implemented` slice) a draft's `version:` is never bumped and `em slice reratify` is never run. The skills pass `--meaning-unchanged` / `--contract-change "<why>"` on public-touching ratify/reratify, run `em system scope --staged` before committing, and the router steers late `slice` work to `/em:review` | plugin / `skill-bundle`. The state-file template's Decisions-log comment shows the seam change request shape; existing state files are not rewritten |
| `em api generate <model>.em` writes the model-owned contract, `<model dir>/contracts/<model key>.tsp`, covering `public` commands (write API), events (async) and views (read). The header records `Source:` and no source hash, so an edit that leaves the public surface alone never changes the file. `em api check <model>.em [--base <rev>]` exits 1 only when the committed contract is missing or stale; with `--base` it annotates each public-surface change `additive` or `breaking` (MIL-237) | human: run `em api generate <model>.em` and commit `contracts/` |
| `owner "@org/team"` on the model header is validated: a value that is not a GitHub user, team or email warns `owner-not-a-handle` (the free text the manifest migration writes still parses). `em system codeowners [--check]` generates the managed CODEOWNERS block that puts each model's team on its directory and every consuming team on the producer's contract file (MIL-234) | human: choose a real handle per model, run `em system codeowners`, commit the result, and turn on "Require review from Code Owners" in branch protection |
| `em system` with no argument (or a directory) reads that directory's `system.yaml`, or, when there is none, discovers every `*.em` tracked in the repository (`*-asis.em` skipped) (MIL-235) | no action needed |
| First-class invariants: `invariant INV-<MNEMONIC>-<n> "rule"` on the line after a command or event declares the ID and rule in the model; slice docs cite and elaborate. `em coverage` and `em query invariant` read the model first; export elements gain `invariants`; new `invariants/*` rules. A public element's invariants are part of its contract, and `em api check` annotates one added or changed as breaking, removed as additive. Doc-declared invariants keep working unchanged: only `invariants/doc-cites-undeclared` (a warning) can fire on a model with no `invariant` line (MIL-265, [dsl.md](dsl.md#invariants)) | no action needed (opt-in syntax). To migrate, move each ID and rule into the model and keep the doc's elaboration as a citation; `invariants/declared-in-both` points at any doc still restating a model ID |
| `--slice-ready` has always failed on any diagnostic scoped to the slice, warnings included. With public commands and `invariants/public-command-without-invariants`, a slice that owns a `public` command is not ready until that command declares an invariant in the model (MIL-237, MIL-265) | human: declare the command's invariants with `invariant INV-…` lines |
| New slice docs get generated regions: `em slice new` writes the whole template skeleton, with the command/event/view field tables and the Invariants list inside `<!-- GENERATED:em-slice-…:start/end -->` markers, filled from the model with `--wire`. `em slice sync <model> [--check]` regenerates them in place after a model edit and leaves authored text byte-for-byte. Scenarios follow a `### Scenario:` Given/When/Then grammar and are exported as `slice.doc.scenarios`. New `slice-doc/structured-section-malformed` warning and its `--slice-ready` blocker twin (MIL-266) | no action needed: existing docs have no markers, are never flagged, and `em slice sync` skips them. To adopt regions, re-create a doc with `em slice new --wire --force` and carry the prose across (see [slice-doc-schema.md](slice-doc-schema.md#generated-regions-and-authored-sections)) |
| `em ci init <system.yaml>` generates one workflow covering every model in the manifest (per-model jobs, a conform matrix). A block's identity is now its set of models: `different model` becomes `different models`, and a single `<model.em>` no longer narrows a multi-model block without `--force` (MIL-233, GH #174) | `ci-block`: a block naming two or more models is regenerated from the `system.yaml` at the repo root; with none readable the step leaves the block alone and says why |
| Generated CI block: a PR-only `api-check` job per model (MIL-237); on multi-model blocks, PR-only `codeowners-check`, `system` and `system-scope` jobs (MIL-234, MIL-239, MIL-240). The `skill-check` job runs `em skill check --ci` for vendored or plugin repos, registering the pinned plugin on the runner first, and the conform workflow runs `/em:conform` in a repo that pins the plugin (MIL-231) | `ci-block` |
| Every `em upgrade --apply` commit carries an `Em-Upgrade: <step>` trailer; the scope gate and `em metrics` use it to recognize mechanical migrations (MIL-235) | `em upgrade` |
| `em engagement new / plan / set / status / close` (MIL-268): an engagement is a named chunk of the model, built as one stack of slice PRs. It lives in `<model dir>/engagements/<slug>.md` (frontmatter plus a generated Ledger table, [engagement-schema.md](engagement-schema.md)). The plan levels the slices over `model.edges` with `loops-to` excluded. New MCP tools `engagement_plan` and `engagement_status`; `em status` gains an `open engagements` line (`engagements` in the JSON, under status 1.8); `em state log-usage --phases` accepts `engagement` | new, no migration |
| New skill `event-modeling-engagement` (`/em:engagement` under the plugin): the lead-session playbook that builds an engagement through the four sub-agents to a stack of PRs. It requires the constitution line `- **Merge strategy:** merge-commits-when-stacked`. The implement contract's §8 rule 2 now cuts a slice branch from the engagement plan's base (`main` outside an engagement), and new rule 2a requires a merge commit, never a squash, for a PR while a dependent PR is open (MIL-270) | `skill-bundle` vendors the new directory (`em skill check` reports it missing until then); plugin repos get it with the plugin |
| The constitution template gains three prompts, in the form of plain-text lines the engagement skill and the validator read: `- **Test command:** \`<command>\`` under Testing norms, and `- **Merge strategy:** merge-commits-when-stacked` and `- **Agent models:** implementer=sonnet, validator=sonnet, reviewer=sonnet, critic=opus` under Review and merge norms (MIL-272). The engagement skill refuses to run without the merge strategy line; the other two have defaults | human: add the lines to your constitution (`constitution.md` beside the model, or `.specify/memory/constitution.md` in a spec-kit project) as one amendment a named human ratifies; `em` never rewrites a constitution |
| `--json` schema versions. Breaking: system 1.0 → 2.0 (`owner` is `string[]`, `seams[]` come from `consumes`, new `manifest: null` / `discovery` / `consumerAdaptation`). Additive: export 1.14 → 1.15 (`elements[].consumes`, `elements[].invariants`, `fields[].optional`, `model.owner`, `slice.doc.meaningConfirmed` / `contractChange` / `scenarios`); status 1.7 → 1.8 (`publicSlicesUnconfirmed`, `system`, `engagements`); slice-ready 1.1 → 1.2 (`gates.ratified`, `gates.contractCurrent`); query 1.1 → 1.2 (`optional`, invariant `rule` / `declaredIn`); diff 1.7 → 1.8 (`optional`, two `*-optionality-changed` change types); glossary 1.0 → 1.1 (`optional`); metrics 1.0 → 1.1 (`seamCrossings`); skill check 1.0 → 1.1 (`plugin`). New: `apiCheckSchemaVersion`, codeowners, scope, slice sync, engagement plan and engagement status, each 1.0 | no action needed; update anything that parses `em system --json` |
| **Release note: run `em upgrade <model>.em` (dry-run, then `--apply`) in each consumer repo** — eight mechanical steps in 1.14.0 (`skill-plugin`, `skill-bundle`, `reaction-shape`, `state-file`, `ci-block`, `constitution`, `ratified-signoff`, `system-manifest`); then install the plugin locally (two commands) and clear any `public-field-types-unresolved` human item. | `em upgrade` |

**What a person has to do for 1.14.0**, beyond `em upgrade --apply`:

- **Choose owners.** Replace the free-text `owner` the manifest migration wrote with a real
  CODEOWNERS handle per model (`@org/team`, `@user` or an email), then run
  `em system codeowners` and commit the managed block.
- **Wire branch protection to CODEOWNERS.** Turn on *Require a pull request before merging* and
  *Require review from Code Owners* for the default branch. Without it the contract-file entries
  are advisory, and "review is the override" for the scope gate means nothing
  ([ci.md](ci.md#seams-consuming-teams-on-the-producers-contract)).
- **Install the plugin locally.** Run the two `claude plugin` commands once on each machine
  (`plugin-install-locally`); the generated CI job registers it on the runner itself.
- **Migrate free-text public types.** Work through `public-field-types-unresolved`, then run
  `em api generate` and commit each model's `contracts/` (see below).

### Migrating an in-house slice-doc → TypeSpec generator

Teams that generate TypeSpec from slice-doc field tables with their own tooling can switch to
`em api generate`. The contract then comes from the model (the `.em` file), not from the docs:

1. **Mark the surface.** Put `public` on every command, event and view other teams or clients
   depend on. Only `public` elements reach the contract; everything else stays internal and
   free to change.
2. **Make the public types strict.** Each public field needs a type from the table below,
   `X[]`, or a declared `type`. The table is closed on purpose: em does not map arbitrary type
   names.

   | em | TypeSpec |
   |---|---|
   | `string`, `text`, `uuid` | `string` |
   | `int` | `int32` |
   | `long` | `int64` |
   | `decimal` | `decimal` |
   | `boolean` | `boolean` |
   | `date` | `plainDate` |
   | `datetime` | `utcDateTime` |
   | `duration` | `duration` |
   | `bytes` | `bytes` |

3. **Move type detail out of the doc tables.** If a doc field table carries detail the `.em`
   lacks (`Money`, `Instant`, nullability, a nested shape), the model has to say it now. Write a
   domain shape as a declared `type` whose fields use the table
   (`type Money { amount: decimal, currency: string }`), an instant as `datetime`, an optional
   field as `name?: Type`, and a list as `X[]`. Then bring the doc table back in line:
   `doc-model-field-mismatch` flags a field whose type differs between doc and model, and a doc
   written with `em slice new --wire` has its tables regenerated by `em slice sync`.
4. **Generate and commit.** `em api generate <model>.em` writes
   `<model dir>/contracts/<model key>.tsp`; commit it with the model change. Retire the in-house
   generator, and replace any `em typespec` call (now a deprecated alias) with
   `em api generate`.
5. **Gate it.** `em api check <model>.em --base <rev>` fails on a stale contract and annotates
   each change additive or breaking; `em ci init` wires it as the `api-check` job.

The contract header records only `Source: <path to the .em>`, with no hash of the source. An
internal edit (a new internal element, a field on an internal element, a comment) therefore
leaves the contract byte-identical. Only a change to the public surface changes the file, and
only that summons the consuming teams that CODEOWNERS lists on it.

## 1.14.1

A question a slice version will not answer now has a verb: `em slice defer` records it as deferred
to a later version, and `em slice reratify` re-opens it when the slice reaches that version.

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| `em slice defer <model>.em <key> "<question>" --until v<n> --decision "<text>"`: checks the matching `## Open Questions` item with a `deferred to v<n>` marker and mirrors it into the state file's parking lot and Decisions log (MIL-275, [cli.md](cli.md#em-slice-defer-file-slice-key-question)); `em slice reratify` re-opens items deferred to the new version. New verb, no migration | no action needed |
| Examples only: `examples/order-fulfillment` and `examples/headless-api` ship their committed contracts, the ready example slices carry a recorded sign-off, and a regression test runs `--slice-ready` and `em api check` over every example (MIL-276). No consumer action | no action needed |
| **Release note: nothing to run** — update the `@milehimikey/em` dependency (and the plugin pin to `em-1-14-1` / `v1.14.1` on plugin repos); `em upgrade` has no 1.14.1 step. | no action needed |

## 1.14.2

A patch: `em slice mark-implemented` gains the status gate it was missing, and the docs gain the
per-project pinning motion.

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| `em slice mark-implemented` now refuses a doc that is not `ready-to-implement` (or already `implemented`): a `draft`/`reviewed` slice can no longer be recorded as shipped without ratification (MIL-277, GH #222, [cli.md](cli.md#em-slice-mark-implemented-file-slice-key-pr-url)). Before 1.14.2 it flipped from any status. If an agent now reports `doc is \`status: draft\``, the slice was never ratified — ratify it (`em slice ratify --by`, with `--skip-review` as the auditable escape hatch), then re-run | no action needed; behavior change only |
| **Per-project pinning** is now the documented motion for teams: `mise use npm:@milehimikey/em@<ver>` alongside the plugin pin, so the CLI the skills shell out to, the skills and the MCP server are on one version (MIL-278, GH #223, [ai-workflow.md](ai-workflow.md#pinning-the-cli-to-the-same-version)). Adopting it is optional; a repo that does carries one more version line to bump on upgrade | **not yet** — `em upgrade` moves the plugin pin but not the `mise.toml` line; bump that by hand until MIL-279 lands. `em skill check --ci` catches a contributor whose `em` disagrees with the plugin pin meanwhile |
| **Release note: nothing to run** — update the `@milehimikey/em` dependency (and the plugin pin to `em-1-14-2` / `v1.14.2` on plugin repos); `em upgrade` has no 1.14.2 step. | no action needed |

## 1.15.0

Engagements stop stacking: every slice PR is cut from and targets `main`. Defer works in the
room. Ratification has an address, and the next version opens as a real draft.

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| **The next version is a `draft`** (MIL-283, [cli.md](cli.md#em-slice-revise-file-slice-key)). `em slice revise <key>` replaces `reratify`: it opens v<N+1> as `status: draft` (version bumped, prior review + sign-off cleared) while v<N> stays shipped in the shipped record. `em slice mark-implemented` does the same automatically at merge **when a question is deferred to v<N+1>** — a merged slice with nothing deferred stays `implemented`. `em slice reratify` is a deprecated alias (same effect + a stderr notice; its `--meaning-unchanged`/`--contract-change` flags are ignored — the confirmation belongs to `em slice ratify` on the new version). **`em slice ratify` no longer accepts an unsigned `ready-to-implement`** (the pre-1.15 reratify leftover): a revised version takes both gates — review, then ratify — like v1. **Every reader that asked "is this implemented?" now asks the shipped record** (`shippedRecordOf`: the `shipped*` keys, or a pre-1.15 `status: implemented`): `em status` (`byStatus.shipped`, status schema `1.9`; `implemented` stays the working-status count; the one-line summary reads `N/M shipped (…)`), `em coverage --strict` scope, `em conform-scope`/`conform-supersede` scope, `em slice conform` (legal when shipped; `conformedVersion` is the **shipped** version), the engagement Ledger's inferred `merged`, `em upgrade`'s pre-release signal, `driftSignal` (`unpropagated-delta` = `version` past the shipped version). `em export`'s `slice.doc.shipped` is now non-null for a pre-1.15 `implemented` doc too (derived; schema stays `1.16`) | no action needed for docs: a pre-1.15 `status: implemented` doc reads as shipped at its current version and nothing is rewritten. **Human:** any doc left at an unsigned `ready-to-implement` by a pre-1.15 `reratify` — `em upgrade` lists them (`ready-to-implement-no-ratifiedby`) — needs `em slice revise` (reopens it as a draft at the same version), then review and `em slice ratify --by`. **Consumers** that read `slice.doc.status === "implemented"` to mean "shipped" (portal, em-sdd-bridge, a speckit bridge) should read `slice.doc.shipped !== null` instead; `status` is the working state and a shipped slice can be `draft` again |
| `em slice defer --from-issue "<text>"` (MIL-281, [cli.md](cli.md#em-slice-defer-file-slice-key-question)): the question a review session captures as an `issue "..."` clause can now be deferred in one command — the deferred item is written to the doc's `## Open Questions`, mirrored into `.event-modeling.md`, and the `issue` clause is removed from the `.em`. The positional `"<question>"` form is unchanged; the two are exclusive. The review and design skills now walk each question to one of three endings (answered → edit + delete the note; room-raised + deferred → `--from-issue`; on the doc + deferred → positional) before `em slice review --by` | no action needed |
| **Ratification records what it signed** (MIL-284, [cli.md](cli.md#em-slice-ratify-file-slice-key---by-name)): `em slice ratify` now writes `ratifiedRef:` (HEAD of the model's repository — the commit whose tree holds the signed body) and `ratifiedHash:` (`sha256:` over the body) beside `ratifiedBy`/`ratifiedOn`, and **refuses a doc with uncommitted changes** — commit the body first. Outside a git work tree only the hash is written. `em slice mark-implemented` writes `shippedVersion:`/`shippedRef:`/`shippedOn:` beside `implementedIn:` (`--on <date>` to backdate). `em validate --slice-ready` gains `slice-ready-body-changed-since-ratification` for a ready doc whose body no longer matches its `ratifiedHash`. `em export` schema `1.16`: `slice.doc.ratifiedRef`, `slice.doc.ratifiedHash`, `slice.doc.shipped` ([slice-doc-schema.md](slice-doc-schema.md#how-the-parser-reads-frontmatter)). All additive — `status`/`implementedIn` are unchanged and every existing reader keeps deciding on them; the readers move to `shipped` in MIL-283 | no action needed. Docs ratified before 1.15 carry none of the new keys and behave exactly as before (no hash → no body check). The new refusals are at ratify: the uncommitted-changes check — a workflow that edited and ratified in one breath now commits in between — and a same-sign-off re-run on a doc whose body moved. `em slice defer` edits the body, so defer before ratifying |
| `em engagement plan` reports `base: main` for every slice and never holds a slice for its in-engagement upstreams: the `multiple-unmerged-upstreams` hold reason is gone and `impl/<upstream>` is never a base (MIL-280, [cli.md](cli.md#em-engagement-plan-file-slug---json)). Levels still order dispatch and review. The `event-modeling-engagement` skill hands over each PR as it passes, to merge in any order with the project's usual strategy; the retarget check and the merge-commit rule are removed. The implement contract's §8 rule 2 now cuts every slice branch from `main`, inside and outside an engagement; rule 2a is removed | no action needed. An open engagement from 1.14.0–1.14.2 keeps working: a Ledger entry still recording `base: impl/<upstream>` is reported as `main` by `plan`; record `--base main` on its next `em engagement set`. A dependent PR already stacked on an unmerged upstream is the human's to retarget (`gh pr edit <n> --base main`) or leave to merge as it is |
| The constitution template no longer requires `- **Merge strategy:** merge-commits-when-stacked`; the prompt is now a free-text line for the project's own strategy, and nothing in em reads it. The engagement skill no longer refuses without the line | no action needed; a constitution that still carries the old line is fine — the skill ignores it. Edit it to your real strategy when you next amend the constitution (the owner ratifies) |
| **Release note: nothing to run** — update the `@milehimikey/em` dependency (and the plugin pin to `em-1-15-0` / `v1.15.0` on plugin repos); `em upgrade` has no 1.15.0 step. | no action needed |

## 1.16.1

Dependency patch: `braces` leaves the runtime dependency tree.

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| `em watch` moves from chokidar 3 to chokidar 4 (#252, Dependabot alert 28, CVE-2026-93687 in `braces`): `braces` is no longer in `@milehimikey/em`'s install tree, so a consuming repo's audit comes up clean. The watcher now watches the `slices/` directory beside the model (filtered to `.md`) instead of a glob — same behaviour, including picking up a slice doc created mid-session, and a `slices/` directory created after the watcher started | no action needed; update the `@milehimikey/em` dependency (and the plugin pin to `em-1-16-1` / `v1.16.1` on plugin repos) |

## 1.16.0

The exchange, first hardening: fixes from a real engagement run through draft, review, ready,
engagement and implemented.

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| **Every `<slice-key>` argument resolves** (GH #237, [cli.md](cli.md#slice-keys)): the exact export key, else the display name, else a unique prefix of either; an unknown key lists the valid ones (or the nearest three on a large model). Output and stored references keep the canonical export key | no action needed |
| **A view's field sources are the union of `from` across its originating and every `view … again` instance** (GH #235, MIL-286, [validation.md](validation.md#fields-completeness)): the View ← events check and a traced `derived from` no longer false-flag a field fed by a later instance | `human:` a bare `derived` marker that was added only to silence that false `view-field-no-source` warning can now be removed, so the field is checked again; leaving it is harmless |
| Doc to model consistency honours `\|` in table cells (GH #234, MIL-285): an inline union type such as `string \| null` in a slice doc field table no longer false-flags a mismatch | no action needed |
| `em engagement new --tracking <key>` (GH #241, [cli.md](cli.md)): the tracker key is recorded in the engagement file (schema `1.1`) and surfaces as `tracking` at the top level and per slice in `engagement plan`/`status --json` (schema `1.1`); a slice doc's own `tracking:` wins for that slice; the implementer and validator prompts carry it | no action needed. Schema `1.0` engagement files still read; consumers of the plan/status JSON should accept `1.1` |
| **One constitution locator** (GH #238, MIL-287): `.specify/memory/constitution.md` wins when it exists, otherwise `constitution.md` beside the model (symlinks followed). Before 1.16.0 a `.specify/` above the model made the spec-kit slot exclusive, so a constitution beside the model reported `absent`. The `absent` report now names every path tried, and `em upgrade` accepts spec-kit's `**Ratified**:` footer as ratification | no action needed; a repo that reported `absent` while having a ratified `constitution.md` beside its model now reports `present` |
| **An inline field block that omits commas is a parse error** (GH #245): `{ a: string  b: number }` fails with a suggestion in the comma form, instead of silently parsing the second field into the first field's type | `human:` add the commas (or put one field per line) in any model written without them; `em validate` names the line |
| **`em slice defer` on a ratified or shipped doc queues the question** (GH #236; *superseded in [1.17.0](#1170) by GH #253 — defer writes the doc, outside the hash*): the question is written to `.event-modeling.md` instead of the signed body, then injected into the next draft by `em slice mark-implemented` / `em slice revise`. `em slice revise --withdraw` is now required on a ratified doc that has not shipped. `em status` reports `issues.queuedQuestions` (status schema `1.10`); `em export` carries `slice.doc.queuedForNext` (export schema `1.17`) | no action needed. Consumers reading `schemaVersion` should accept export `1.17` and status `1.10` (both additive) |
| **Release note: nothing to run** — update the `@milehimikey/em` dependency (and the plugin pin to `em-1-16-0` / `v1.16.0` on plugin repos); `em upgrade` has no 1.16.0 step. | no action needed |

## 1.17.0

The record survives the merge: ratification and conformance facts that stay true under squash and
rebase merges and are checkable in CI.

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| **`ratifiedHash` leaves `## Open Questions`' deferrals out** (GH #253, [slice-doc-schema.md](slice-doc-schema.md#how-the-parser-reads-frontmatter)): the hash is now computed over the body minus the `## Open Questions` heading, the section's blank lines and every `deferred to v<n>` item (trailing whitespace trimmed) — a deferral describes a later version, not the one that was signed. Everything else, the section's answered `- [x]` history and any `- [ ]` included, stays signed. So **`em slice defer` on a ratified or shipped doc writes the deferred item into the doc** ([cli.md](cli.md#em-slice-defer-file-slice-key-question)) — visible to every reader of the ratified doc — and `--slice-ready`, `ratify`'s re-run and the hash all stay valid; `revise` / `mark-implemented` reopen it in the next draft as they always did for a pre-ratification deferral. A hand-added `- [ ]` on a ratified doc still breaks the hash. 1.16.0's state-file queue (GH #236) is write-retired: `defer` no longer queues; `revise`/`mark-implemented` still inject whatever a 1.16 state file holds; `em status` `issues.queuedQuestions` and `em export` `slice.doc.queuedForNext` keep their names and schemas but now count the doc's own items deferred past its `version` (plus any 1.16 leftover). The `revise` refusal on an unshipped ratified doc now says "defer it instead" | `ratified-hash-scope` re-stamps every pre-1.17 whole-body hash whose body is intact (same body — a renormalisation, not a re-signing; `ratifiedRef` is untouched) and moves queued 1.16 questions into their docs, draining the queue. Readers accept a pre-1.17 hash as intact meanwhile, and `defer` re-stamps on first touch, so nothing is blocked before the sweep. A doc whose body no longer matches its hash in either scope is listed and left alone |
| **`em slice ratify --no-ref`** (GH #255, [cli.md](cli.md#em-slice-ratify-file-slice-key---by-name)): hash-only ratification inside a git work tree — `ratifiedHash:` written, no `ratifiedRef:`, git not consulted (so the uncommitted-changes refusal does not apply), and a `ratifiedRef:` line already on the doc is removed. For a repo whose squash/rebase merges would leave the PR-branch `HEAD` unreachable once the branch is deleted — the ref would dangle, and `mark-implemented` would copy it into `shippedRef`. The docs now state the rule: `ratifiedHash` identifies the signed content; `ratifiedRef`/`shippedRef` are addresses, valid only while reachable. `mark-implemented` on such a doc writes no `shippedRef:` (it already did; now pinned). The default without the flag is unchanged | no action needed. Docs already carrying a `ratifiedRef` that squash merges have orphaned keep working — no reader resolves the ref today (GH #258 will, and will skip docs without one). To stop recording new dangling refs, pass `--no-ref` at ratify; there is no repo-level default yet |
| **`em slice revise --keep-version`** (GH #262, [cli.md](cli.md#em-slice-revise-file-slice-key)): reopens a ratified, never-shipped doc as a `draft` at the **same** `version:` — the unshipped path's status flip and sign-off clearing with no bump, for a project that holds every slice at its initial version until a first release (a `version` above 1 with no `## Delta` sat between the two implementation modes; the workaround was a hand edit of `version:`). `--withdraw` is still required with it; nothing is reopened or injected into Open Questions on this path. Refused on a shipped doc, and when the ratified `version` is the one that shipped. Plain `revise` is unchanged | no action needed; there is no model-level "never bump before first release" setting yet — the flag is per run |
| **`em slice ratify --skip-review` persists the bypass** (GH #260, [cli.md](cli.md#em-slice-ratify-file-slice-key---by-name)): when the flag is what let the ratification through, the doc gains `reviewSkipped: <status it skipped from>` right after `ratifiedOn:` (a ratification that passed review writes nothing). Cleared by `em slice revise` with the other sign-off keys. Read back as `em export` `slice.doc.reviewSkipped` (schema **`1.18`**, `null` when absent) and as a top-level `reviewSkipped` in `em validate --slice-ready <key> --json` (schema **`1.3`**), so a host gate can fail or warn on an unreviewed ratification from the PR diff. Both additive | no action needed. Consumers reading `schemaVersion` should accept export `1.18` and slice-ready `1.3`. Docs ratified with `--skip-review` before 1.17.0 carry no marker — em cannot reconstruct one |
| **`em validate --slice-ready <key> --require-ratified-hash`** (GH #256, [validation.md](validation.md#slice-readiness)): strict mode — a `ready-to-implement` doc with no `ratifiedHash:` gets `slice-ready-missing-ratified-hash` (error) and `ready: false` in `--json`. Closes the hole where a frontmatter hand-edited to ready with `ratifiedBy`/`ratifiedOn` and no hash passed readiness with no integrity check (the body-changed check needs a hash). MCP `slice_ready` takes the same switch (`requireRatifiedHash`). Default behaviour unchanged | no action needed. Opt in — in the CI gate's `em validate` line — once docs ratified before 1.15 (and `ratified-signoff`-grandfathered ones) are re-ratified; until then the flag lists exactly which docs still lack a hash |
| **Release note: run `em upgrade <model>.em` (dry-run, then `--apply`) in each consumer repo** — one mechanical step in 1.17.0 (`ratified-hash-scope`); update the `@milehimikey/em` dependency (and the plugin pin to `em-1-17-0` / `v1.17.0` on plugin repos). | `em upgrade` |
| **The hash is checked after shipping too** (GH #257): `em validate --check-signed-bodies` (opt-in) compares every doc that records a `ratifiedHash:` — `implemented` included — to its body, `slice-body-changed-since-ratification` (error) on a mismatch ([validation.md](validation.md#signed-bodies)); `em ledger` gains `ledger-body-changed-without-reratification` (schema **`1.2`**): the signed body changed between the revisions while `ratifiedHash` did not, independent of the `version:` rule and waivable like the formatting-only finding. **Behaviour change in `em ledger`:** "content" now means the signed body (`ratifiedBody`, GH #253), so a deferral `em slice defer` appends to a ratified or shipped doc is no longer a `ledger-content-without-version-bump` finding; a hand-added `- [ ]` still is | no action needed. Add `--check-signed-bodies` to the CI gate's `em validate` line to turn the current-tree check on; the ledger finding is on wherever `em ledger` already runs — a doc edited after sign-off before 1.17.0 shows up on the first run and can be baselined with `--waive` / `Em-Ledger-Waive:` |
| **`em slice conform --at <kind>:<id>`** (GH #261, [cli.md](cli.md#em-slice-conform-file-slice-key---at-rev)): `--at` may now name what the sweep actually exercised — `build:1234`, `deploy:eu-1-2026-10-15`, `env:pr-57` — instead of a git revision, for the case where certification happens from a PR branch whose HEAD a squash or rebase merge will orphan (the same dangling-pointer problem as `ratifiedRef`, now documented for `conformedAt`). A bare value is still a git revision; `:` elsewhere is refused as malformed. Recorded verbatim; the findings-check gate matches it exactly; GH #258's reachability check skips kinded values | no action needed. Existing `conformedAt` values are bare revisions and read as before |
| **`em refs <model> --reachable-from <rev>`** (GH #258, [cli.md](cli.md#em-refs-file---reachable-from-rev)): new opt-in CI check — every `ratifiedRef`, `shippedRef` and bare `conformedAt` on every slice doc is resolved and tested for reachability from a branch, per doc and per field: `ancestor` / `not-ancestor` (the squash/rebase-merge signature) / `unresolved` / `undecidable` (a shallow clone — never a pass). `--json` (`refsSchemaVersion 1.0`), `--waive <key>` and `--waive-file <path>` to baseline known-bad refs. Kinded `conformedAt` values are skipped; docs with no ref fields are not reported. No network — fetch first | no action needed; add the step to CI ([ci.md](ci.md#em-refs-opt-in)) with `fetch-depth: 0`. A repo whose history already holds squash-merged ratifications will see them on the first run — baseline the keys with `--waive-file`, and switch to `ratify --no-ref` / `conform --at <kind>:<id>` going forward |
| **A comma inside a generic or bracketed type no longer splits an inline field** (GH #249, [dsl.md](dsl.md#fields)): `{ prices: Map<string, int>, currency: string }` is two fields with `prices` typed `Map<string, int>` — the inline split now treats `<…>`, `[…]`, `(…)` and `{…}` as nesting, the same rule GH #245's "looks like two fields" check already applied. Multi-line blocks (one field per line) are unaffected. Before 1.17.0 the type was cut at the inner comma and, since 1.16.0, the leftover `int>` tripped #245's error with a wrong suggestion | no action needed; a model that worked around it (a type alias, or one field per line) keeps working |
| **`em engagement plan` pre-flight** (GH #239, [cli.md](cli.md#em-engagement-plan-file-slug---json)): the plan now lists the model-wide gaps the engagement's slices share — `repeated-invariant` (one INV id declared in the model or cited in the docs of ≥2 slices), `event-without-tag` (an engagement event with no tag: consistency boundary undeclared), `shared-trigger` (one `ui` in ≥2 slices: an endpoint with no owner), `doc-model-mismatch` (the slice's doc↔model findings) — as a `pre-flight:` block in text and `preflight[]` in `--json` (plan schema **`1.2`**, MCP `engagement_plan` too). Advisory: never a hold, never written to the Ledger. The engagement skill puts the list to the human in the same single question round as the ceiling, so seven implementers stop rediscovering the same three gaps | no action needed. Consumers reading `engagementPlanSchemaVersion` should accept `1.2` (additive) |
| **`em engagement foundation <model> <slug> --code <dir>`** (GH #240, [cli.md](cli.md#em-engagement-foundation-file-slug---code-dir---json)): the engagement precondition no longer takes the human's word that the foundation PR landed — per event the engagement's slices emit or consume, a text scan of `--code` reports `present` / `incomplete` (`missingFields`, `missingTagFields` named) / `missing-event`, so "foundation absent" and "foundation incomplete" are different reports. `--json` (`engagementFoundationSchemaVersion 1.0`), MCP `engagement_foundation`. The engagement skill's step 2 runs it: `missing-event` stops, `incomplete` is one question to the human with the gaps named | no action needed; a text match (OrderPlaced / order_placed / … on word boundaries, fields looked up in the same files), not a type check |

## 1.18.0 (unreleased)

| What changed for a model repo | Handled by `em upgrade`? |
|---|---|
| **`em validate --shape`** (GH #282, [cli.md](cli.md#--shape-gh-282)): runs only the advisory shape-family lints (`timeline-entity-clustered`, `slice-outside-storyline`, plus each shape lint that registers `family: "shape"`), prints rule / count / first ref / docs anchor and exits 0; `--json` is `shapeSchemaVersion` **`1.0`**. The design skill's model phase now ends on it: each finding fixed or recorded as `shape-accepted: <rule> <refs> — <reason>` in the Decisions log. `em engagement plan` pre-flight gains a `shape` kind (plan schema **`1.3`**, additive); the MCP `validate` tool takes `shape` and `waiveFile` | **Baseline an estate with `em validate <model>.em --shape --waive-file <path>`** (lines `<rule-code> <slice-key>`, or a bare slice key for all shape rules). Shapes you have decided to keep are listed as waived, not counted. A waiver only silences the count; each accepted shape still needs its `shape-accepted:` Decisions-log bullet. Consumers reading `engagementPlanSchemaVersion` should accept `1.3` |
| **`automation-split-by-outcome` and `retry-slice-of`** (GH #292, [validation.md](validation.md#shape)): two advisory warnings, both in the `shape` family, on a reaction split into one slice per outcome (`Order Fulfilled` beside `Order Fulfilment Failed`, each with its own command) and on a State Change slice whose only command is `Retry <X>`. Existing estates may start showing them; no export, query or plan schema change | `human:` merge the outcome slices into one with `event A \| B @Ctx`, or baseline with `em validate <model>.em --shape --waive-file <path>` (GH #290) |
| **Collection fields fed by child events** (GH #288, [dsl.md](dsl.md#collection-fields-fed-by-child-events)): a view field typed `T[]` with `derived from "E1", "E2"` now has each field of `T` traced to the named events (`fields-completeness/view-field-no-source` otherwise), `em slice sync` writes a `Collection of` note and one scenario stub per named event in the view region (copied into ## Scenarios), and `em export` adds `field.collection: boolean` (schema **`1.19`**, additive). Consumers reading `schemaVersion` should accept `1.19` | no action needed |
| **Optional ratifier roster** (GH #259, [slice-doc-schema.md](slice-doc-schema.md#who-may-ratify)): a `ratifiers.yaml` beside the model (or `--roster <path>`) makes `em slice ratify --by` and `em slice review --by` refuse names it does not permit for the slice's context, and `em validate --slice-ready` report `ratified-by-not-in-roster` (error) for a hand-edited `ratifiedBy`. No file = unchanged behaviour. `em status` gains `roster: "present" \| "absent" \| "invalid"` (status schema **`1.12`**, additive). New commands `em roster init <model>` (seeds the file from the names already in the docs) and `em roster check <model>` (whole-model CI gate); `em ci init` emits a `roster` job only when a roster is discovered, and `em upgrade` regenerates the managed CI block accordingly. A `grandfathered (unsigned before em 1.14)` sign-off is exempt from both checks until the slice is re-ratified | No: opt-in; `em roster init` is the one-step adoption, then `em ci init` to pick up the job |
| **`em status` lists slices whose next version is open over a shipped one** (GH #285, [cli.md](cli.md#em-status)): `slices.nextOpen[]` (status schema **`1.11`**, additive), the `implemented (v<n>) · draft v<n+1> open` line in the text/`--md` reports, and `(+K shipped, next draft open)` on the headline. `em slice mark-implemented` also gains `--json` (new: `{ path, changed, implementedIn, nextDraft }`) and prints a multi-line notice when it opens the next draft | no action needed. Consumers reading `schemaVersion` should accept status `1.11`; the MCP `status` tool returns the same document; no repo change |
| **Scenario-quality advisories and the INV citation convention** (GH #293, [validation.md](validation.md#scenario-quality)): `em validate` now warns when a `### Scenario:` block's When names none of the slice's commands (`scenario-when-not-command`), its Then names no event or rejection (`scenario-then-not-outcome`), or a declared `INV-…` is cited by no scenario (`invariant-without-scenario`). The convention is new: scenarios cite the INV ids they exercise. The rules are advisory: they never block `--slice-ready` or `em engagement plan` unless `em validate --strict`. `--slice-ready --json` moves to schema `1.4` (additive `advisories[]`). Older bullet-format scenarios and Delta `##### Scenario:` blocks are checked too, so existing repos see a wave of new advisories on upgrade (toolshed 59, meridian 10; advisory only). A doc with no scenarios at all is never flagged | `human:` add INV citations (title or bullet) to existing scenarios; advisory only. The `--shape --waive-file` baseline is tracked in #290 |
| **`doc-names-unfed-event` / `doc-omits-fed-event`** (GH #294, [validation.md](validation.md#doc-model-consistency)): advisory warnings when a State View doc names a model event its view does not `from` (the toolshed gap), or a view's own `from` event never appears in its doc. Existing estates may gain these warnings; they are `advisory` (never gate `--slice-ready`; `--strict` promotes them), and `doc-names-unfed-event` also rolls into `em engagement plan` pre-flight doc-model drift. | No — resolve per finding, or waive (#290). |
| **`em slice index` rows for doc-less and continuation slices** (GH #275, [cli.md](cli.md#em-slice-index-file)): a slice with no `note` binding shows `—` in `Design doc` instead of a link to a file that does not exist, and a view-again continuation row shows `—` for `Reviewed by`, `Ratified by`, `Tracking`, `Implemented in` and `Conformed` (the parent's facts no longer repeat on it). So `em slice index --check` reports stale on every existing README with such a row | `human:` re-run `em slice index <model>.em` and commit the README (`em upgrade` step `slice-index-stale`, GH #290, regenerates it) |
| **The view region lists the union of `from` across `again` instances** (GH #280, [slice-doc-schema.md](slice-doc-schema.md#continuations)): a read model's generated `em-slice-view` region now says `built from events:` with the originating instance's events followed by every `view X again` instance's (each later event annotated `(via "<slice>")` with the slice that adds it), and each field's `from event` note resolves against all of them. Before, only the one instance's own `from` was listed, so a field fed by a later instance's event read `{{ }}` | `em upgrade` step `view-doc-sources-stale` (GH #290) runs `em slice sync` on every bound doc whose view region is stale; a ratified or shipped doc is listed and left alone (sync would move its `ratifiedHash`) — `em slice revise` it, then sync. Or run `em slice sync <model>.em` by hand (after `--check`). **`em slice sync --check` reports the existing view docs of any read model with an `again` instance as stale after upgrading** — expected; sync rewrites only the generated region, never authored text |
| **Alternative events: `event A \| B @Ctx` / `oneof { event … event … }`** (GH #278, [dsl.md](dsl.md#alternative-events--event-a--b-context)): one command that records one of several facts — including two on the same context — is now ONE slice instead of a command repeated in a column per event. The alternatives share one event-lane cell (`em render` draws one box with an *or* line), each is a full event, `model.edges` is unchanged, `em export` adds `event.alternativeGroup` (export schema **`1.19`**, additive — the same version as storylines), `em slice sync` writes one `**Records one of:**` event region and `em slice new --wire` seeds one scenario per alternative. New advisory warning **`command-repeated-across-slices`** on the old one-column-per-event shape (family `shape`) and new error `alternative-events-no-command`; the `grid-collision` message now points at the new form | `human:` collapse repeated-command slices into one slice with `event A \| B @Ctx`, then `em slice sync` (an `em upgrade` step `collapse-alternative-events` is tracked in #290). Consumers reading `schemaVersion` need no change |
| **Continuations without ceremony** (GH #287, [dsl.md](dsl.md#view--again), [timeline.md](timeline.md)): several `view X again` lines may share one continuation slice (stacked in the `api` cell); `view X again from "E" [shown on "Screen"]` written inside a command's own slice synthesizes a continuation column right after it (one column per host slice with its lines stacked; key `<slice-key>--again`, no doc, not in `em slice index`); a continuation slice may omit its name and is auto-named `"<View> View: <Event>"`. Nothing existing changes: a `view … again` that shares a slice with a command or a plain view used to be a `grid-collision` error, and a slice holding neither a `command` nor a view (an event-only webhook slice, a lone processor) is not lifted, so no model that validated before changes shape. In a reaction slice a line fed by an event the slice records is lifted and needs `shown on` (that shape collided before). A hand-written continuation stays as it is; `export` `continuationOf` / `alsoReads` are unchanged (no schema bump beyond **`1.19`**) | no action needed. Folding existing hand-written continuations into the new form is optional; an `em upgrade` step `fold-continuations` is tracked in #290 |
| **`storyline "Name" [source "url"] [after "Other"] { slice … }` blocks** (GH #277, [dsl.md](dsl.md#storylines)): a named chapter grouping slices — the main journey and its secondary stories. Slices keep their file-order timeline position and a slice outside any storyline stays legal, so no model needs to change. `em render` draws a labelled band above the slice headers and `em render --storyline <name>` draws one story alone (dimmed stub columns for what it reads from outside). Once a model declares any storyline, **a slice outside every storyline is the new advisory warning `slice-outside-storyline`** ([validation.md](validation.md#storylines)). The optional `after "<storyline>"` clause composes a story's timeline (referenced → this) for `from`/`again`/the forward-only checks; `storyline-after-unknown`, `storyline-after-cycle` and `storyline-after-out-of-order` are errors. `em export` carries `slice.storyline` and `model.storylines[]` (export schema **`1.19`**, additive), `em query slices --storyline <name>` filters (query schema **`1.3`**, `slices` results gain `storyline`), and `em slice index` adds a Storyline column **only** for a model that declares storylines | no action needed. Consumers reading `schemaVersion` should accept export `1.19` and query `1.3`; add storylines when you want them, one `storyline` block at a time (the warning is advisory) |
| **One event recorded by two commands is one logical event** (GH #279, [dsl.md](dsl.md#one-event-recorded-by-several-commands), [validation.md](validation.md#shared-events)): declare the event again, bare, in the second slice — same name, same context. It no longer draws `duplicate-name`; a later declaration inherits the first's fields, tags and `public`, a differing one is the new error `shared-event-field-mismatch`, and a `view … from "Event"` draws an arrow from every recording site at or before it; every recording site now needs a reader at or after it (`event-unread`, per site). `em export` (schema **`1.19`**) sets `logicalRef` on each repeat to the first declaration's ref (additive; it was `null` for events before). Same name in a *different* context still warns `duplicate-name`. Consumers reading `schemaVersion` should accept export `1.19` | no action needed |
| **Release note: every 1.18.0 construct has an upgrade path** (GH #290, the 1.18.0 definition of done). The step ids, by change: | run `em upgrade <model>.em` (dry-run, then `--apply`) in each consumer repo |
| `view-doc-sources-stale` (GH #280, since 1.18.0): detect = `em slice sync --check` would change a bound doc's view region; apply = run sync on those docs, one commit. Ratified or shipped docs are reported and left alone | mechanical (a signed doc is the human item `slice-doc-stale-signed`) |
| `slice-index-stale` (GH #275, since 1.18.0): detect = `em slice index --check` reports the README Slices table stale; apply = regenerate it, one commit. No README or no markers = not applicable | mechanical |
| `parking-lot-fragments` (GH #283, since 1.18.0): detect = a `.event-modeling.md` parking-lot bullet `- <text> (from slice <key>, deferred to v<n>)` whose `<text>` is a strict substring of exactly one of that slice doc's Open Questions items (what pre-1.18 `em slice defer` wrote); apply = rewrite it to the item's label (the bold title, else the whole item — what `defer` writes now) | mechanical |
| `em storyline suggest <model>.em` (GH #277, advisory): proposes `storyline` blocks — one per distinct slice `source "url"`, the remaining slices grouped by the `view … again` chains they feed — as a unified diff on stdout; never writes the model. Apply with `git apply` / `patch -p1` after review. Not an `em upgrade` step (choosing the main story needs judgment) — see [cli.md](cli.md#em-storyline-suggest-file) | human, assisted |
| `collapse-alternative-events` (GH #278, since 1.18.0, shipped): detect = adjacent slices that repeat ONE command (same text, no `note` beyond the first slice) and differ only in the recorded event on one context; apply = one slice recording `event A \| B @Ctx` (identical payloads) or `oneof { … }` (payloads or clauses differ). Lineage follows [slice-doc-schema.md § Lineage](slice-doc-schema.md#lineage-grammar-and-cardinality): the first slice's key is kept and its bound doc (cross-binding aware) gains `merged-from: <retired-key>@v<N>`; each later slice's doc moves to `archive/slices/<file>.md` (outside `slices/`, so it is not an orphan) with `superseded-by: <kept-doc>@v<N>` and a SUPERSEDED banner under its frontmatter; `em export` shows the back-link as `slice.doc.mergedFrom`. When an archived doc holds authored Scenarios, Invariants, Open Questions or Decisions, the dry-run and `--apply` output lists it with "fold these into <kept doc>". The kept doc's event region is synced; a SIGNED kept doc is left byte-identical (no `merged-from` either) and reported by the human items `slice-doc-stale-signed` and `lineage-backlink-missing` (`em slice revise <key>`, then `em slice sync`). Dry-run lists the before/after slice names. A run is skipped, never guessed, when a declaration sits between the slices or a later slice carries a `note` | mechanical, with a dry-run listing |
| `shared-event-now-legal` (GH #279, since 1.18.0, shipped): information only, a human item — listed when an event is recorded by more than one command and the repo is being upgraded from before 1.18.0 (a 1.18.0-stamped repo does not see it again); `duplicate-name` no longer fires and nothing needs to change | none |
| `fold-continuations` (GH #287, since 1.18.0, shipped, **opt-in**): detected and listed by every run (and as the human item `fold-continuations-opt-in`) but applied only by `em upgrade --apply --fold-continuations`. Default form: consecutive hand-named continuation slices that continue the SAME read model (and show the same `ui`s) are stacked into ONE continuation slice keeping the FIRST slice's name and key — several `view X again` lines in it — so `continuationOf`, the doc join and the kept key's index row are exact; the dropped keys are listed in the reason, and continuations of a different view are left alone. A signed origin doc whose generated `via` annotations go stale is named in the reason (`em slice revise <key>`, then `em slice sync`). `--to-sugar` (a further opt-in, implies `--fold-continuations`; without `--apply` it is a dry run listing exactly what would fold, the dropped keys and the index rows removed) instead moves them into the host command slice as `view X again … shown on "Screen"` lines: that **changes `continuationOf` and the doc join to the host (`<host>--again`) and removes the folded slices' index rows**. A host whose continuations span several views is REFUSED (left unfolded, reason "continuations of several views — fold by hand or keep the stacked slice") rather than re-joining another view's instance into the first view's, possibly signed, doc. Opt-in proposals print as `[~]` and are not counted in the "N step(s) applicable" summary | mechanical, opt-in |
| `em roster init` (GH #259, shipped): `em upgrade` lists the human item `roster-not-initialised` when slice docs carry `ratifiedBy` / `reviewedBy` names and no `ratifiers.yaml` exists above the model; run `em roster init <model>.em` yourself — signatures are a human decision, so `em upgrade` never writes the roster | human, assisted |
| `em validate --shape` and `--waive-file` (GH #281 / #286 / MIL-243 lints, #282, shipped): the text report of `em upgrade` (dry-run and `--apply`) ends with the `em validate --shape` table and the sentence on recording accepted shapes as `shape-accepted: <rule> <refs> — <reason>` bullets in the Decisions log; no waive file is generated — baseline an estate with `em validate <model>.em --shape --waive-file <path>` once you have decided which shapes to keep | mechanical baseline (opt-in) |
| Reshaping an existing model (GH #276, [storyline.md](storyline.md#reshaping-an-existing-model)): the "Reshaping an existing model" checklist, mirrored in the skill bundle's `methodology.md`, with the design skill's storyline review before slice-doc scaffolding; `em storyline suggest` (above) is the assisted first step | human, skill-driven |
| Export schema bump (`1.19`, status `1.11`, query `1.3`): consumers (portal, em-sdd-bridge, tracker-bridge) accept the new versions; the rows above carry each field | docs |

### Upgrading to 1.18.0

Update the `@milehimikey/em` dependency (and the plugin pin to `em-1-18-0` / `v1.18.0` on plugin repos), then in each consumer repo:

```bash
em upgrade <model>.em            # dry-run: lists every step below and the human items
em upgrade <model>.em --apply    # one git commit per step, then the final `Em version:` commit
```

The 1.18.0 steps, in order: `collapse-alternative-events`, `fold-continuations` (these two rewrite the `.em`; the second is opt-in: `--fold-continuations`, and `--to-sugar` for the host form), `view-doc-sources-stale`, `slice-index-stale`, `parking-lot-fragments`. Human items: `slice-doc-stale-signed`, `lineage-backlink-missing`, `fold-continuations-opt-in`, `shared-event-now-legal` (information only), `roster-not-initialised`. The report ends with `em validate --shape` so you see the advisory shape findings of the upgraded model. Then run `em storyline suggest <model>.em` if you want storylines, and review the result: the `.em` rewrites are text edits verified by recompiling, but the dry-run listing is the place to catch a grouping you disagree with. `--apply` recompiles the model after every step, so it may do MORE than the dry run reported: a fold can become possible only after a collapse, and the doc/index steps see the rewritten model. Treat the dry run as a lower bound and run `--apply` on a clean branch.
