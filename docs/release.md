# Releasing em

One release = one version everywhere: a `release: vX.Y.Z` commit on main, a git tag,
a GitHub release with narrative notes, the package on npm, and every shipped GitHub
issue stamped with the release that delivered it, its milestone closed. The `/release` command
(.claude/commands/release.md) drives the whole flow; this doc is the human-readable
record of it and of the one-time setup it depends on.

## The flow

1. **Preflight** — clean main, up to date, CI green.
2. **Scope + version** — everything since the last tag; semver bump (features →
   minor, fixes/docs → patch, breaking DSL/CLI changes → major).
3. **Bump** — `version` in package.json **and** the `em-version:` stamp in every
   `.claude/skills/event-modeling*/SKILL.md` (six files — the router skill plus the
   six focused phase skills; CI's skill-version-stamp gate requires all of them to
   agree with package.json); regenerate skill docs (`npm run docs:generate`, which
   also restamps the Claude Code plugin: `plugin/.claude-plugin/plugin.json`
   `version` and MCP pin, and the `.claude-plugin/marketplace.json` name
   `em-<version with dots as dashes>`); run build + typecheck + tests.
4. **Notes** — title `X.Y.Z: <short narrative theme>`; body: theme paragraph, then
   Features / Fixes / Docs bullets with PR numbers and `#n` issue references.
5. **Upgrading doc** — add this release's row to
   [docs/upgrading.md](upgrading.md): what changed for a model repo, and whether
   `em upgrade` handles it (a step id, a `human: <item>`, or "no action needed"),
   sourced from the same notes as step 4. Include it in the release commit.
6. **Ship** — commit `release: vX.Y.Z` to main, push, then
   `gh release create vX.Y.Z` with the notes. Creating the release creates the tag.
   The `vX.Y.Z` tag IS the plugin's marketplace pin: after the release exists, verify
   `claude plugin marketplace add milehimikey/em@vX.Y.Z` resolves (then remove the
   scratch registration). Never re-push a release tag; installs keep their cached
   copy while `plugin.json` `version` is unchanged.
7. **Publish** — the tag push triggers `.github/workflows/release.yml`, which
   verifies the tag matches package.json and runs `npm publish`. The existing
   `prepublishOnly` script (build + typecheck + test) gates the publish itself.
   Verify with `npm view @milehimikey/em version`.
8. **Stamp** — comment "Shipped in vX.Y.Z <release URL>" on every shipped GitHub
   issue, confirm each is closed (merged PRs with `Fixes #n` close them), and close
   the release's GitHub milestone. Anything on the milestone without a merged PR
   moves to the next milestone with a comment. (The tracker has been GitHub Issues
   since 2026-10-18; the Linear `MIL-*` workspace is a frozen read-only archive —
   historical `MIL-nnn` references still resolve there, nothing new is written.)

npm publishing is deliberately CI-only: no local `npm publish`, no token on any
laptop. If the workflow fails, the release isn't done — fix and re-run before
stamping issues.

## One-time setup

Done 2026-08-19, recorded for posterity: on npmjs.com, package `@milehimikey/em` →
Settings → Publishing access, a trusted publisher is configured for GitHub Actions,
repository `milehimikey/em`, workflow `release.yml`. This lets the workflow publish
via OIDC with no NPM_TOKEN secret (and gives packages provenance attestations for
free). If the package is ever renamed or the workflow file moves, this needs
re-configuring to match.

## Conventions

- Tag: `vX.Y.Z` (annotated via the GitHub release). Release title: `X.Y.Z: <theme>`
  — lowercase narrative theme naming the release's through-line, e.g.
  "1.7.0: the lifecycle & lineage release".
- The release commit is `release: vX.Y.Z` and contains only the version bumps and
  regenerated docs.
- Every shipped issue carries a "Shipped in vX.Y.Z" comment linking the GitHub
  release that delivered it, so an issue's page answers "when did this actually
  ship?", and the closed milestone answers it for the release as a whole.
- Issue conventions: labels `type:feature` / `type:improvement` / `bug`,
  `priority:high|medium|low`, `needs-ruling` for an owner decision pending,
  `was-linear` for issues migrated from the archive. One GitHub milestone per
  release; its description is a pointer, the pinned "X.Y.Z slate" issue (when one
  exists) is the slate of record.
