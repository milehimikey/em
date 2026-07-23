# Findings: Current Skill Anatomy

Source: direct read of `.claude/skills/event-modeling/` (2026-07-23).

## Structure and sizes

| File | Lines | Loaded |
|---|---|---|
| `SKILL.md` | 197 (~3,100 tokens) | Always, on skill invocation |
| `reference/methodology.md` | 187 (~3,000 tokens) | On demand ("read before doing real work") |
| `reference/em-dsl.md` | 197 (~2,500 tokens) | On demand |
| `templates/state.md` | 39 | Copied into models as `.event-modeling.md` |
| `templates/slice.md` | 70 | Copied per slice |
| `templates/model-readme.md`, `templates/live.html` | 31 / — | Copied |

- Phase dispatch: `$ARGUMENTS` picks `discover` / `model` / `slice` / `watch` / `validate`;
  no argument resumes from the `.event-modeling.md` state file (SKILL.md preconditions step 3,
  lines 61–62).
- Per-phase directive sections in SKILL.md are terse (~15–25 lines each, ~110 lines total).
- The state file template already has a Decisions log and an Open Questions parking lot —
  extract's TBD discipline extends existing structure rather than inventing new.

## Load-bearing facts for the design

1. **Progressive disclosure is already the house pattern.** SKILL.md is the only always-loaded
   file; the two reference files load only when real work starts. A new phase can follow the
   same shape: short dispatch stub in SKILL.md, full playbook in its own reference file.
2. **Stance conflict (the decisive finding).** `methodology.md` step 1 instructs: "Model the
   process the business **needs**, not how the current system happens to work. Existing system
   behavior is a common source of fake events." Extract requires the exact inverse — faithful
   as-is capture with no idealizing. These two stances are logical opposites; if both sit in
   always-loaded text, greenfield sessions risk importing extract's permissive as-is capture
   and extract sessions risk importing the anti-current-system filter that is precisely wrong
   when the existing system *is* the subject.
3. **`# TBD` parking is free.** `.em` comments (`# ...`, full-line or trailing) are native DSL
   syntax (em-dsl.md line 63) and stripped by the lexer (`src/parser/lexer.ts:4`,
   `src/parser/parser.ts:4`). No parser change is needed for `# TBD` comments.
4. **Frontmatter description is the trigger surface.** The current description names only
   greenfield activities; without extract language ("extract / reverse-engineer a model from an
   existing system or codebase") the skill will not fire for the target ask.
