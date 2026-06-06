<p align="center">
  <img src="PyKeko_avatar.png" alt="PyKeko" width="160" height="160" />
</p>

<h1 align="center">PyKeko</h1>

<p align="center">
  The <strong>Electron desktop wrapper</strong> for <a href="https://github.com/pykeko/Moorhen-PyKeko">Moorhen-PyKeko</a> — packages the web app into a native macOS <code>.app</code> / <code>.dmg</code>, serves the bundle, and runs the control server that lets external tools drive it.
</p>

> 🐦 **Part of the [PyKeko project](https://github.com/pykeko)** — see the org page for what PyKeko is, the Coot→Moorhen→PyKeko heritage, and install instructions. This README covers the **wrapper's internals**.

---

## Variants

Two desktop apps build from this single repo:

| App | Build command | Source | Port | Notes |
| --- | --- | --- | --- | --- |
| **PyKeko** | `npm run package` (or `npm run make` for DMG) | Bundled static dist (inside the .app) | dynamic | Self-contained — no vite/node/emsdk required at runtime. Redistributable. |
| **PyKeko Dev** | `npm run package:dev` | `~/Moorhen-dev/baby-gru/` | 5174 | Live vite dev server, devtools auto-open. |

The selected variant is baked into `variant.json` at package time (see `forge.config.js`) so the packaged, double-clickable app self-describes its target tree/port.

## How it works

A thin Electron wrapper that:

1. **dev variant**: starts a vite dev server invisibly in the background (from `~/Moorhen-dev/baby-gru/`) and opens an Electron window pointed at `http://localhost:5174/`.
2. **dist variant**: serves a pre-built static bundle from inside the .app via an in-process HTTP server (no vite, no node dependencies at runtime).
3. Forces 32-bit WASM mode (more reliable in Electron's renderer).
4. Sets COEP/COOP headers for SharedArrayBuffer.
5. Runs a token-authenticated HTTP control server on `127.0.0.1:<random>` and writes `{port, token, vitePort}` to `~/.moorhen-mcp/control-<vitePort>.json` — that's what [PyKekoMCP](https://github.com/pykeko/PyKekoMCP) connects to so Claude can drive the running app.
6. Kills vite (dev variant) or the static server (dist variant) when the window closes.

On first launch of the dev variant, it runs the baby-gru codegen steps if their outputs are missing (`create-version`, `transpile-ts-worker`, `transpile-protobuf`, `transpile-graphql-codegen`). The `transpile-ts-worker` step builds `public/MoorhenAssets/wasm/CootWorker.js` — without it the Coot command worker can't load (the request falls back to vite's HTML, throwing `Unexpected token '<'`).

## Requirements

**Dev variant only:**
- Moorhen source tree at `~/Moorhen-dev/baby-gru/` (clone of [pykeko/Moorhen-PyKeko](https://github.com/pykeko/Moorhen-PyKeko))
- Node.js 20+ via Homebrew (`/opt/homebrew/bin`); vite 7 requires it, and anaconda/CCP4 node on `PATH` will break the build
- Built WASM artifacts in `~/Moorhen-dev/baby-gru/public/MoorhenAssets/wasm/`

**Dist variant:** none at runtime. At build time the dist build runs codegen + vite build against `~/Moorhen/baby-gru/`, then bundles the result.

## Build & install

**Dist (default — self-contained .app):**

```bash
npm install
npm run package
xattr -rc out/PyKeko-darwin-arm64/PyKeko.app
cp -r out/PyKeko-darwin-arm64/PyKeko.app /Applications/
```

**Dist as a DMG:**

```bash
npm run make
# Output: out/make/PyKeko.dmg
```

**Dev:**

```bash
npm run package:dev
xattr -rc out/PyKekoDev-darwin-arm64/PyKekoDev.app
cp -r out/PyKekoDev-darwin-arm64/PyKekoDev.app /Applications/
```

> The `xattr -rc` step above strips all extended attributes from the freshly
> built `.app` before copying, so a locally-built install doesn't pick up a
> quarantine flag. If you installed via the dmg (mount + drag in Finder) and
> macOS still blocks the app on first launch, strip quarantine on the
> installed copy instead:
> ```bash
> xattr -dr com.apple.quarantine /Applications/PyKeko.app
> ```
> See [`docs/install-mac.md`](https://github.com/pykeko/Moorhen-PyKeko/blob/main/docs/install-mac.md) for the full end-user install story.

## Run

Launch from `/Applications/PyKeko.app` or `/Applications/PyKekoDev.app`, or for unpackaged runs:

```bash
npm start                            # dist (default)
MOORHEN_VARIANT=dev npm start        # dev
```

Runtime overrides (unpackaged only): `MOORHEN_DIR`, `MOORHEN_VITE_PORT`, `MOORHEN_TITLE`, `MOORHEN_LOG_PATH`.

## Debugging

Log files:
- `PyKeko`: `/tmp/pykeko.log`
- `PyKeko Dev`: `/tmp/pykeko-dev.log`

DevTools auto-open in the dev variant. For the dist variant, set `VARIANT.devTools = true` in `forge.config.js` and rebuild.

## Icons

The PyKeko app icon (multi-resolution macOS `.icns`) lives at `PyKeko.icns` and is referenced by `forge.config.js → packagerConfig.icon`, so all packaged builds inherit it.

| Asset | Use |
| --- | --- |
| `PyKeko.icns` | macOS app icon (16–1024 px) |
| `PyKeko_icon.png` | Rounded-square branded icon, dark-corner mask (source for `.icns`; designed for the OS app-icon clip) |
| `PyKeko_avatar.png` | Flat square (5%-cropped from icon) — GitHub avatar, social previews, README embeds |
| `PyKeko_logo.png` | Transparent-background logo (for embedding in UIs / docs) |
