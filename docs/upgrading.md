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
8. `system-manifest` — migrate the nearest `system.yaml` (found by walking up from the model to
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
