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

## Current state (as of pk-v0.2.4, 2026-06-02)

- Version: `0.2.4` in `package.json`, `CFBundleShortVersionString` derived from it
- Release: [pk-v0.2.4](https://github.com/pykeko/Moorhen-PyKeko/releases/tag/pk-v0.2.4) on Moorhen-PyKeko, asset: `PyKeko.dmg`. The wrapper carries a matching `pk-v0.2.4` tag.
  - 0.2.4 adds:
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
