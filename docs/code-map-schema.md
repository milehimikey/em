# Code map schema (`codeMapSchemaVersion` 1.0)

A code map is `<model dir>/code-map.yaml`, beside the model (GH #527, since 1.24.0). It says
where the model's code lives when that is not simply "in this repository, under the state file's
code roots": in another repository, in several, or under different roots of one.

**A project whose model and code share one repository does not need this file.** With no
`code-map.yaml`, nothing in `em` changes: the state file's `Code roots:` bullet keeps saying where
the code is, exactly as before, and `em system scope` reads it for `code-spans-seam` as it always
has.

**It is a file contract.** `em` only reads it; nothing in `em` writes it.

## Why it is not in the `.em` file

Where code lives is not part of the design. Moving a service to another repository must not
change the model's text, and so cannot move a ratified hash. The model says *what* (a persona, a
context); the code map says *where*.

## Three files, three facts

| File | In git? | Says |
|---|---|---|
| `system.yaml` → `repos:` ([cli.md](cli.md#the-manifest-schema-20), manifest schema 2.1) | yes | Which repositories exist: a logical **repo id** and its remote |
| `code-map.yaml` (this page) | yes | Which repo id, and which root inside it, each part of one model lives in |
| `.em/repos.local.yaml` ([cli.md](cli.md#emreposlocalyaml)) | no | Where each repo id is checked out on this machine. Optional: `--repo <id>=<path>` and a sibling directory named after the id also resolve one |

The repository list is not allowed here: a top-level `repos:` in a code map is an error. A model
that places anything outside its own repository therefore needs a `system.yaml`, even when it is
the only model.

## Example

```yaml
codeMapSchemaVersion: "1.0"
default:  { repo: checkout-svc, root: services/checkout }
personas:
  Customer: { repo: storefront-web, root: src/checkout }
contexts:
  Payments: { repo: payments-svc }
elements:
  place-order/ui.order-summary: { repo: mobile-app, root: app/checkout }
```

## Keys

| Key | Type | Meaning |
|---|---|---|
| `codeMapSchemaVersion` | string, `"1.0"` | Required. Any other value is refused. |
| `model` | string (optional) | The model file this map describes, as a bare file name (`checkout.em`). Give it only when the directory holds more than one `.em` file: a map that names another model in the directory is not applied to this one (and is not reported against it, even when malformed), the same way a state file's `Model file:` works. The name must match a file exactly, case included; a `model:` that names no file in the directory is `code-map-invalid`, so a typo cannot switch the map off unnoticed. Absent, the map describes every model in the directory. |
| `default` | place (optional) | The place of every element no other rule places. Absent, the state file's `Code roots:` are the default, in `self` (see Routing). |
| `personas` | mapping: persona name → place (optional) | Routes `ui` elements. The name is spelled as the model declares it, without the `@`. |
| `contexts` | mapping: context name → place (optional) | Routes everything that is not a `ui`. The name is spelled as the model declares it, without the `@`. |
| `elements` | mapping: element export ref → place (optional) | Per-element overrides, keyed by the ref `em refs` prints (`<slice-key>/<kind>.<slug>`). |

At least one of `default`, `personas`, `contexts`, `elements` must be present. Unknown keys
anywhere are errors, not ignored.

### A place

A **place** is a repository plus a root path inside it:

| Key | Type | Meaning |
|---|---|---|
| `repo` | repo id | A repo id declared under `repos:` in the governing `system.yaml`, or `self`. Omitted, it is `self`. |
| `root` | string | A path relative to the repository root, `/`-separated. Omitted (or `.`), it is the repository root. An absolute path, a backslash, or a `..` segment is refused. `./a/b/` is read as `a/b`. |

A place names `repo`, `root`, or both. **`self` is the repository the model itself lives in.**
It is reserved, never declared in `repos:`, and needs no `system.yaml`: a map made only of `self`
places (a monorepo whose services sit under different roots) stands alone.

Two places are the same place when both `repo` and `root` match. Two roots in one repository are
two places in one repository.

## Routing

Each element gets its place from the first rule that applies:

1. **An `elements:` override** for the element.
2. **A `ui` routes by its persona**: the `personas:` entry for its `@Persona`.
3. **Everything else routes by context**: the `contexts:` entry for its context. In the DSL only
   an `event` carries a context (`@Context`), so the other kinds borrow one:

   | Element | Routes by the context of |
   |---|---|
   | `event` | itself |
   | `view` | the events it reads (`from`) |
   | a processor, translation or other automation-band element that reads something (`from "View"`) | nothing: it takes the **place** of what it reads, override included. A reaction lives with its trigger (`placedBy: "reads"`) |
   | `command`; a reaction fed from outside the model (no `from`) | the events declared in its own slice: the facts it records |

   When those contexts all route to one place, that is the element's place. A context with no
   `contexts:` entry routes to the default.
4. **The default**: `default:`. When the map has none, the state file's `Code roots:` bullet is
   the default (GH #530): each root it lists is a place in `self`. The bullet has always meant
   "this model's code is under these paths of this repository", so a map only needs to say what
   lives somewhere else. With several roots the element gets several places, all in `self`.

A later instance of a view (`view X again`) or a bare repeat of an event is the same read model
or the same fact, so it lives where its first instance lives, including under an override on the
first instance.

**`em` never picks between two places.** When the contexts an element borrows route to different
places (a view that reads events from two services), the model does not say where the element
lives, and it is reported as unplaced (`code-map-element-unplaced`) until an `elements:` override
settles it. A reaction that reads such a view is unplaced for the same reason, and the one
override on the view places both. The same goes for a reaction that reads two things living in
different places.

One case is settled by the rule above rather than reported: a view whose later `again` instance
reads another service's events lives where its first instance lives.

**An Automation slice can span two repositories.** Its processor follows the to-do list it
watches and its command follows the event it records. When those sit in different contexts, the
slice has two places.

## Finding the manifest

A model command is run on a `.em` file, not on a manifest. The repo ids a code map may name come
from the nearest `system.yaml` at or above the model's directory, looking no higher than the root
of the git repository the model is in. A `system.yaml` outside that repository does not govern
the model.

## Reading the result

`em export` publishes each element's place, each slice's places and the model's places
(export schema 1.23, [cli.md](cli.md#em-export-file)); `em query slices` carries each slice's
places and filters by `--repo <id>` (query schema 1.4). A model with no code map publishes none
of it.

`em repos check` ([cli.md](cli.md#em-repos-check-target)) reports each declared repo id as
resolved, missing or not a git repo on this machine.

## Validation

`em validate` checks the code map with the model. All six rules are errors, and none can fire on
a model with no `code-map.yaml`
([validation.md](validation.md#code-map)):

| Code | When |
|---|---|
| `code-map-invalid` | The file is not valid YAML, or its shape is wrong |
| `code-map-unknown-repo` | A place names a repo id that is neither `self` nor declared under `repos:` in the governing `system.yaml` (reported once per id) |
| `code-map-unknown-persona` | A `personas:` key is not a persona of the model |
| `code-map-unknown-context` | A `contexts:` key is not a context of the model |
| `code-map-unknown-element` | An `elements:` key is not an element ref of the model |
| `code-map-element-unplaced` | An element has no place: no rule covers it and there is neither a `default:` nor a `Code roots:` bullet, or the contexts it borrows route to different places |

A diagnostic about the file names `code-map.yaml` at the start of its message, and its `line`
counts in that file (the text output prints `code-map.yaml:<line>`). `code-map-element-unplaced`
points at the element's line in the model and carries its ref.
