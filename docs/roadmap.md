# Roadmap

Directions under consideration, in rough priority order. Nothing here is a commitment.

- **Information-completeness validation** — trace every read-model and UI field back to a
  field on a source event, and every event field back to a field on the command that
  produced it; warn on gaps. This is the payoff of the fields feature for the slicing
  process.
- **Multi-word `@tags`** — quoted persona/context tags (`@"Customer Service"`).
- **Uniform-per-lane box height** — optional rigid alignment when field counts differ a lot
  within a lane (the current default is Graphviz center alignment).
- **Theming / palette options** and additional export niceties.
- **Pure-JS PDF** so PDF needs no system dependency either.

Have a case for one of these, or something missing? Open an issue.
