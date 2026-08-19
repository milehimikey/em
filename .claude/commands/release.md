---
description: Release a new version of em — version bump, GitHub release + notes, npm publish via CI, Linear release
---

Release a new version of `em`. The human-readable version of this process lives in
docs/release.md; keep the two in sync if the process changes.

Optional argument: a target version (e.g. `1.8.0`) or bump kind (`patch`/`minor`/`major`).
If given, skip the version proposal in step 2 and use it. Arguments: $ARGUMENTS

## 1. Preflight — abort with a clear explanation if any of these fail

- On `main` with a clean working tree; `git pull` to be current with origin.
- Latest CI run on main is green: `gh run list --branch main --workflow CI --limit 1`.
- The Linear MCP is connected (the Linear steps below need it).

## 2. Determine scope and version

- Last release: `git describe --tags --abbrev=0`. Collect everything since:
  `git log <last-tag>..HEAD --oneline` and the merged PRs it references.
- Collect the Linear issues shipped in this range: the `MIL-*` ids in those
  commit/PR titles (they are the source of truth for the Linear step).
- If there is nothing to ship, say so and stop.
- Propose a semver bump — features → minor, fixes/docs only → patch, breaking
  DSL or CLI changes → major — and confirm the version with the user unless it
  was given as an argument.

## 3. Bump versions and run gates locally

- Set `version` in package.json (`npm version <x.y.z> --no-git-tag-version`).
- Update the `em-version:` stamp in `.claude/skills/event-modeling/SKILL.md` to
  match — CI's skill-version-stamp gate requires they agree.
- Regenerate skill docs and verify no drift: `npm run docs:generate` then
  `git diff --stat` to see what changed; include any regenerated files in the
  release commit.
- Run the gates: `npm run build && npm run typecheck && npm test`. Do not
  proceed past a failure.

## 4. Draft release notes and get approval

- Title format: `X.Y.Z: <short narrative theme>` (the established style, e.g.
  "1.7.0: the lifecycle & lineage release — slice docs become machine-read
  contracts"). Lowercase theme, names the release's through-line.
- Body: one short paragraph on the theme, then sections as applicable
  (Features / Fixes / Docs), each bullet referencing its PR number and `MIL-*`
  id. Write for a user of `em` deciding whether to upgrade, not a changelog robot.
- Write the notes to a scratch file and show them to the user for approval
  before shipping. Do not proceed without approval.

## 5. Ship

- Commit the version bump as `release: vX.Y.Z` directly to main and push.
- Create the GitHub release (this also creates the tag, which triggers the npm
  publish workflow):
  `gh release create vX.Y.Z --title "X.Y.Z: <theme>" --notes-file <scratch-file>`

## 6. Watch the publish

- Watch the Release workflow: `gh run watch` (or poll `gh run list --workflow Release`).
- If it fails, diagnose and fix before touching Linear — the release isn't real
  until npm has it. A failed run after a fix can be re-triggered by deleting and
  re-pushing the tag, or `gh run rerun`.
- Verify: `npm view @milehimikey/em version` returns the new version.

## 7. Update Linear

(Linear's Releases feature is Business-plan only; this workspace is on the free
plan, so releases are stamped onto the issues themselves.)

For every shipped issue from step 2:

- Attach the GitHub release as a link: `save_issue` with `links`:
  `[{url: <GitHub release URL>, title: "Shipped in vX.Y.Z"}]`.
- Confirm the issue is in state Done; flag any that aren't rather than
  silently closing them.

## 8. Report

Give the user: the GitHub release URL, the npm version confirmation, and the
list of Linear issues stamped. Note any shipped issues that weren't Done.
