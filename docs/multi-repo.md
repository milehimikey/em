# Models and code in more than one repository

`em` supports the repository layouts common in larger systems: the model in one repository and
the code in another, a frontend and a backend repository, one repository per service. This page
says which layouts are covered, how to choose between them, and what you set up for each.

Since 1.24.0. If your model and its code share one repository, nothing here applies to you and
nothing in `em` changed.

## Two separate questions

Every layout answers two questions, and they are independent:

1. **Where do the models live?** One model, or several joined by seams, in one repository or in
   several. `em` has handled this since 1.10: several models, `consumes` on translations, and
   `em system` verifying the seams, including across repositories from published exports
   ([process.md](process.md#seams-between-models-who-does-what)).
2. **Where does one model's code live?** This is what 1.24.0 adds. A model's code can be in
   other repositories than the model, and in more than one.

## The layouts

| # | Layout | What divides a slice | What you set up |
|---|---|---|---|
| 1 | Model and code in one repository | Nothing | Nothing. The state file's `Code roots:` says where the code is, as before |
| 2 | Model repository separate from one code repository | Nothing | `repos:` with the code repository; a code map with a `default:` |
| 3 | Frontend repository + backend repository (plus a BFF or a mobile app) | The element's kind and persona: a `ui` is in the frontend, the rest in the backend | `repos:` with each; a code map with a `default:` and `personas:` |
| 4 | One model, one repository per service | The context: each service owns the events of its context | `repos:` with each service; a code map with `contexts:` |
| 5 | One model per service repository, joined by seams | The model boundary. No slice is divided | Nothing new: each model is layout 1 in its own repository, and `em system` joins them |
| 6 | Several monorepos, one per domain | A repository plus a path prefix | As 3 or 4, with `root:` on each place |

A hybrid is a combination of these and needs nothing of its own: a frontend repository plus one
repository per service is 3 and 4 in one code map. A separate contracts repository is one more
destination for `em api generate`'s output, not a layout.

Not covered: infrastructure and GitOps repositories (model elements do not map to manifests),
the release choreography of shared libraries, merging across repositories atomically, and
anything that needs `em` to clone, pull or push. `em` resolves the checkouts you have and
reports the ones you do not.

## Which to pick

**If each service ships on its own, give each its own model (layout 5).** That is `em`'s
recommendation, and it is the one layout where no slice is ever split: a team owns a model, its
slices and its code in one repository, and what crosses between teams is a contract with a
named consumer, checked by `em system`. See
[Seams between models](process.md#seams-between-models-who-does-what).

**One model across service repositories (layout 4) is supported, and is the right start** when
the services are still one team's work, or the boundaries are not settled enough to write
contracts for. Routing by context covers it. Expect to split into models joined by seams once
the services release independently: a slice whose code spans two services is two pull requests
that have to land together, and that coupling is what a seam makes explicit.

**Frontend and backend (layout 3) usually stay one model.** A screen and the command behind it
are one decision, made and ratified together, even when they are built in two repositories. The
slice is then two work units built in parallel against the generated contract.

## Setting it up

Three files hold three different facts, and only two are committed
([code-map-schema.md](code-map-schema.md)):

1. **Which repositories exist**: `repos:` in `system.yaml`, in the model's repository
   ([cli.md](cli.md#the-manifest-schema-20)). A single-model project needs a `system.yaml` to
   name any repository other than its own.

   ```yaml
   systemSchemaVersion: "2.1"
   repos:
     storefront-web: { remote: "git@github.com:acme/storefront-web.git" }
     checkout-svc:   { remote: "git@github.com:acme/checkout-svc.git" }
   models:
     checkout: { source: checkout/checkout.em }
   ```

2. **Where each part of the model's code lives**: `code-map.yaml`, beside the model.

   ```yaml
   codeMapSchemaVersion: "1.0"
   default:  { repo: checkout-svc }
   personas:
     Customer: { repo: storefront-web, root: src/checkout }
   ```

3. **Where each repository is checked out on this machine**: not committed. Check the
   repositories out side by side, each in a directory named after its repo id, and nothing more
   is needed. Otherwise map them in `.em/repos.local.yaml` or with `--repo <id>=<path>`.
   `em repos check` shows what resolves ([cli.md](cli.md#em-repos-check-target)).

Then `em validate` checks the code map with the model, and `em query slices` shows each slice's
places. [`examples/multi-repo/`](../examples/multi-repo/README.md) is a worked example.

## What changes once code is in several places

**The unit of work is a slice in one repository.** A slice whose code is in two repositories is
built as two **work units**, each with its own branch, implementer and pull request
([cli.md](cli.md#em-engagement-plan-file-slug---json)). A slice in one repository is one unit,
as before.

| | One repository | Several |
|---|---|---|
| Plan | One entry per slice | Also `units`: one node per slice × repository, one closing step per slice |
| Brief | One per slice | One per work unit, with the slice's other units as context |
| Ledger | One line per slice | The same line, with a record per unit; the slice is `merged` when all are |
| Bindings | The slice's file, committed with the code | One file per slice still, in the model's repository; each binding names its `repo:`; written at the slice's closing step |
| `implementedIn:` | One PR URL | One per unit, `<repo>=<url>,…` |
| Conformance revision | One revision | One per repository, `<repo>=<rev>,…` |
| Conformance scope and freshness | One repository diffed | Each repository diffed at its own revision |

**Each slice ends with a closing step in the model's repository.** It waits for every unit's
pull request, writes the slice's bindings file from what the implementers handed back, and
records the slice as implemented
([external-implementers.md](external-implementers.md#when-the-code-is-in-another-repository)).

**`em` plans and records; it does not run the work.** Claims on units, retries and noticing a
merge belong to whatever drives it: the engagement skill, or your own harness
([harness.md](harness.md)).

**One em pin, in the model's repository.** A code repository carries no `em` version of its
own ([ci.md](ci.md#a-code-repository-run-em-at-the-models-pin)).

## Two kinds of revision, and which repository each belongs to

Once code is in several repositories, a slice doc records commits of more than one. They are
not interchangeable:

| Field | A commit of | Why |
|---|---|---|
| `ratifiedRef:` | The **model's** repository | The design as it was when it was signed |
| `shippedRef:` | The **model's** repository | The design that shipped: the doc's `ratifiedRef` at merge. It is single, however many repositories the code is in |
| `conformedAt:` | The **code** repositories | The code revision a conformance run checked, one per repository as `<repo>=<rev>,…` ([cli.md](cli.md#one-revision-per-repository)) |
| State file `Last conformance:`, `Certified:` | The **code** repositories | The same code revisions, for the model as a whole |

`em refs --reachable-from` checks the model-repository commits, and the `self` entry of a
per-repository `conformedAt:`, in the model's repository. `em freshness` reports, per code
repository, whether its recorded revision still resolves and how far behind HEAD it is.

## Acceptance, per layout

What "works" means for each layout, as the test suite checks it:

- **1.** A project with no `repos:` and no code map produces the same plan, brief, Ledger and
  export as before, apart from schema version strings.
- **2.** With one code repository, every slice is one unit there, and the bindings check passes
  against that repository with no flags.
- **3.** A State Change slice with a `ui` and a command is two units and two pull requests, and
  is `merged` only when both are.
- **4.** An Automation slice whose trigger and command are in different contexts is one unit per
  service repository.
- **6.** Two places in one repository with different roots are one unit and one pull request.

## Not in this release

- `em ci init` does not generate a workflow for a code repository, and the generated conformance
  workflow checks out only the model's repository. Write those jobs by hand
  ([ci.md](ci.md#a-code-repository-run-em-at-the-models-pin)).
- For models in separate repositories (layout 5), `em system codeowners` and `em system scope`
  read one repository's CODEOWNERS and one repository's diff.
