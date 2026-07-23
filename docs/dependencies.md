# Dependencies & rendering

`em` aims to "just work" after `npm install` — no system packages for the common path.

## What's bundled (no system install)

- **Graphviz layout** — [`@hpcc-js/wasm-graphviz`](https://www.npmjs.com/package/@hpcc-js/wasm-graphviz),
  the Graphviz engine compiled to WebAssembly. It runs in-process; `em` feeds it the
  generated DOT and gets back the grid SVG (same output as a system `dot -Tsvg`). No
  `graphviz`/`dot` on your PATH is required.
- **PNG rasterization** — [`@resvg/resvg-js`](https://www.npmjs.com/package/@resvg/resvg-js),
  a Rust SVG renderer with prebuilt native binaries shipped as platform-specific optional
  dependencies (npm installs only the one matching your OS/arch). No `librsvg` required for
  PNG.

These are regular `dependencies`, so a global install pulls them automatically.

## Optional: PDF and other formats

PDF (and other Graphviz raster/vector formats) are **not** bundled. If you ask for one
(`-o diagram.pdf` / `-T pdf`), `em` shells out to a system **`rsvg-convert`** (librsvg) if it
finds one, otherwise it errors and tells you SVG/PNG are built in.

Install librsvg only if you need PDF:

| Platform | Command |
|---|---|
| macOS (Homebrew) | `brew install librsvg` |
| Debian/Ubuntu | `sudo apt install librsvg2-bin` |
| Fedora | `sudo dnf install librsvg2-tools` |
| Arch | `sudo pacman -S librsvg` |

Override the binary name/path with the `EM_RSVG` environment variable if needed.

For how a render flows through these pieces, and why Graphviz lays out the grid while `em`
draws the arrows itself, see [architecture.md](architecture.md).
