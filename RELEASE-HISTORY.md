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
| pk-v0.2.13 | 2026-06-04 |   227.65 MB |  **+1.02** | +51.17 | Portable viewer bumped to Mol\* 5.9.0 (was 4.18). dsehnal confirmed declarative MVS clip on volume representations shipped in Mol\* 5; clean dep-only bump with no source changes. Inlined viewer HTML grew ~45 KB gzip. Camera-follow density clip in App.tsx still imperative (Mol\* did not add declarative camera-follow). |
| pk-v0.2.14 | 2026-06-04 |   227.65 MB |  +0.00 | +51.17 | **Hotfix.** v0.2.12 introduced a double-negation in the SMILES→ligand placement code: `placement` was set in world coords then negated again before passing to Coot, so the ligand landed at the mirror across (0,0,0) — miles from any density. Peak path silently fell back to view-centre on no-diff-map → both options produced the same wrong spot, and auto-fit's jiggle radius was way smaller than the protein-to-mirror distance. Fix: pass world coords directly. |
| pk-v0.2.15 | 2026-06-04 |   227.65 MB |  +0.00 | +51.17 | **SMILES placement, take 2.** v0.2.14 fixed double-neg but "View centre" = camera rotation centre isn't on the protein on fresh loads. New default "Active molecule centre" uses the protein's atom centroid. Caught a second mirror-bug while testing: `centreOnGemmiAtoms` returns the **negated** centroid (its name lies; it's meant for `setOrigin`). Also: "two ligands stacked" on merge-into-molecule (standalone was hidden but not deleted) — standalone now fully disposed. View auto-recentres on the placement target. |
| pk-v0.2.16 | 2026-06-05 |   228.65 MB |  +1.00 | +52.17 | Per dsehnal's comments on molstar/molstar#1844, declarative camera-follow clip won't happen at the MVS layer — the throttled-mutation pattern `wireCameraFollowDensity` uses is the maintainer-endorsed approach. The STATIC initial clip CAN move to MVS though (`representation.clip({type: sphere, center, radius, invert, variant: pixel})` shipped in Mol* 5.0). MvsExportBuilder now emits it. Recipient .html viewer-template behaviour unchanged (seed call still re-anchors to recipient camera), but the file is more self-describing for non-PyKeko MVS viewers. `App.tsx` header rewritten to cite the dsehnal architecture endorsement so the next reader doesn't question the design. |
| pk-v0.2.17 | 2026-06-05 |   228.65 MB |  +0.00 | +52.17 | MVS portable-viewer export: PyMOL `lines` now exports as visibly-thinner geometry rather than identical-thickness `sticks`. The in-app translator distinguishes them only via `bondOptions.width` (0.03 vs 0.10); the exporter now threads that through and emits MVS `ball_and_stick.size_factor` = width / 0.10. |
| pk-v0.2.18 | 2026-06-05 |   151.00 MB | **−75.00** (−33%) | **−24.00** | **Coot WASM patch + dmg slim-down.** PyMOL color commands had no visible effect on bond/stick reps; root cause was a Coot WASM CID-selector bug (set_user_defined_atom_colour_by_selection ignored its CID argument and always coloured the same chain) AND upstream Moorhen never called set_use_bespoke_carbon_atom_colour. Patch coot-patches/coot-molecule-bonds-userdef-color-cid-fix.patch bypasses mmdb's broken Select for whole-chain CIDs, walks model manually. JS-side: bespoke toggle in getCootSelectionBondBuffers, dedupe-then-append in cmdColor. Separate: forge.config.js gained an ignore pattern excluding viewer-template/node_modules, .attic, out — was bundling them into Resources/app/ before. **Net dmg size: 226.63 → 151.00 MB**, a 33% reduction. |

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
