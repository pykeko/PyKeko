// PyKeko preload — runs before page scripts in an isolated world.
//
// 1) Force 32-bit WASM: the 64-bit Coot module init hangs intermittently in Electron
//    (createCoot64Module deadlocks in the worker). The renderer loader and
//    MoorhenCommandCentre read window.MOORHEN_FORCE_32BIT; the latter appends
//    ?force32=1 to the CootWorker URL so the worker (separate context) honors it too.
//    The browser build has no preload, so it keeps 64-bit.
//
// 2) Control channel for PyKekoMCP: expose window.__moorhenControl so the in-page
//    MoorhenControlBridge can receive invoke messages from the Electron main process
//    (which fronts the local HTTP control server) and return results — over IPC,
//    keeping contextIsolation on (no nodeIntegration in the renderer).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("MOORHEN_FORCE_32BIT", true);

// PyKeko wrapper version. Renderer reads this via window.__pykekoVersion to
// surface the right number in the first-run welcome modal.
//
// THIS COMMENT IS A LANDMINE WARNING. v0.2.7 and v0.2.8 both shipped with
// this section silently broken in the packaged app. Two earlier approaches
// that LOOK correct but DON'T work in Electron 38.x:
//   1) `require("./package.json").version` — Electron's preload `require()`
//      is restricted to the "electron" module ONLY, even with sandbox:false
//      set. Both `require("./package.json")` and `require("fs")` throw
//      "module not found". Any throw inside preload kills every subsequent
//      `contextBridge.exposeInMainWorld(...)` call — including
//      __moorhenControl, on which the in-page UI's lifeline depends.
//   2) `webPreferences.additionalArguments` from main.js + read from
//      process.argv. Per Electron docs this should round-trip, but
//      Chromium's switch-filter drops the arguments regardless of shape
//      (--key=value, plain token, colon-prefixed). Doesn't reach the
//      renderer's process.argv at all in Electron 38.x.
// What works: synchronous IPC. main.js registers an `ipcMain.on(...)` for
// "pykeko:get-version" at module load (before createWindow), and answers
// via event.returnValue. Preload's sendSync returns it synchronously.
let __pykekoVersion = "";
try { __pykekoVersion = ipcRenderer.sendSync("pykeko:get-version") || ""; }
catch (e) { console.warn("preload: pykeko:get-version sendSync failed:", e && e.message); }
contextBridge.exposeInMainWorld("__pykekoVersion", __pykekoVersion);

contextBridge.exposeInMainWorld("__moorhenControl", {
  onInvoke: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on("moorhen-control:invoke", handler);
    return () => ipcRenderer.removeListener("moorhen-control:invoke", handler);
  },
  sendResult: (res) => ipcRenderer.send("moorhen-control:result", res),
  ready: (verbs) => ipcRenderer.send("moorhen-control:ready", verbs),
  // Renderer -> main: show a native OS open dialog rooted at the working directory
  // and load the chosen files (the File menu's "Open Files" uses this under Electron,
  // since a browser <input type=file> can't set a starting directory).
  openFiles: () => ipcRenderer.invoke("pykeko:open-files"),
  // Renderer -> main: install / check the `pykeko` command-line launcher in
  // /usr/local/bin (VS Code-style). installCliLauncher prompts for admin once.
  installCliLauncher: () => ipcRenderer.invoke("pykeko:install-cli"),
  cliLauncherStatus: () => ipcRenderer.invoke("pykeko:cli-status"),
  // Renderer -> main: show a native Save panel (defaults to the launch dir) and
  // write a PNG data URL to disk. Used by high-res screenshot export + `ray`/`png`.
  saveImage: (dataUrl, suggestedName) => ipcRenderer.invoke("pykeko:save-image", { dataUrl, suggestedName }),
  // Renderer -> main: take an MVS JSON document, inject into the prebuilt Mol*
  // viewer template, and save a single self-contained .html via the Save panel.
  exportMvsViewer: (mvsJson, suggestedName) => ipcRenderer.invoke("pykeko:export-mvs-viewer", { mvsJson, suggestedName }),
  // Renderer -> main: write one or more files to disk via the Save panel.
  // files: [{ name, dataBase64 }] — first is primary (its name suggests the dialog
  // default; user-chosen path is honoured for it). Siblings go in the chosen
  // directory under their original names. Used by PyMOL `save` (single .pdb/.cif
  // or a .pml bundle with sibling structure/map files).
  saveBundle: (suggestedName, files) => ipcRenderer.invoke("pykeko:save-bundle", { suggestedName, files }),
  // Renderer -> main: Save full Moorhen session (.pykeko file) via native
  // Save panel. `bytes` is a Uint8Array of the protobuf-encoded session.
  // Returns { ok, path } | { canceled } | { ok: false, error }.
  saveSession: (bytes, suggestedName) => ipcRenderer.invoke("pykeko:save-session", { bytes, suggestedName }),
  // Renderer -> main: Open a .pykeko / .pb session file via native Open panel.
  // Returns { ok, path, bytes: Uint8Array } | { canceled } | { ok: false, error }.
  openSession: () => ipcRenderer.invoke("pykeko:open-session"),
});
