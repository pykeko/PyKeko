# Claude context — `pykeko/PyKeko`

This is the **Electron wrapper repo** for PyKeko, the user's branded desktop app around Moorhen (a Coot-based molecular graphics web app). Named after the pūkeko (NZ swamphen).

## Repo family (all under github.com/pykeko)

| Repo | Purpose | Local clone |
| --- | --- | --- |
| **PyKeko** (this) | Electron wrapper that produces `PyKeko.app` / `PyKeko.dmg` | `~/PyKeko` |
| [PyKekoMCP](https://github.com/pykeko/PyKekoMCP) | MCP server for Claude to drive a running PyKeko | `~/PyKekoMCP` |
| [Moorhen-PyKeko](https://github.com/pykeko/Moorhen-PyKeko) | Fork of upstream `moorhen-coot/Moorhen` with PyKeko customizations | `~/Moorhen` (prod), `~/Moorhen-dev` (dev) |

## Build

```bash
npm install
npm run package         # builds out/PyKeko-darwin-arm64/PyKeko.app (dist, self-contained)
npm run package:dev     # builds out/PyKekoDev-darwin-arm64/PyKekoDev.app (vite live, port 5174)
npm run make            # produces out/make/PyKeko.dmg (dist variant)
```

The dist variant's prePackage hook runs a full vite build of `~/Moorhen/baby-gru` into `static/`, then bundles that into the .app.

Install path:
```bash
xattr -rc out/PyKeko-darwin-arm64/PyKeko.app
rm -rf /Applications/PyKeko.app  # if reinstalling
cp -R out/PyKeko-darwin-arm64/PyKeko.app /Applications/
```

## Naming conventions

- **Prose / display / UI**: `PyKeko`
- **Filesystem / binaries / package names**: `pykeko`
- **Never**: `PyKEKO`
- Default branch: `main` (the `dist-variant` branch was deleted after fast-forward — don't recreate it)

## Wire-protocol identifiers — DO NOT RENAME

These flow between PyKeko (wrapper), PyKekoMCP, and the in-page bridge inside Moorhen-PyKeko. Renaming any of them breaks the control channel:

- IPC channels: `moorhen-control:invoke`, `moorhen-control:result`, `moorhen-control:ready`
- Control file dir: `~/.moorhen-mcp/control-<port>.json`
- Env vars: `MOORHEN_DIR`, `MOORHEN_VARIANT`, `MOORHEN_VITE_PORT`, `MOORHEN_TITLE`, `MOORHEN_LOG_PATH`
- Bridge identifiers: `MoorhenControlBridge`, `window.MoorhenControlApi`, `__moorhenControl`
- MCP tool names: all `moorhen_*`
- Source filenames inside `Moorhen-PyKeko/baby-gru/`: `MoorhenAssets/`, `MoorhenSession.*`, `MoorhenFileLoading.ts`, etc.
- Local clone dirs: `~/Moorhen`, `~/Moorhen-dev` (deliberately kept — too many hard-coded paths to be worth renaming)

If you need to "rebrand" further, change titles, READMEs, app names, package names — never the above.

## Current state (as of pk-v0.2.10, 2026-06-03)

- Version: `0.2.10` in `package.json`, `CFBundleShortVersionString` derived from it
- Release: pk-v0.2.10 on Moorhen-PyKeko (canonical, asset: `PyKeko.dmg`). The wrapper repo carries a matching `pk-v0.2.10` tag and a mirror release with the same dmg. The org page's download badge and install link point at the Moorhen-PyKeko release (historical convention since v0.1). When shipping a new version: build the dmg in `~/PyKeko` via `npm run make`, create a release on **Moorhen-PyKeko first** with the dmg + `--latest`, then mirror to PyKeko. Update `RELEASE-HISTORY.md` (use `tools/release-sizes.sh v0.2.X` for the new row).
  - 0.2.10 fixes:
    - **File → Open files… now actually clickable.** v0.2.7 → v0.2.9 rendered an inert "Open Files" header span next to a Browse… button styled with `background: transparent, border: none, padding: 0` — visually identical to plain text, so users were trying to click the (non-clickable) header. Replaced with a single `MoorhenMenuItem` row for the desktop branch — one obvious click target like every other File-menu item. Browser build is unchanged.
    - **`pykeko --help` and `pykeko -h`** now print a one-screen usage summary. `--help` is intercepted by Chromium when it reaches the Electron binary (Chromium prints its own huge irrelevant help and ignores our main.js), so the CLI launcher script now handles both flags itself before exec'ing. `-h` is also caught in `main.js` so users on the old launcher get a working `pykeko -h` automatically; `--help` requires reinstalling the launcher via Preferences → Install command-line launcher.
  - 0.2.9 fixes: **Critical preload regression** introduced in v0.2.7 — the entire `__moorhenControl` IPC bridge was broken in v0.2.7 and v0.2.8 packaged builds. Root cause: the line `require("./package.json").version` (added in v0.2.7 to expose `window.__pykekoVersion` for the welcome modal) silently throws `Error: module not found` in the packaged Electron app. Electron's preload `require()` is restricted to the `"electron"` module ONLY — even with `webPreferences.sandbox: false` set. The throw aborted every subsequent `contextBridge.exposeInMainWorld(...)` call, taking `__moorhenControl` (and everything that depends on it: install-CLI, save-image, export-MVS-viewer, save-bundle, save-session, open-session) with it. Symptoms: the welcome-modal version fix never worked (still showed `HINT_VERSION`); **v0.2.8's File → Session menu showed the legacy textbox + in-browser-backup items instead of the new Save/Open session items** because `isDesktopWithSessionIpc()` saw `__moorhenControl` as undefined and fell through to the browser branch; all other Electron-only menu items would have silently degraded similarly. Tried `webPreferences.additionalArguments` (Chromium silently drops them in Electron 38 regardless of token shape — `--key=value`, plain, colon-prefixed all filtered) before landing on the working pattern: **`ipcRenderer.sendSync("pykeko:get-version")` from preload, answered by an `ipcMain.on(...)` handler registered in main.js at module load** (must be registered BEFORE `createWindow` because preload sendSync fires before any other init). Diagnosed remotely via Chrome DevTools Protocol (Electron `--remote-debugging-port=9222` + `--remote-allow-origins=*`); `/tmp/pykeko.log` was the smoking gun: `Unable to load preload script` + `Error: module not found: ./package.json`.
  - 0.2.9 also adds: **Upstream Moorhen bug-fix catchup.** First upstream sync since v0.1 (2026-05-25; upstream was 17 commits ahead, ~5 days of activity). Cherry-picked the four pure-bug-fix commits — left XPID feature work and the latest Coot WASM hash bump (would force a WASM rebuild) for a later, deliberate sync.
    - Controls-lock release bug (upstream `f4307fe9`, `cdegut`): under some accept/reject flows, the camera-control lock didn't release, leaving the user "frozen" until the next click.
    - Better DraggableModalBase default position (upstream `f8b9b680`, `clement`): non-zero `top` so a freshly-opened modal isn't clipped against the menu bar.
    - mmdb → gemmi conversion at file output (upstream `a99ae752`, `Clement Degut`): WASM-side fix; takes effect on the next coot-wasm rebuild, otherwise inert (we ship a pre-built blob — see `reference_pykeko_wasm_build.md`).
    - Padded vector-name backward-compat (upstream `318454e7`, `Stuart McNicholas`): vectors saved by old Moorhen-status files with padded chain names now reload correctly. Directly relevant since v0.2.8 just shipped real session save/restore.
- [pk-v0.2.8](https://github.com/pykeko/Moorhen-PyKeko/releases/tag/pk-v0.2.8) (2026-06-03): **Real desktop session save/restore** — `File → Save session…` opens a native macOS Save panel and writes a `.pykeko` file (protobuf-encoded full scene: molecules, maps, per-rep colour rules, camera, vectors, 2D overlays, view settings). `File → Open session…` does the inverse with a native Open panel. `.pykeko` files also drag-drop onto the canvas. Browser build keeps the old behaviour (browser-download + in-browser IndexedDB backups). The legacy "Save Session File:" textbox row + in-browser-backup items are hidden in the desktop build — they made sense when there was no filesystem access, redundant when there is. Session also captures a new optional `PyKekoUiState` block (scripting modal mode, welcome-hint seen flag) for future continuity work. Known limitation: hidden reps are still filtered out at save time (`fetchSession` does `.filter(item => item.visible)`); fixing requires the restore path to gracefully re-add hidden reps — deferred.
- [pk-v0.2.7](https://github.com/pykeko/Moorhen-PyKeko/releases/tag/pk-v0.2.7) (2026-06-02): persistence/UI fixes:
    - **localStorage was wiped every launch** because `main.js`'s static server bound to port 0 (OS-assigned), giving the renderer a different origin (`http://127.0.0.1:<random>/`) on each start. Browser localStorage is per-origin, so the welcome-modal "seen" flag, the scripting history, and any other in-page persisted state evaporated on restart. Pinned to port 51823 (falls back to OS-assigned only if that's busy — persistence is lost just for that session). **Result**: welcome modal stays dismissed; scripting history actually persists.
    - **Welcome modal title showed stale "Welcome to PyKeko 0.2.0"** even on fresh installs of newer versions. The hint version (used for re-prompt logic) and the displayed version were the same hardcoded constant. Split them: preload now exposes `window.__pykekoVersion` from package.json; the modal reads the actual app version while keeping HINT_VERSION semantic ("which welcome content has been dismissed") so bug-fix releases don't re-prompt.
- [pk-v0.2.6](https://github.com/pykeko/Moorhen-PyKeko/releases/tag/pk-v0.2.6) (2026-06-02): regression-fix release —
    - **Restored: screenshot upscaling** (File → Screenshot's 1x/2x/Max(≈4096) presets + high-quality AO+shadows toggle). The commit landed on `main` in May (`6efac6d2`) but was never back-ported to the `ncs-ghosts` working branch, so v0.2.3/0.2.4/0.2.5 builds shipped without it. Now cherry-picked into ncs-ghosts so future builds include it.
    - **Fixed: ligand-by-residue-name rep CIDs** — the MVS export's CID parser dropped wildcard-form selectors like `/*/*/(ABM)/*` (Moorhen's "spheres on residue ABM") to `null`, which then fell back to `"all"`, silently scoping a single-ligand spheres rep to every atom in the scene (this is why exports looked like "all spheres" when the live view had cartoon + ligand-spheres). Parser now handles 4-segment wildcard CIDs and `(RESN)` residue-name → `auth_comp_id` selector. Unparseable CIDs now drop the rep with a console warning instead of broadening to "all".
    - **Fixed: density camera-follow clip** — the sphere clip on volume isosurfaces was double-bugged: (1) `invert: false` meant Mol\* discarded pixels INSIDE the sphere (a cutaway hole) instead of keeping them — opposite of intent; (2) Mol\*'s sphere SDF internally scales by 0.5, so a `scale=[20,20,20]` clip was actually a 10 Å sphere not 20 Å. Now `invert: true` + diameter passed to scale → density correctly clips to a 20 Å radius sphere that follows the camera, matching Coot's rolling-cube behaviour.
- [pk-v0.2.5](https://github.com/pykeko/Moorhen-PyKeko/releases/tag/pk-v0.2.5) (2026-06-02): **Shell-style history in Interactive Scripting** — the Calculate → Interactive scripting (.../PyMOL/JavaScript) modal now keeps per-mode history. ↑ at the top of the textarea recalls the previous command; ↓ at the bottom restores forward (or the in-progress draft you had typed before diving into history). Cursor-position-aware so ↑/↓ still move the caret line-by-line inside multi-line scripts. Cmd/Ctrl+Enter submits without reaching for the Play button. History persists across reloads via localStorage (~200 entries per mode, dedupes consecutive duplicates).
- [pk-v0.2.4](https://github.com/pykeko/Moorhen-PyKeko/releases/tag/pk-v0.2.4) (2026-06-02):
    - **Camera-follow density** in the portable viewer — embedded volume isosurfaces now get a sphere clip that follows the camera target (~20 Å radius, throttled to 80 ms), so density tracks the user's view like Coot's "rolling cube". Implemented via Mol\*'s `clip` renderable on `VolumeRepresentation3D` (GPU uniform, no re-mesh on update). Embedded cube bumped from 20 Å → 40 Å half-side to give wander room before the user pans past the loaded data; file size grows ~8× per map (~250 KB → ~2 MB) for the larger embedded region.
    - **Export confirmation dialog** — when the scene has visible maps, the File → Export portable viewer (.html) menu now pops a confirm with an "Include density map(s)" checkbox and file-size estimate. Default keeps maps; unchecking ships a much smaller structures-only HTML (typically ~10× shrink).
    - **PML bundle export stubbed** — File → Save as PyMOL bundle (.pml) was a "complete disaster" per user; menu item hidden but `MoorhenPymolSaveBundle.ts` and the `pykeko:save-bundle` IPC handler stay in tree for revival.
    - **Upstream filed**: [molstar/molstar#1844](https://github.com/molstar/molstar/issues/1844) asking for MVS `clip` on `volume_representation` so this could become declarative instead of post-load state-tree manipulation.
- [pk-v0.2.3](https://github.com/pykeko/Moorhen-PyKeko/releases/tag/pk-v0.2.3) (2026-06-02): **MVS portable-viewer export overhaul** — File → Export portable viewer (.html) honors the actual visible Moorhen representations (CBs/CRs/MolecularSurface/VdwSpheres/glycoBlocks/ligands/etc., mapped to MVS rep types), uses the molecule's real Coot colour rules instead of a fixed palette, preserves CPK heteroatom colours (N=blue, O=red, S=yellow, …) when a rule has `applyColourToNonCarbonAtoms=false`, parses CID-style selectors (`/mdl/chain`, residue ranges) into MVS selectors. The viewer template also got a face-lift: left panel starts collapsed (icon column only), "Remote States" snapshot list removed, left-panel actions filtered to just Open Files, and a new floating chevron button (top-right of canvas) toggles the right Structure Tools panel.
- [pk-v0.2](https://github.com/pykeko/Moorhen-PyKeko/releases/tag/pk-v0.2) (2026-05-28): added CLI launch+load (`.cif`→dictionary attach, `pykeko 7sj3`, `.pml`), single-instance file handoff + `--new`, `remote/pykeko_remote.py` (PyMOL-`-R`-style client), Preferences → "Install command-line launcher" + first-run hint, residue **Edit torsions** panel (local φ/ψ + χ + live Ramachandran), black bg / hydrogens-by-default / PyMOL-default scripting.
- [pk-v0.1](https://github.com/pykeko/Moorhen-PyKeko/releases/tag/pk-v0.1) (2026-05-25): first rebranded release.
- Build/release: `PATH=/opt/homebrew/bin:$PATH npm run make` (Homebrew node 26; the vite dist build is a few minutes). Smoke-test the built app by installing over `/Applications/PyKeko.app` and launching with `--new` — and **don't leave PyKekoDev running**, two coot pthread instances contend at worker-init and the second hangs on "Moorhen is loading…" (not a bug; see project memory).
- Icons: `PyKeko.icns` (multi-resolution, used by electron-forge), `PyKeko_icon.png` (rounded-square with dark-corner mask, source for the `.icns` — intended for OS app-icon clip), `PyKeko_avatar.png` (flat-square 5%-crop of the icon — used for the GH org avatar, repo social previews, and README `<img>` embeds), `PyKeko_logo.png` (transparent, for UI embedding)

## Pending follow-ups

- [ ] Delete obsolete GitHub repos (the pre-rename originals — `gh repo list hilgersmt` and look for repos *not* in the table above; plus `strava-analytics`). Needs `gh auth refresh -h github.com -s delete_repo` first.
- [ ] Pin the [install gist](https://gist.github.com/hilgersmt/797821d1fb70599b21fd31159b346a95) on the GitHub profile (web UI; the 4 current pins have 2 slots free)
- [ ] Upload `PyKeko_avatar.png` as social-preview image for each of the 3 pykeko org repos (web UI per repo's Settings page — not API-accessible). Org avatar (`pykeko/settings/profile`) uses the same file.

## Where to look

- `forge.config.js` — variant definitions, packagerConfig.icon, makers
- `main.js` — Electron lifecycle, vite spawn (dev) or static server (dist), control server
- `preload.js` — forces 32-bit WASM, exposes `__moorhenControl` to in-page
- `RELEASE-HISTORY.md` — one-row-per-release log: date, dmg size, size deltas, headline feature. Append a new row after every release. Use `tools/release-sizes.sh` (or `tools/release-sizes.sh v0.2.10` for a single version) to pull current sizes from the GitHub API and emit a ready-to-paste markdown row — you just fill in the headline.
