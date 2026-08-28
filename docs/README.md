# em documentation

New to the tool? Start with the [tutorial](tutorial.md) — it builds a complete model from
an empty file in about twenty minutes. Already have a model and wondering what comes next?
[workflow.md](workflow.md) is the lifecycle: specify, gate, hand off, track change, and
check the model against the code that implements it. And [process.md](process.md) is the
map of who does what — which parts of that lifecycle need humans in the room, and which an
agent can carry with human review.

| I want to… | Read |
|---|---|
| Learn the tool from scratch | [tutorial.md](tutorial.md) |
| See a complete, worked project — not just a bare model file | [examples/order-fulfillment/](../examples/order-fulfillment/) |
| See a multi-model project laid out correctly (one directory per model) | [examples/multi-model/](../examples/multi-model/), and [cli.md#multi-model-projects](cli.md#multi-model-projects) |
| See how the pieces fit together over the life of a model | [workflow.md](workflow.md) |
| Know which steps need humans, and which an agent can do | [process.md](process.md) |
| Hand a ratified slice to an agent to implement | [process.md](process.md#handing-a-slice-to-an-agent), and the [agent guide](../.claude/skills/event-modeling/reference/implement.md) it points to |
| Understand the four Event Modeling patterns | [patterns.md](patterns.md) |
| Look up DSL syntax (keywords, `from`, `again`, fields, notes, issues) | [dsl.md](dsl.md) |
| Look up the slice-doc frontmatter schema (version, lineage, required-vs-optional keys) | [slice-doc-schema.md](slice-doc-schema.md) |
| Look up a command or flag | [cli.md](cli.md) |
| Understand a validation error or warning | [validation.md](validation.md) |
| Understand why arrows can't point backward | [timeline.md](timeline.md) |
| Run a guided modeling session with Claude | [ai-workflow.md](ai-workflow.md) |
| Check whether the code still matches the model | [workflow.md](workflow.md#6-check-the-model-against-the-code) |
| Feed a model to other tooling (JSON export, structural diff) | [cli.md](cli.md#em-export-file) |
| Give an MCP client (Claude Code, Cursor, ...) structured tool access to a model | [mcp.md](mcp.md) |
| Check vocabulary consistency across multiple models | [cli.md](cli.md#em-glossary-files) |
| Validate models in CI, or run conformance on a schedule | [ci.md](ci.md) |
| Know what's bundled vs. what needs a system install | [dependencies.md](dependencies.md) |
| See what usage data em captures, and how to roll it up for a retro | [usage-data.md](usage-data.md) |
| Understand how rendering works under the hood | [architecture.md](architecture.md) |
| Cut a release (version, notes, npm, Linear) | [release.md](release.md) |
| See what's planned | [roadmap.md](roadmap.md) |

Worked models live in [examples/](../examples/) — most are single `.em` files, but
[examples/order-fulfillment/](../examples/order-fulfillment/) is a full project directory
(slice docs, resumable state, generated README) for exploring the whole toolchain in one
place, [examples/multi-model/](../examples/multi-model/) shows two models correctly laid out
side by side (one directory per model, see [cli.md#multi-model-projects](cli.md#multi-model-projects)) —
and a full-scale AI-built model (a headless CPQ system, ~50 slices) in the
[em-with-ai repository](https://github.com/milehimikey/em-with-ai).
