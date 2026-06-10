# Publishing to npm

The package is configured to publish as **`@milehimikey/em`** (scoped, public; the CLI bin
stays `em`). This is the release checklist — **nothing here has been run yet.**

## Already configured (in `package.json`)

- `name`: `@milehimikey/em`, `bin.em` → `dist/cli.js` (with `#!/usr/bin/env node` shebang).
- `publishConfig.access`: `public` (scoped packages are private by default).
- `files`: `["dist", "README.md", "LICENSE"]` — only built output ships (not `src/`,
  `test/`, `examples/`).
- `prepublishOnly`: `npm run build && npm test` — build + tests gate every publish.
- `engines.node`: `>=18`; `license`: `MIT`; `repository`/`bugs`/`homepage`/`keywords` set.
- Runtime deps (`@hpcc-js/wasm-graphviz`, `@resvg/resvg-js`, `commander`, `chokidar`) are in
  `dependencies`; the WASM/native pieces install with the package.

## Pre-flight

1. Bump `version` (semver) — start `0.1.0` or `1.0.0` for the first public release.
2. `npm run build && npm test` — green.
3. `npm pack --dry-run` — confirm the tarball contains only `dist/`, `README.md`, `LICENSE`
   (and `package.json`). Nothing from `src/`/`test/`/`examples/`/`node_modules/`.
4. Optional smoke test of the packed artifact:
   ```bash
   npm pack                       # creates milehimikey-em-<version>.tgz
   npm install -g ./milehimikey-em-*.tgz
   em render examples/order-fulfillment.em -o /tmp/smoke.svg
   ```
   Verify on a machine **without** system graphviz/librsvg that SVG and PNG render.

## Publish

```bash
npm login                        # once, as the owner of the @milehimikey scope
npm publish --access public      # publishConfig also enforces public
```

## Post-publish

- `npm view @milehimikey/em version` and `npx @milehimikey/em@latest render examples/order-fulfillment.em`.
- Tag the release in git (`git tag vX.Y.Z && git push --tags`) and draft GitHub release notes.

## Notes / decisions to revisit before 1.0

- **Package size** — `@resvg/resvg-js` adds a platform-specific native binary and the WASM
  Graphviz adds a few MB. Acceptable for a CLI; document if it surprises anyone.
- **Unscoped name** — `em` and `em-cli` are taken on npm. If an unscoped name is wanted
  later, verify availability and update `name` (the bin can stay `em`).
- **Dev-only audit** — a `vitest`/`vite` advisory shows in `npm audit`; it's a
  devDependency (not shipped). Bump `vitest` when convenient.
