# The story, not the schema

An event model is a **story**, not a data model. Models drafted from a spec tend to come out as one block
per entity (create, update, archive) with a read model trailing each. That is CRUD laid on a timeline.
This page states the rules that keep a model a story, and the reshaping checklist for models that already
aren't. The same rules ship to agents as "The story, not the schema" in the skill bundle's
`methodology.md`, and the discover and design skills gate on them.

Which rule is whose: statements quoted from the canon are cited; rulings marked **(em ruling)** are em's
own. Neither Dymitruk nor Dilger states a child-entity rule or bans "Update" or "Set" by name.

## The canon

- Adam Dymitruk, [*What is Event Modeling*](https://eventmodeling.org/posts/what-is-event-modeling/): a
  model tells "a story of what success looks like", "on a time line and with no branching". "Intentions to
  change the system are encapsulated in a command… As opposed to simply saving form data to a table."
  "All information has to have an origin and a destination." Failure is shown with "a few of these stories
  to show how a command can and cannot succeed" - a Given/When/Then scenario first; "alternate workflows"
  are added to the blueprint only if core.
- Martin Dilger, [cheatsheet](https://eventmodelers.ai/cheatsheet): "Model behavior, not structure." "Name
  by intent." "Every command has a reason." "Every Read Model answers a question. No question, no Read
  Model." "Every slice is built from exactly one of the four patterns." "A wide blue arrow spanning several
  slices groups them into a named chapter."
- Dilger, *Modeling branches*: "have one linear flow from left to right. No exceptions... Linearize it!"
  A failure outcome starts a later **chapter** linked back to the originating event. *The protocol*: write
  the "movie script", start at the ending, "Model one process at a time, each with its own clear ending."
- Dilger, *Command handler simplicity* and *anti-patterns*: "One decision. One event. One state change."
  (the "Left Chair": Register Customer emitting four events). One business action with two possible
  outcomes (PaymentIssued / PaymentFailed) is the legitimate exception. The "Right Chair" is a view that
  knows everything.
- Dilger, *Seven insights*: "If your Event Model doesn't reflect terms used by business experts -
  especially in the recorded Events - that's a red flag."

## Rules

### 1. One journey per process, start to finish

The timeline is one business journey per process, ending in an outcome. The **main storyline** is the
end-to-end happy path; retire, extend and reorganize are **secondary storylines** (chapters). Never one
lifecycle block per entity. A `storyline "Name" { ... }` block names the slices that belong to one story
([dsl.md](dsl.md#storylines)); name the main storyline and every secondary one even when the model uses no
`storyline` blocks yet.

### 2. The story already exists: build from walkthroughs first

A spec's walkthroughs, use cases and user journeys are where the story is. Build the timeline from those.
The resource or API reference (OpenAPI, endpoint tables, migrations) fills in only the operations no
walkthrough touches, and is read last. A headless system still has callers: a persona per API caller, and
that caller's journey is the story.

### 3. The CRUD shape, named

N entities, each with create / update / archive, one trailing view per entity, and no read across contexts.
Both models below validate. The first reads as a schema, the second as a story.

```em
model "Catalog (CRUD shape)"

persona Merchandiser

context Category
context Product

slice "Create Category" {
  ui Category Form @Merchandiser
  command Create Category
  event Category Created @Category
}

slice "Update Category" {
  ui Category Form @Merchandiser
  command Update Category
  event Category Updated @Category
}

slice "Archive Category" {
  ui Category Form @Merchandiser
  command Archive Category
  event Category Archived @Category
}

slice "Categories" {
  view Categories from "Category Created", "Category Updated", "Category Archived"
  ui Category List @Merchandiser
}

slice "Create Product" {
  ui Product Form @Merchandiser
  command Create Product
  event Product Created @Product
}

slice "Update Product" {
  ui Product Form @Merchandiser
  command Update Product
  event Product Updated @Product
}

slice "Archive Product" {
  ui Product Form @Merchandiser
  command Archive Product
  event Product Archived @Product
}

slice "Products" {
  view Products from "Product Created", "Product Updated", "Product Archived"
  ui Product List @Merchandiser
}
```

Storyline-ordered: the main story first, the secondary story after it, each command an intent, and each
view repeated right after the command that changes it. This model demonstrates rules 1, 3 and 7; rules 4-6
and 8 have no worked example here.

```em
model "Catalog (storyline shape)"

persona Merchandiser
persona Shopper

context Category
context Product

storyline "Bring a product to market" {
  slice "Define Category" {
    ui Category Form @Merchandiser
    command Define Category
    event Category Defined @Category
  }

  slice "Catalog Tree" {
    view Catalog Tree from "Category Defined"
    ui Browse Catalog @Merchandiser
  }

  slice "Create Product" {
    ui Product Form @Merchandiser
    command Create Product
    event Product Created @Product
  }

  slice "Catalog Tree with Product" {
    view Catalog Tree again from "Product Created"
    ui Browse Catalog @Merchandiser
  }

  slice "Product Page" {
    view Product Page from "Product Created"
    ui Read Product Page @Shopper
  }

  slice "Set Price" {
    ui Pricing Panel @Merchandiser
    command Set Price
    event Price Set @Product
  }

  slice "Product Page with Price" {
    view Product Page again from "Price Set"
    ui Read Product Page @Shopper
  }
}

storyline "Retire a product" after "Bring a product to market" {
  slice "Retire Product" {
    ui Pricing Panel @Merchandiser
    command Retire Product
    event Product Retired @Product
  }

  slice "Catalog Tree without Product" {
    view Catalog Tree again from "Product Retired"
    ui Browse Catalog @Merchandiser
  }
}
```

The mechanical half of rule 1 is the `timeline-entity-clustered` lint ([validation.md](validation.md)).

### 4. Commands name intent, not endpoints

One endpoint may carry several intents (a mutation facade routing one POST to more than one command). Two
intents in one command show up as invariants or field rules that apply only "if `<field>` is set": split
the command. Both commands may record the same event (precedent: `CreateProduct` and
`CreateProductVariant`, the same `POST /products`, the same `ProductCreated`). The storyline check: if a
step reads awkwardly with the command's name, the command is named after the endpoint. The mechanical
half is the `command-second-intent` lint.

### 5. A read model is one information need

Dilger's question test: every read model answers a question, and you add one only when no existing view
answers the query. A nested route hints that the child belongs in the parent's view; the real test is
whether the query needs information the parent view lacks. **(em ruling)**

- Child with references only: the parent view carries the ids.
- Child with its own data: embedded in the parent view. The embedded collection is written as
  `values: ValueType[] derived from "Child Created", "Child Deleted"`; see
  [dsl.md](dsl.md#collection-fields-fed-by-child-events).
- Child queried without the parent id: its own view.

Aggregate rules decide write-side consistency, never the shape of a read model.

### 6. Children belong in the parent's context on the write side

When a child's invariants are checks against the parent, the child's events live on the parent's context.
A sub-resource schema shared across parent types is one event per parent, on that parent's context, not a
shared aggregate: check the spec's event reference, not its resource section. Where two slices do record the
same fact, repeat the event bare (same name, same context) rather than inventing a second name. **(em
ruling)**

### 7. Repeat the view after every command that changes it

Use `view X again` right after the event that updates it (span-1), so the reader sees the information
arrive instead of one view at the end. See [dsl.md](dsl.md) and the repeat-read-models rules in
`methodology.md`. Instances of one view are never connected by an arrow.

### 8. Outcomes are events of one slice

One decision, one event. Outcomes are events of one slice: a business action with two possible outcomes
(PaymentIssued / PaymentFailed) records both as alternative events on one context in one slice, written
`event A | B @Ctx` (GH #278), instead of splitting the action into one slice per outcome. Write the failure
as a Given/When/Then scenario first; it becomes a chapter (a secondary storyline) only when it is core. The
automation form of the rule is in [patterns.md](patterns.md#automation); the `automation-split-by-outcome`
lint is its mechanical half.

## Judgement calls

- **Several processes:** one storyline per process, ordered by the sequence a customer first meets them.
  Secondary storylines follow the main one (file order or `after`).
- **Failure: chapter or scenario?** A failure is core, and gets its own chapter, when it changes what the
  user does next or has its own actor or SLA. Otherwise it is a scenario of the slice.
- **A generic update endpoint with no conditional invariants:** look for the intent in each walkthrough
  step that calls the endpoint, and name or split the command per step ("Reprice Product", "Correct
  Description"). Keep the generic name only when no walkthrough calls it.

## Reshaping an existing model

The upgrade path for a model that is already CRUD-shaped. Work top to bottom; run `em validate` after each
step.

1. **Name the processes.** List the business journeys the model serves (from walkthroughs, use cases,
   journeys, not from endpoints). Pick the main storyline; name each secondary one.
2. **Reorder the slices into those stories.** Move slices so each storyline's slices run in the order the
   journey happens. A slice that fits no story is a candidate for deletion. Wrap each story in a
   `storyline "..." { ... }` block, adding `after "..."` where one story follows another.
3. **Intent test per command.** Rename each command to the intent a business person would say. Split any
   command whose invariants or fields apply only "if X is set" (rule 4).
4. **Question test per view.** For each view, write the question it answers. Merge views that answer the
   same question; add a view only for a question nothing answers (rule 5).
5. **Place children.** Move child-entity events onto the parent's context when the child's invariants check
   the parent; repeat shared events bare (rule 6).
6. **Repeat views span-1.** Put a `view X again` after every command that changes `X` and drop the one
   trailing view (rule 7).
7. **Fold outcomes.** Collapse success/failure slice pairs into one slice with alternative events;
   keep a failure as a chapter only when it is core (rule 8).
8. **Re-run `em validate`** (and, once shipped, `em validate --shape`, the 1.18.0 design exit gate). Update
   slice docs whose slice names changed.
