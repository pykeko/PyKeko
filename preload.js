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

// PyKeko wrapper version (read from package.json at preload time). Renderer
// reads this via window.__pykekoVersion to e.g. show the right number in the
// first-run welcome modal instead of a hardcoded stale string.
contextBridge.exposeInMainWorld("__pykekoVersion", require("./package.json").version);

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
});
