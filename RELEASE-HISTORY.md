# PyKeko release history

One row per release. Tracks **dmg size** + the **headline feature** that landed.
For the full per-version changelog, see [`CLAUDE.md`](CLAUDE.md) or the
[GitHub Releases page](https://github.com/pykeko/Moorhen-PyKeko/releases).

To refresh sizes from the GitHub API (or after publishing a new release),
run [`tools/release-sizes.sh`](tools/release-sizes.sh) and paste its output here.

## Sizes & headline features

| Version | Date | dmg size | Δ prior | Δ vs v0.1 | Headline |
|---|---|---:|---:|---:|---|
| pk-v0.1   | 2026-05-25 | **176.48 MB** | — | — | First macOS Tahoe build — branded fork shipped end-to-end |
| pk-v0.2   | 2026-05-28 |   188.23 MB | +11.75 | +11.75 | CLI integration (`pykeko file.pdb`, fetch by PDB id, `.pml` scripts) + residue torsion editor |
| pk-v0.2.3 | 2026-06-02 |   226.63 MB | **+38.40** | +50.15 | MVS portable-viewer export (Mol\* runtime inlined into the bundled viewer template — this is where the size jumped) |
| pk-v0.2.4 | 2026-06-02 |   226.63 MB |  +0.00 | +50.15 | Camera-follow density in portable viewer (rolling-cube clip) + export skip-density dialog |
| pk-v0.2.5 | 2026-06-02 |   226.64 MB |  +0.01 | +50.16 | Shell-style history in Interactive Scripting modal (↑/↓ recall, Cmd+Enter submit) |
| pk-v0.2.6 | 2026-06-02 |   226.64 MB |  +0.00 | +50.16 | Regression fixes (density camera-follow restored, screenshot upscale restored, ligand CID parser fix) |
| pk-v0.2.7 | 2026-06-03 |   226.63 MB | −0.01 | +50.15 | Persistence fixes — static-server port pinned (welcome modal / scripting history actually persist). **SUPERSEDED: shipped with preload regression that broke `__moorhenControl`** |
| pk-v0.2.9 | 2026-06-03 |   226.63 MB |  +0.00 | +50.15 | Preload regression fix + upstream Moorhen bug-fix catchup (controls-lock release, modal default position, padded vector names, mmdb→gemmi output). **First build since v0.2.6 where every Electron-only menu item works** — including the session save/restore introduced in (the un-shipped) v0.2.8 |
| pk-v0.2.10 | 2026-06-03 |   226.63 MB |  +0.00 | +50.15 | `File → Open files…` rebuilt as a real clickable `MoorhenMenuItem` (previously an inert "Open Files" header next to an invisibly-styled Browse… button); `pykeko -h` / `--help` print a one-screen usage summary (launcher script intercepts `--help` because Chromium eats it before main.js sees it) |
| pk-v0.2.11 | 2026-06-04 |   226.63 MB |  +0.00 | +50.15 | PyMOL `color` command: dropped over-eager `cidsOverlap` gate so the inverse-push reaches reps whose CIDs cidChains regex couldnt read (full 4-seg CIDs, residue ranges, compound `||`-joined cids); added a one-line diagnostic in pykeko.log per color invocation |
| pk-v0.2.12 | 2026-06-04 |   226.63 MB |  +0.00 | +50.15 | `Ligand → New Ligand from SMILE…` gains a "Place at" dropdown (View centre / Nearest positive Fo-Fc peak) + an "Auto-fit to active map (jiggle + RSR)" toggle, both default-off. Together they reproduce Coot 0.9.x's "Fit ligand here" workflow as a single dialog. |

> **v0.2.8** was tagged briefly during the session save/restore work but never properly released — the preload regression from v0.2.7 was still present and the session-save menu items fell through to the legacy browser path. v0.2.9 is the first build where that feature actually works. See [`feedback_electron_preload_require_trap.md`](https://github.com/hilgersmt/notes-or-wherever) for the diagnosis (or this repo's `CLAUDE.md`).

## Growth read

- **+50 MB / +28% over 9 days** total (v0.1 → v0.2.9)
- One big jump (+38 MB at v0.2.3 — bundling the Mol\* viewer runtime); everything else essentially flat
- The TypeScript/React side of the bundle (`static/assets/index-*.js`, ~3.8 MB) absorbs new features almost for free — incremental cost per release has been ~10 KB
- Future jumps to watch: a coot-wasm rebuild that pulls newer upstream `libcootapi` could move the needle (the `MoorhenAssets/wasm/` blobs are ~30 MB), and disabling vite-plugin-pwa in v0.3.0 will shed ~1 MB of `sw.js` + workbox precache index

## What's inside (rough breakdown of pk-v0.2.9's 226.63 MB)

- **Electron framework** — ~70 MB compressed
- **WASM blobs** (`moorhen64.wasm` + `moorhen.wasm` + `gemmi*.wasm`) — ~50 MB compressed
- **Mol\* viewer template** (`Resources/dist/index.html` inlined runtime) — ~22 MB compressed
- **MathJax precache** — ~5 MB
- **Monomer library + RDKit data** (packed inside `data_tmp/data.tar`) — ~10 MB
- **App JS bundle** (`static/assets/index-*.js`) — ~1 MB compressed (the entire React UI + PyMOL translator + control bridge + everything else)
- **Misc** (icons, fonts, SW, manifest, etc.) — remainder
