const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");

// Force SharedArrayBuffer unconditionally — required by Coot's pthread WASM worker.
// Chromium otherwise gates SAB behind `crossOriginIsolated`, which the live-vite dev
// variant doesn't achieve on first load (COEP/COOP take full effect only after a
// reload, even though vite serves the headers correctly). This switch decouples SAB
// from isolation, so the worker initializes on first launch in both prod and dev.
app.commandLine.appendSwitch("enable-features", "SharedArrayBuffer");

// Variant config is baked into variant.json at package time (see forge.config.js)
// and overridable via env vars for unpackaged `npm start` / `electron .` runs.
// Defaults are the dist values.
function loadVariant() {
  try { return require(path.join(__dirname, "variant.json")); } catch (e) { return {}; }
}
const VARIANT = loadVariant();
const MOORHEN_DIR = process.env.MOORHEN_DIR
  || path.join(os.homedir(), VARIANT.moorhenSubdir || "Moorhen/baby-gru");
const LOG_PATH = process.env.MOORHEN_LOG_PATH || VARIANT.logPath || "/tmp/pykeko.log";
const WINDOW_TITLE = process.env.MOORHEN_TITLE || VARIANT.title || "PyKeko";
const OPEN_DEVTOOLS = VARIANT.devTools === true;

// dist variant: serve a packaged static bundle instead of running vite.
// process.resourcesPath points at the .app's Resources/ when packaged;
// in dev (electron .) it points elsewhere — fall back to ../static then.
function resolveStaticDir() {
  if (!VARIANT.bundledDist) return null;
  const packagedPath = path.join(process.resourcesPath, VARIANT.bundledDist);
  if (fs.existsSync(packagedPath)) return packagedPath;
  const devPath = path.join(__dirname, VARIANT.bundledDist);
  if (fs.existsSync(devPath)) return devPath;
  return null;
}
const STATIC_DIR = resolveStaticDir();
const IS_DIST = !!STATIC_DIR;

// Port is dynamic in dist mode (whatever the static server picks), fixed
// in dev mode (matches vite port so PyKekoMCP can find it).
let SERVE_PORT = parseInt(process.env.MOORHEN_VITE_PORT || VARIANT.vitePort || "5173", 10);

let viteProcess = null;
let staticServer = null;
let mainWindow = null;

function log(msg) {
  try { fs.appendFileSync(LOG_PATH, new Date().toISOString() + " " + msg + "\n"); } catch (e) {}
}

function checkServer() {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${SERVE_PORT}/`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(500, () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(timeoutSec = 60) {
  for (let i = 0; i < timeoutSec * 2; i++) {
    if (await checkServer()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// In-process static-file server for the dist variant. Serves the packaged
// SPA bundle with the COOP/COEP headers SharedArrayBuffer requires. Picks a
// random localhost port (returned via SERVE_PORT) so multiple installs can
// coexist.
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".map":  "application/json; charset=utf-8",
  ".cif":  "chemical/x-cif",
  ".pdb":  "chemical/x-pdb",
  ".mtz":  "application/octet-stream",
  ".txt":  "text/plain; charset=utf-8",
  ".xml":  "application/xml; charset=utf-8",
};

function startStaticServer(distDir) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let urlPath = req.url.split("?")[0];
      // SPA fallback: any path that doesn't match a real file falls back to /index.html
      let filePath = path.join(distDir, decodeURIComponent(urlPath));
      // Path traversal guard
      if (!filePath.startsWith(distDir)) { res.writeHead(403); return res.end(); }
      fs.stat(filePath, (err, st) => {
        if (err || st.isDirectory()) {
          // Try /index.html (root and SPA-routed paths)
          filePath = path.join(distDir, "index.html");
        }
        fs.readFile(filePath, (rerr, data) => {
          if (rerr) { res.writeHead(404); return res.end(String(rerr.message || rerr)); }
          const ext = path.extname(filePath).toLowerCase();
          const mime = MIME_TYPES[ext] || "application/octet-stream";
          res.writeHead(200, {
            "content-type": mime,
            "cross-origin-opener-policy": "same-origin",
            "cross-origin-embedder-policy": "require-corp",
            "cache-control": "no-store",
          });
          res.end(data);
        });
      });
    });
    // Pin a deterministic high port so the renderer's origin stays the
    // SAME across launches. The browser's localStorage is per-origin
    // (scheme+host+PORT), so port-0 ("any free port") wipes the welcome
    // modal seen-flag, scripting history, and any other in-page persisted
    // state on every restart. Fallback to OS-assigned only if the pin is
    // busy (e.g. another PyKeko instance or some squatter); persistence is
    // lost for that session but the app at least starts.
    const STATIC_PORT_PREFERRED = 51823;
    let triedFallback = false;
    const onListen = () => {
      const port = server.address().port;
      log("static server on 127.0.0.1:" + port + " serving " + distDir);
      resolve({ server, port });
    };
    server.on("error", err => {
      if (err && err.code === "EADDRINUSE" && !triedFallback) {
        triedFallback = true;
        log("static server: pinned port " + STATIC_PORT_PREFERRED + " busy, falling back to OS-assigned (localStorage won't persist this session)");
        server.listen(0, "127.0.0.1", onListen);
      } else {
        reject(err);
      }
    });
    server.listen(STATIC_PORT_PREFERRED, "127.0.0.1", onListen);
  });
}

async function ensureGenerated() {
  // Run codegen if generated files are missing (first-time setup or after fresh clone)
  const needsCodegen =
    !fs.existsSync(path.join(MOORHEN_DIR, "src/version.js")) ||
    !fs.existsSync(path.join(MOORHEN_DIR, "public/MoorhenAssets/wasm/CootWorker.js")) ||
    !fs.existsSync(path.join(MOORHEN_DIR, "src/protobuf/MoorhenSession.js")) ||
    !fs.existsSync(path.join(MOORHEN_DIR, "src/utils/__graphql__/graphql.ts"));
  if (!needsCodegen) return;
  log("Running one-time codegen (version, ts-worker, protobuf, graphql)...");
  const env = { ...process.env, PATH: "/opt/homebrew/bin:" + (process.env.PATH || "") };
  const { execFileSync } = require("child_process");
  // Order matches baby-gru's prestart script; transpile-ts-worker builds
  // public/MoorhenAssets/wasm/CootWorker.js, without which the Coot command
  // worker fails to load (script returns vite's HTML fallback).
  for (const script of ["create-version", "transpile-ts-worker", "transpile-protobuf", "transpile-graphql-codegen"]) {
    try {
      execFileSync("/opt/homebrew/bin/npm", ["run", script], { cwd: MOORHEN_DIR, env, stdio: "pipe" });
      log("  " + script + " ok");
    } catch (e) {
      log("  " + script + " failed: " + e.message);
    }
  }
}

async function startVite() {
  // Check if vite is already running
  if (await checkServer()) {
    log("Vite already running, reusing");
    return true;
  }

  log("Starting vite from " + MOORHEN_DIR);
  if (!fs.existsSync(MOORHEN_DIR)) {
    dialog.showErrorBox("Moorhen source not found", `Moorhen source directory not found at:\n${MOORHEN_DIR}`);
    return false;
  }

  // Ensure auto-generated files exist
  await ensureGenerated();

  // Build env: prepend Homebrew bin (avoid CCP4's old node)
  const env = { ...process.env, PATH: "/opt/homebrew/bin:" + (process.env.PATH || "") };

  // Source emsdk env if it exists - but easier to just rely on PATH
  viteProcess = spawn(
    "/opt/homebrew/bin/npx",
    ["vite", "--config", "vite.config.mts", "--port", String(SERVE_PORT), "--strictPort"],
    {
      cwd: MOORHEN_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  viteProcess.stdout.on("data", (data) => log("vite stdout: " + data.toString().trim()));
  viteProcess.stderr.on("data", (data) => log("vite stderr: " + data.toString().trim()));
  viteProcess.on("exit", (code) => { log("vite exited with code " + code); viteProcess = null; });

  const ready = await waitForServer(60);
  if (!ready) {
    log("Vite failed to start within 60s");
    dialog.showErrorBox("Server start failed", "Vite dev server did not become ready within 60 seconds.\nCheck " + LOG_PATH);
    return false;
  }
  log("Vite ready");
  return true;
}

async function startBundledServer() {
  if (!STATIC_DIR) {
    dialog.showErrorBox("Bundled assets missing",
      "The distribution build expects a static bundle but none was found.\n" +
      "Looked at: " + path.join(process.resourcesPath, VARIANT.bundledDist || "static"));
    return false;
  }
  try {
    const { server, port } = await startStaticServer(STATIC_DIR);
    staticServer = server;
    SERVE_PORT = port;
    return true;
  } catch (e) {
    log("static server failed: " + e.message);
    dialog.showErrorBox("Server start failed", "Could not start in-process static server: " + e.message);
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: WINDOW_TITLE,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Required for SharedArrayBuffer / WASM threading
      enableBlinkFeatures: "SharedArrayBuffer",
      // Disable sandbox - WASM pthread workers need to spawn child workers
      sandbox: false,
      // Preload sets window.MOORHEN_FORCE_32BIT early (avoids the 64-bit init hang)
      // and pulls __pykekoVersion via ipcRenderer.sendSync("pykeko:get-version")
      // (handler registered above — see comment there for why neither
      // require("./package.json") nor additionalArguments worked).
      preload: path.join(__dirname, "preload.js"),
    },
  });
  // Cleanse any leftover vite-plugin-pwa service worker from PyKeko v0.2.22 and
  // earlier (VitePWA was disabled in v0.2.24, but the SW registered by an older
  // install persists across reinstalls on the localhost:51823 origin and serves
  // the OLD bundle on first launch after every upgrade). The renderer-side
  // cleanup in src/index.tsx that v0.2.24 added is stuck inside the new bundle
  // — which the OLD SW intercepts and replaces with the cached old bundle, so
  // the cleanup never runs. Doing it here, in the main process, BEFORE
  // loadURL, runs through Electron's session API (not through the SW) and
  // clears the SW state before any HTTP request the page makes.
  try {
    mainWindow.webContents.session.clearStorageData({ storages: ["serviceworkers"] })
      .then(() => log("session.clearStorageData(serviceworkers) ok"))
      .catch((e) => log("clearStorageData serviceworkers failed: " + (e && e.message)));
  } catch (e) {
    log("clearStorageData call threw: " + (e && e.message));
  }

  mainWindow.loadURL(`http://localhost:${SERVE_PORT}/`);
  // 32-bit WASM is forced via window.MOORHEN_FORCE_32BIT, set early by preload.js.
  // (The old dom-ready WebAssembly.validate override never matched the probe — it checked
  //  arr[12] instead of arr[11] — and being renderer-only could not reach the Coot worker.)
  if (OPEN_DEVTOOLS) mainWindow.webContents.openDevTools({ mode: "detach" });
  mainWindow.webContents.on("console-message", (event, level, message, line, sourceId) => {
    log(`renderer console: ${message}`);
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

// vite-plugin-cross-origin-isolation already sets COEP/COOP — don't override here

// ---- Control server (for PyKekoMCP) ---------------------------------------
// Local HTTP endpoint that the PyKekoMCP server POSTs commands to. Token-auth,
// 127.0.0.1 only. Non-screenshot verbs are forwarded to the renderer's
// MoorhenControlBridge over IPC; "screenshot" is served here via capturePage.
const CONTROL_PORT = parseInt(process.env.MOORHEN_CONTROL_PORT || String((SERVE_PORT || 5173) + 36827), 10); // 5173->42000
const CONTROL_TOKEN = process.env.MOORHEN_CONTROL_TOKEN || crypto.randomBytes(16).toString("hex");
// CONTROL_FILE is keyed by serve port so multiple PyKeko instances (dev/dist) coexist
function controlFilePath() {
  return path.join(os.homedir(), ".moorhen-mcp", `control-${SERVE_PORT}.json`);
}
const controlPending = new Map(); // id -> { resolve, reject, timer }

function invokeRenderer(win, verb, args) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { controlPending.delete(id); reject(new Error("renderer timeout")); }, 120000);
    controlPending.set(id, { resolve, reject, timer });
    win.webContents.send("moorhen-control:invoke", { id, verb, args });
  });
}

// Synchronous answer to preload's ipcRenderer.sendSync("pykeko:get-version").
// Preload calls this very early to expose window.__pykekoVersion to the page.
// Registered at module load (not inside startControlServer) so it's already
// hooked when the renderer's preload runs — startControlServer is called
// AFTER createWindow, which is too late for this particular sendSync.
ipcMain.on("pykeko:get-version", (event) => {
  try {
    event.returnValue = require(path.join(__dirname, "package.json")).version || "";
  } catch (e) {
    event.returnValue = "";
  }
});

function startControlServer(win) {
  ipcMain.on("moorhen-control:result", (_e, res) => {
    const p = controlPending.get(res.id);
    if (!p) return;
    clearTimeout(p.timer); controlPending.delete(res.id);
    if (res.ok) p.resolve(res.result); else p.reject(new Error(res.error || "control error"));
  });
  ipcMain.on("moorhen-control:ready", async (_e, verbs) => {
    log("control bridge ready; verbs: " + (verbs || []).join(","));
    // Once the renderer's control bridge is up, load any files / PDB IDs from the
    // launch command line (plus any macOS "Open With" files queued before ready).
    if (!initialFilesLoaded) {
      initialFilesLoaded = true;
      const ids = parsePdbIds(process.argv, LAUNCH_CWD);
      const files = parseFileArgs(process.argv, LAUNCH_CWD).concat(pendingOpenFiles.splice(0));
      const scripts = parseScriptArgs(process.argv, LAUNCH_CWD);
      if (ids.length || files.length || scripts.length) {
        log("CLI initial load: " + [...ids, ...files, ...scripts].join(", "));
        await loadPdbIdsIntoRenderer(win, ids);   // coords first so a CIF in files attaches to them
        await loadFilesIntoRenderer(win, files);
        await runScriptsInRenderer(win, scripts);  // .pml last so it can act on what was loaded
      }
    }
  });

  // Native "Open Files" dialog for the renderer (File → Open Files under Electron).
  // Rooted at the working directory, remembers the last-used folder, then loads the
  // chosen files via the loadFiles control verb (same path as the CLI launch).
  ipcMain.handle("pykeko:open-files", async () => {
    try {
      const r = await dialog.showOpenDialog(win, {
        defaultPath: lastOpenDir,
        properties: ["openFile", "multiSelections"],
        filters: [
          { name: "Molecular data", extensions: ["pdb", "ent", "cif", "mmcif", "mol", "mtz", "map", "mrc", "ccp4", "gz", "pb", "pykeko"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (r.canceled || !r.filePaths || r.filePaths.length === 0) return { canceled: true };
      lastOpenDir = path.dirname(r.filePaths[0]);
      await loadFilesIntoRenderer(win, r.filePaths);
      return { canceled: false, files: r.filePaths.map((p) => path.basename(p)) };
    } catch (e) {
      log("open-files dialog failed: " + (e && e.message));
      return { canceled: true, error: String((e && e.message) || e) };
    }
  });

  // Native "Save Image" dialog for high-res screenshot export (File → Screenshot,
  // and the PyMOL `ray`/`png` commands). Defaults to the launch directory, then
  // follows the user. Receives a PNG data URL from the renderer and writes it.
  ipcMain.handle("pykeko:save-image", async (_evt, payload) => {
    try {
      const suggested = String((payload && payload.suggestedName) || "moorhen_screenshot.png").replace(/[/\\]/g, "_");
      const r = await dialog.showSaveDialog(win, {
        title: "Save image",
        defaultPath: path.join(lastSaveDir || app.getPath("desktop"), suggested),
        filters: [{ name: "PNG image", extensions: ["png"] }],
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      lastSaveDir = path.dirname(r.filePath);
      const base64 = String((payload && payload.dataUrl) || "").replace(/^data:image\/\w+;base64,/, "");
      fs.writeFileSync(r.filePath, Buffer.from(base64, "base64"));
      log("saved image: " + r.filePath);
      return { ok: true, path: r.filePath };
    } catch (e) {
      log("save-image dialog failed: " + (e && e.message));
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // Generic save-bundle: writes one or more files to disk via the native Save panel.
  // Payload: { suggestedName, files: [{ name, dataBase64 }] }
  //   - First file in the list is the "primary" — its name suggests the dialog default,
  //     and the path the user picks is used for it verbatim.
  //   - Subsequent files are written into the same directory as the primary, using
  //     their `name` field as-is (relative siblings).
  // Used by `save model.pdb` (one entry) and `save scene.pml` (script + .pdb + .ccp4).
  ipcMain.handle("pykeko:save-bundle", async (_evt, payload) => {
    try {
      const { suggestedName, files } = payload || {};
      if (!Array.isArray(files) || files.length === 0) {
        return { ok: false, error: "no files supplied" };
      }
      const primary = files[0];
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      const suggested = String(suggestedName || primary.name || "pykeko_export").replace(/[/\\]/g, "_");
      const r = await dialog.showSaveDialog(win, {
        title: "Save",
        defaultPath: path.join(lastSaveDir || app.getPath("desktop"), suggested),
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      lastSaveDir = path.dirname(r.filePath);

      // Write primary at the chosen path.
      fs.writeFileSync(r.filePath, Buffer.from(primary.dataBase64, "base64"));
      const writtenPaths = [r.filePath];

      // Write siblings in the same directory under their original names.
      for (const f of files.slice(1)) {
        // Sanitize: no path separators allowed in sibling names (keep it flat).
        const safeName = String(f.name).replace(/[/\\]/g, "_");
        const fp = path.join(lastSaveDir, safeName);
        fs.writeFileSync(fp, Buffer.from(f.dataBase64, "base64"));
        writtenPaths.push(fp);
      }
      log("saved bundle: " + writtenPaths.length + " file(s), primary=" + r.filePath);
      return { ok: true, paths: writtenPaths, primary: r.filePath };
    } catch (e) {
      log("save-bundle failed: " + (e && e.message));
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // Export the loaded scene as a self-contained Mol* viewer HTML (Route B).
  // Reads the prebuilt viewer template (viewer-template/dist/index.html, shipped
  // with the app — or a dev fallback under ~/PyKeko while iterating), injects the
  // renderer-supplied MVS JSON INSIDE the placeholder <script> tag only (a global
  // string replace would clobber the same literal living inside the inlined JS
  // bundle), then writes via the native Save panel.
  ipcMain.handle("pykeko:export-mvs-viewer", async (_evt, payload) => {
    try {
      const { mvsJson, suggestedName } = payload || {};
      if (!mvsJson) return { ok: false, error: "no MVS JSON supplied" };

      const candidates = [
        // Packaged: extraResource ships viewer-template/dist as Resources/dist/.
        path.join(process.resourcesPath || "", "dist", "index.html"),
        // Unpackaged dev (running `npm start` from ~/PyKeko).
        path.join(__dirname, "viewer-template", "dist", "index.html"),
        path.join(__dirname, "..", "viewer-template", "dist", "index.html"),
        // Last-ditch dev fallback (working from a stale .app, source tree present).
        path.join(os.homedir(), "PyKeko", "viewer-template", "dist", "index.html"),
      ];
      let templatePath = null;
      for (const p of candidates) { if (fs.existsSync(p)) { templatePath = p; break; } }
      if (!templatePath) {
        return { ok: false, error: "viewer template not found; tried: " + candidates.join(" | ") };
      }

      const template = fs.readFileSync(templatePath, "utf8");
      const SCRIPT_RE = /(<script id="__pykeko_mvs__" type="application\/json">)([\s\S]*?)(<\/script>)/;
      if (!SCRIPT_RE.test(template)) {
        return { ok: false, error: "placeholder script tag not found in template at " + templatePath };
      }
      // Keep the JSON safe inside <script>: any literal `</script>` inside string
      // values would close the tag prematurely. Escaping `</` to `<\/` is parsed
      // identically by JSON.parse and is the standard workaround.
      const safe = String(mvsJson).replace(/<\//g, "<\\/");
      const html = template.replace(SCRIPT_RE, (_m, open, _content, close) => open + safe + close);

      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      const suggested = String(suggestedName || "pykeko_viewer.html").replace(/[/\\]/g, "_");
      const r = await dialog.showSaveDialog(win, {
        title: "Save portable viewer",
        defaultPath: path.join(lastSaveDir || app.getPath("desktop"), suggested),
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      lastSaveDir = path.dirname(r.filePath);
      fs.writeFileSync(r.filePath, html);
      log("saved portable viewer: " + r.filePath + " (" + Buffer.byteLength(html).toLocaleString() + " bytes)");
      return { ok: true, path: r.filePath };
    } catch (e) {
      log("export-mvs-viewer failed: " + (e && e.message));
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // Save full Moorhen session as a `.pykeko` file (protobuf-encoded). The
  // renderer hands us the encoded bytes; we open a native Save panel and
  // write them. Default extension `.pykeko` (PyKeko-branded); `.pb` accepted
  // too for backward-compat with files saved by upstream Moorhen.
  ipcMain.handle("pykeko:save-session", async (_evt, payload) => {
    try {
      const { bytes, suggestedName } = payload || {};
      if (!bytes) return { ok: false, error: "no session bytes" };
      const buf = Buffer.from(bytes);
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      const suggested = String(suggestedName || "pykeko_session.pykeko").replace(/[/\\]/g, "_");
      const r = await dialog.showSaveDialog(win, {
        title: "Save PyKeko session",
        defaultPath: path.join(lastSaveDir || app.getPath("desktop"), suggested),
        filters: [{ name: "PyKeko session", extensions: ["pykeko", "pb"] }],
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      lastSaveDir = path.dirname(r.filePath);
      fs.writeFileSync(r.filePath, buf);
      log("saved session: " + r.filePath + " (" + buf.length.toLocaleString() + " bytes)");
      return { ok: true, path: r.filePath };
    } catch (e) {
      log("save-session failed: " + (e && e.message));
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // Open a `.pykeko` / `.pb` session via native Open panel. Returns bytes
  // back to the renderer for protobuf-decode + state hydration there.
  ipcMain.handle("pykeko:open-session", async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      const r = await dialog.showOpenDialog(win, {
        title: "Open PyKeko session",
        defaultPath: lastSaveDir || app.getPath("desktop"),
        filters: [{ name: "PyKeko session", extensions: ["pykeko", "pb"] }],
        properties: ["openFile"],
      });
      if (r.canceled || !r.filePaths.length) return { canceled: true };
      const fp = r.filePaths[0];
      lastSaveDir = path.dirname(fp);
      const buf = fs.readFileSync(fp);
      log("opened session: " + fp + " (" + buf.length.toLocaleString() + " bytes)");
      // Electron serializes Buffer fine across IPC; the renderer can wrap as
      // Uint8Array if needed for protobuf decoding.
      return { ok: true, path: fp, bytes: buf };
    } catch (e) {
      log("open-session failed: " + (e && e.message));
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // Renderer -> main: write the augmented mmCIF from declareCovalentLink to
  // the launch CWD. No dialog — the refmacat handoff just lands next to the
  // user's other session files. Filename is sanitised; collisions overwrite.
  //
  // Fallback order for write location:
  //   1. LAUNCH_CWD (set via MOORHEN_CWD env var when launched via the
  //      `pykeko` CLI shim — refmacat session-style)
  //   2. ~/Desktop (when launched from Finder — process.cwd() = "/" is
  //      read-only and useless to the user anyway)
  // Renderer -> main: stream the tail of /tmp/pykeko.log into an in-app
  // console panel. The log file already collects BOTH the renderer's
  // console.{log,warn,error} (Electron forwards them via the
  // console-message hook in createWindow) AND the main process's own
  // `log(...)` calls (refmac/findligand/acedrg spawn output etc.) — so
  // surfacing it in the UI gives the user a "what's PyKeko doing right
  // now" view without having to open Terminal and tail it.
  //
  // Two reads:
  //   - `log-tail-initial`: pulls the last ~16kb so the panel opens
  //     with recent context. Returns { ok, text, position }.
  //   - `log-tail-since`: pulls only bytes added since the given
  //     position. The renderer polls this every ~1s. Returns
  //     { ok, text, position }.
  //
  // Both clamp to a sensible max length so a runaway log doesn't
  // shovel megabytes through IPC.
  ipcMain.handle("pykeko:log-tail-initial", async () => {
    try {
      if (!fs.existsSync(LOG_PATH)) return { ok: true, text: "", position: 0 };
      const stat = fs.statSync(LOG_PATH);
      const INITIAL_BYTES = 16 * 1024;
      const start = Math.max(0, stat.size - INITIAL_BYTES);
      const fd = fs.openSync(LOG_PATH, "r");
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      return { ok: true, text: buf.toString("utf8"), position: stat.size };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle("pykeko:log-tail-since", async (_evt, payload) => {
    try {
      const position = Math.max(0, Number(payload?.position || 0));
      if (!fs.existsSync(LOG_PATH)) return { ok: true, text: "", position: 0 };
      const stat = fs.statSync(LOG_PATH);
      if (stat.size <= position) return { ok: true, text: "", position };
      const MAX_CHUNK = 256 * 1024; // cap per-poll payload
      const want = stat.size - position;
      const start = want > MAX_CHUNK ? stat.size - MAX_CHUNK : position;
      const fd = fs.openSync(LOG_PATH, "r");
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      return { ok: true, text: buf.toString("utf8"), position: stat.size };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // PyKeko v0.2.45 — in-app log console "shell mode".
  //
  // The REPL in MoorhenLogConsole routes inputs that begin with `!` to
  // this handler. The rest of the input is run via the user's login
  // shell (`zsh -lc <cmd>`) inside LAUNCH_CWD (or $HOME if the launch
  // dir is the read-only "/") so $PATH and CCP4-setup-sh-style env
  // come along for free. Useful for `!ls`, `!grep`, `!gemmi info`,
  // `!ccp4 ...`, `!python -c ...`, etc. without leaving PyKeko.
  //
  // Security: this is a single-user desktop app where the user types
  // the command. Same risk shape as opening Terminal yourself. The
  // dedicated spawn handlers above (refmacat/findligand/acedrg) call
  // fixed binaries with shaped args; this is the general escape hatch.
  // Caps: 30 s timeout, 256 kB stdout+stderr each.
  ipcMain.handle("pykeko:run-shell", async (_evt, payload) => {
    try {
      const cmd = String(payload?.cmd || "").trim();
      if (!cmd) return { ok: false, error: "empty command" };
      const timeoutMs = Math.min(120000, Math.max(1000, Number(payload?.timeoutMs) || 30000));
      const cwd = payload?.cwd || effectiveCwd;
      const MAX_OUT = 256 * 1024;
      // Use the user's login shell so PATH / shell init files apply. zsh on
      // macOS by default; respect $SHELL if the user has set something else.
      //
      // -lc is *login non-interactive*, which sources /etc/zprofile +
      // ~/.zshenv + ~/.zprofile + ~/.zlogin -- but NOT ~/.zshrc (interactive
      // only). Since most users keep their PATH additions, conda init,
      // CCP4 setup, and env vars in ~/.zshrc, we explicitly source it
      // (and ~/.bashrc for bash users) before running the user's command.
      // Misbehaving rc files that print to stdout will leak that into the
      // REPL output; the standard `[[ $- == *i* ]]` interactive-guard
      // pattern suppresses prompt/compinit noise automatically.
      const shell = process.env.SHELL || "/bin/zsh";
      const shellName = path.basename(shell);
      const rcSource = shellName === "zsh"
        ? '[ -r "$HOME/.zshrc" ] && source "$HOME/.zshrc"; '
        : shellName === "bash"
        ? '[ -r "$HOME/.bashrc" ] && source "$HOME/.bashrc"; '
        : "";
      const args = ["-lc", rcSource + cmd];
      log(`run-shell: ${shell} -lc ${cmd.length > 200 ? cmd.slice(0, 200) + "…" : cmd} (cwd=${cwd})`);
      return await new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let killed = false;
        let timer = null;
        let child;
        try {
          child = spawn(shell, args, { cwd, env: process.env });
        } catch (e) {
          return resolve({ ok: false, error: "spawn failed: " + String((e && e.message) || e) });
        }
        timer = setTimeout(() => { killed = true; try { child.kill("SIGTERM"); } catch (e) {} }, timeoutMs);
        child.stdout.on("data", (d) => {
          if (stdout.length < MAX_OUT) stdout += d.toString("utf8").slice(0, MAX_OUT - stdout.length);
        });
        child.stderr.on("data", (d) => {
          if (stderr.length < MAX_OUT) stderr += d.toString("utf8").slice(0, MAX_OUT - stderr.length);
        });
        child.on("error", (e) => {
          clearTimeout(timer);
          resolve({ ok: false, error: String((e && e.message) || e), stdout, stderr });
        });
        child.on("close", (code, signal) => {
          clearTimeout(timer);
          resolve({
            ok: !killed && code === 0,
            code: code ?? null,
            signal: signal ?? null,
            killed,
            timedOut: killed,
            stdout,
            stderr,
            cwd,
            cmd,
          });
        });
      });
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // v0.2.45 — change the active working directory. `!cd <path>` in the
  // in-app REPL routes here. Accepts ~, $VAR, and relative paths
  // (resolved against the current effectiveCwd). Validates the target is
  // a directory before mutating. After this, all save-fallback chains
  // and run-shell defaults use the new dir.
  ipcMain.handle("pykeko:set-cwd", async (_evt, payload) => {
    try {
      let p = String(payload?.path || "").trim();
      if (!p) p = os.homedir();
      // Expand leading ~ (~ alone or ~/...). NB: we don't expand ~user form.
      if (p === "~") p = os.homedir();
      else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
      // Expand $VAR / ${VAR}.
      p = p.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, n) => process.env[n] || "")
           .replace(/\$([A-Z_][A-Z0-9_]*)/gi, (_, n) => process.env[n] || "");
      // Resolve against the current effective cwd if relative.
      if (!path.isAbsolute(p)) p = path.resolve(effectiveCwd, p);
      // Validate.
      let st;
      try { st = fs.statSync(p); } catch (e) {
        return { ok: false, error: `not found: ${p}` };
      }
      if (!st.isDirectory()) return { ok: false, error: `not a directory: ${p}` };
      effectiveCwd = p;
      lastOpenDir = p;
      lastSaveDir = p;
      log(`cwd → ${p}`);
      return { ok: true, cwd: p, launchCwd: LAUNCH_CWD };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle("pykeko:get-cwd", async () => {
    return { ok: true, cwd: effectiveCwd, launchCwd: LAUNCH_CWD };
  });

  // v0.2.45 — `!export VAR=value` capture. The REPL routes a shell-style
  // export here so the variable persists across subsequent `!` spawns AND
  // into the refmac5/findligand/acedrg helpers (which inherit process.env).
  // We run the export inside a captured subshell (with ~/.zshrc sourced so
  // expansions like `export PATH=$PATH:/foo` resolve to the user's real
  // PATH), capture the resulting value, then mutate process.env.
  ipcMain.handle("pykeko:set-env", async (_evt, payload) => {
    try {
      const arg = String(payload?.arg || "").trim();
      // Allow either `NAME=value` or just `NAME` (read existing value).
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*(.*))?$/s.exec(arg);
      if (!m) return { ok: false, error: "expected NAME or NAME=value" };
      const name = m[1];
      const hasValue = m[2] !== undefined;
      if (!hasValue) {
        return { ok: true, name, value: process.env[name] || "", read: true };
      }
      const { execFileSync } = require("child_process");
      const shell = process.env.SHELL || "/bin/zsh";
      const shellName = path.basename(shell);
      const rcSource = shellName === "zsh"
        ? '[ -r "$HOME/.zshrc" ] && source "$HOME/.zshrc"; '
        : shellName === "bash"
        ? '[ -r "$HOME/.bashrc" ] && source "$HOME/.bashrc"; '
        : "";
      // export-then-print: the shell handles $VAR / ${VAR} / quoting.
      // printf without trailing newline so we get the literal value back.
      const script = `${rcSource}export ${arg}; printf '%s' "$${name}"`;
      let value = "";
      try {
        value = execFileSync(shell, ["-lc", script], {
          env: process.env, cwd: effectiveCwd, encoding: "utf8", timeout: 5000,
          maxBuffer: 1024 * 1024,
        });
      } catch (e) {
        return { ok: false, error: "shell export failed: " + String((e && e.message) || e) };
      }
      process.env[name] = value;
      const disp = value.length > 100 ? value.slice(0, 100) + "…" : value;
      log(`env: ${name}=${disp}`);
      return { ok: true, name, value };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // v0.2.45 — directory stack for `!pushd` / `!popd` / `!dirs`. Same
  // resolve-and-validate rules as setCwd. `cwdStack` itself lives at
  // module scope above so it persists across IPC calls.
  ipcMain.handle("pykeko:cwd-stack", async (_evt, payload) => {
    try {
      const action = String(payload?.action || "");
      const resolveDir = (raw) => {
        let p = String(raw || "").trim();
        if (!p || p === "~") p = os.homedir();
        else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
        p = p.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_, n) => process.env[n] || "")
             .replace(/\$([A-Z_][A-Z0-9_]*)/gi, (_, n) => process.env[n] || "");
        if (!path.isAbsolute(p)) p = path.resolve(effectiveCwd, p);
        const st = fs.statSync(p); // throws if missing
        if (!st.isDirectory()) throw new Error("not a directory: " + p);
        return p;
      };
      if (action === "push") {
        let target;
        try { target = resolveDir(payload?.path); }
        catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
        cwdStack.unshift(effectiveCwd);
        effectiveCwd = target;
        lastOpenDir = target;
        lastSaveDir = target;
        log(`pushd → ${target} (stack depth ${cwdStack.length})`);
        return { ok: true, cwd: target, stack: [target, ...cwdStack] };
      }
      if (action === "pop") {
        if (cwdStack.length === 0) return { ok: false, error: "directory stack empty" };
        const next = cwdStack.shift();
        effectiveCwd = next;
        lastOpenDir = next;
        lastSaveDir = next;
        log(`popd → ${next} (stack depth ${cwdStack.length})`);
        return { ok: true, cwd: next, stack: [next, ...cwdStack] };
      }
      if (action === "list") {
        return { ok: true, stack: [effectiveCwd, ...cwdStack] };
      }
      return { ok: false, error: "unknown action: " + action };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle("pykeko:save-augmented-cif", async (_evt, payload) => {
    try {
      const { cifText, suggestedName } = payload || {};
      if (!cifText) return { ok: false, error: "no cif text" };
      const safe = String(suggestedName || "covalent_link.cif").replace(/[/\\]/g, "_");
      const tryDirs = [effectiveCwd, app.getPath("desktop")];
      let lastErr = null;
      for (const dir of tryDirs) {
        try {
          const outPath = path.join(dir, safe);
          fs.writeFileSync(outPath, String(cifText), "utf8");
          log("saved augmented cif: " + outPath + " (" + cifText.length.toLocaleString() + " bytes)");
          return { ok: true, path: outPath };
        } catch (e) {
          lastErr = e;
          log("save-augmented-cif (" + dir + ") failed: " + (e && e.message));
        }
      }
      return { ok: false, error: String((lastErr && lastErr.message) || lastErr) };
    } catch (e) {
      log("save-augmented-cif failed: " + (e && e.message));
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // VS Code-style "Install Command-Line Launcher": write a tiny launcher to
  // /usr/local/bin (on the default PATH for every login shell via /etc/paths, so it
  // works regardless of shell) that execs THIS app's binary. /usr/local/bin is
  // root-owned, so the write goes through one osascript admin prompt. The launcher
  // execs the binary directly (cwd is inherited from the shell), so `pykeko foo.pdb`
  // resolves relative paths correctly without needing MOORHEN_CWD.
  const cliName = IS_DIST ? "pykeko" : "pykeko-dev";
  const cliTarget = "/usr/local/bin/" + cliName;
  // Launcher script:
  //  - Intercepts `--help` / `-h` HERE rather than passing them through to the
  //    Electron binary, because Chromium's argv preprocessor eats `--help` and
  //    prints its own (huge, irrelevant) Chromium help message before our
  //    main.js ever sees it. Printing from the launcher is also instant —
  //    no need to spin up the .app to ask "what flags exist?".
  //  - Otherwise execs the .app's binary verbatim with the user's args.
  //  - cwd is inherited from the shell, so relative paths resolve correctly
  //    without needing MOORHEN_CWD.
  const launcherScript = [
    "#!/bin/sh",
    "# " + cliName + " launcher (installed by " + WINDOW_TITLE + ")",
    "case \"$1\" in",
    "  -h|--help)",
    "    cat <<'EOF'",
    cliName + " — PyKeko command-line launcher",
    "",
    "Usage:",
    "  " + cliName + " [files...] [PDB_IDs...] [script.pml] [--new]",
    "  " + cliName + " -h | --help",
    "",
    "Loadable file extensions:",
    "  .pdb .ent .cif .mmcif    coordinates (.cif beside coords attaches as a ligand dictionary)",
    "  .mtz                     reflections (auto-displays as a 2Fo-Fc + Fo-Fc map pair)",
    "  .map .mrc .ccp4          density",
    "  .pb .pykeko              full Moorhen session (re-loads molecules/maps/view/etc.)",
    "  .gz                      routed by inner extension",
    "",
    "PDB IDs:",
    "  Anything matching ^[0-9][a-zA-Z0-9]{3}$ that isn't an existing file gets",
    "  fetched from RCSB.  Example:  " + cliName + " 7sj3",
    "",
    "Scripts:",
    "  .pml files run through PyKeko's PyMOL command translator AFTER any",
    "  structures/maps from the same invocation are loaded.  Example:",
    "    " + cliName + " model.pdb data.mtz refine.pml",
    "",
    "Flags:",
    "  --new        Start a fresh instance instead of handing files to a running",
    "               one (default is single-instance, PyMOL '-R' style).",
    "  -h, --help   Print this message and exit.",
    "",
    "Examples:",
    "  " + cliName + " model.pdb data.mtz ligand.cif      load coords + maps + dict",
    "  " + cliName + " 7sj3                                fetch by PDB id",
    "  " + cliName + " 7sj3 refine.pml                     fetch then run a script",
    "  " + cliName + " --new                               open a fresh empty window",
    "  " + cliName + " session.pykeko                      re-open a saved session",
    "EOF",
    "    exit 0",
    "    ;;",
    "esac",
    "exec \"" + process.execPath + "\" \"$@\"",
    "",
  ].join("\n");

  ipcMain.handle("pykeko:cli-status", async () => {
    try {
      if (!fs.existsSync(cliTarget)) return { installed: false, name: cliName, target: cliTarget };
      const content = fs.readFileSync(cliTarget, "utf8");
      return { installed: content.includes(process.execPath), name: cliName, target: cliTarget };
    } catch (e) {
      return { installed: false, name: cliName, target: cliTarget, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle("pykeko:install-cli", async () => {
    const tmp = path.join(os.tmpdir(), "pykeko-launcher-" + Date.now());
    try {
      fs.writeFileSync(tmp, launcherScript, { mode: 0o755 });
      const shellCmd = "mkdir -p /usr/local/bin && cp '" + tmp + "' '" + cliTarget + "' && chmod 755 '" + cliTarget + "'";
      const escaped = shellCmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      await new Promise((resolve, reject) => {
        const { execFile } = require("child_process");
        execFile("osascript", ["-e", 'do shell script "' + escaped + '" with administrator privileges'],
          (err, _stdout, stderr) => { if (err) reject(new Error(stderr || err.message)); else resolve(); });
      });
      log("installed CLI launcher at " + cliTarget);
      return { ok: true, name: cliName, target: cliTarget };
    } catch (e) {
      const msg = String((e && e.message) || e);
      log("install-cli failed: " + msg);
      // User cancelling the admin prompt shows up as a -128 / "User canceled" error.
      return { ok: false, canceled: /-128|User canceled/i.test(msg), error: msg };
    } finally {
      try { fs.unlinkSync(tmp); } catch (e2) {}
    }
  });

  // Local AceDRG SMILES→CIF fallback. The renderer's primary SMILES→CIF
  // path is smiles_to_pdb (RDKit-WASM, fast, in-process). When that fails
  // — exotic SMILES, AceDRG-only chemistries, geometry corner cases — we
  // shell out to a local AceDRG install.
  //
  // Resolution order for the acedrg binary:
  //   1. AceDRG_BIN env var (explicit override)
  //   2. PATH lookup (acedrg)
  //   3. Common CCP4 install layouts on macOS
  //
  // Returns { ok, cif, tlc } on success, { ok: false, error, ... } on failure.
  // Doesn't fail destructively if acedrg isn't installed — the renderer
  // surfaces the error so the user knows to install CCP4.
  function findAcedrgBin() {
    return findCcp4Bin("acedrg", "AceDRG_BIN");
  }

  function findRefmac5Bin() {
    return findCcp4Bin("refmac5", "REFMAC5_BIN");
  }

  function findFindligandBin() {
    return findCcp4Bin("findligand", "FINDLIGAND_BIN");
  }

  const { mergeRefmacLinkCifs } = require("./lib/refmac-cif-merge");

  function findCcp4Bin(binName, envVar) {
    if (envVar && process.env[envVar] && fs.existsSync(process.env[envVar])) {
      return process.env[envVar];
    }
    const candidates = [
      `/Applications/ccp4-9/bin/${binName}`,
      `/Applications/CCP4-9.app/Contents/CCP4/bin/${binName}`,
      `/Applications/ccp4-8.0/bin/${binName}`,
      `/opt/ccp4-9/bin/${binName}`,
      path.join(os.homedir(), "ccp4-9", "bin", binName),
      path.join(os.homedir(), "ccp4-9.0", "bin", binName),
    ];
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (e) { /* skip */ }
    }
    // Last resort: PATH lookup via `which`. This honours the user's shell
    // setup if they `source ccp4.setup-sh` in .zprofile.
    try {
      const { execFileSync } = require("child_process");
      const which = execFileSync("which", [binName], { encoding: "utf8" }).trim();
      if (which) return which;
    } catch (e) { /* not on PATH */ }
    return null;
  }

  ipcMain.handle("pykeko:acedrg-smiles", async (_evt, payload) => {
    const { smiles, tlc } = payload || {};
    if (!smiles || typeof smiles !== "string") {
      return { ok: false, error: "missing SMILES" };
    }
    // PDB CCD codes are strictly 3 chars, uppercase, A-Z 0-9.
    const cleanTlc = String(tlc || "LIG").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "LIG";

    const acedrg = findAcedrgBin();
    if (!acedrg) {
      return {
        ok: false,
        notInstalled: true,
        error: "acedrg not found. Install CCP4 (https://www.ccp4.ac.uk/) " +
          "or set the AceDRG_BIN env var to the binary's full path.",
      };
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pykeko-acedrg-"));
    try {
      // Write an instructions file rather than passing -i directly: acedrg's
      // -i flag wants a file containing SMILES + monomer-code lines, in that
      // exact format. Cleaner than juggling shell quoting of the SMILES.
      const instr = path.join(workDir, "instructions.txt");
      fs.writeFileSync(instr,
        "MON " + cleanTlc + "\n" +
        "SMILES " + smiles + "\n",
        "utf8");

      const outPrefix = path.join(workDir, cleanTlc);
      const args = ["-i", instr, "-o", outPrefix];
      log("acedrg invoke: " + acedrg + " " + args.join(" "));

      const { execFile } = require("child_process");
      const stderr = await new Promise((resolve) => {
        const child = execFile(acedrg, args, { cwd: workDir, timeout: 120 * 1000 }, (err, _stdout, stderr) => {
          if (err) resolve(stderr || err.message || String(err));
          else resolve(null);
        });
        // No stdin needed; child's instructions file drives it.
        child.on("error", (err) => resolve(stderr || err.message || String(err)));
      });

      // AceDRG can EXIT with stderr noise but still produce a usable CIF; we
      // trust the output file's existence as the success signal.
      const cifPath = outPrefix + ".cif";
      if (!fs.existsSync(cifPath)) {
        return {
          ok: false,
          error: "acedrg did not produce a .cif (instructions: " + instr + ")",
          stderr: stderr || "",
        };
      }
      const cif = fs.readFileSync(cifPath, "utf8");
      log("acedrg succeeded: " + cif.length + " bytes for tlc=" + cleanTlc);
      return { ok: true, cif, tlc: cleanTlc, stderr: stderr || "" };
    } catch (e) {
      const msg = String((e && e.message) || e);
      log("acedrg-smiles failed: " + msg);
      return { ok: false, error: msg };
    } finally {
      // Best-effort cleanup. AceDRG can leave a lot of intermediate files
      // (cif, pdb, mol, lig.scoreOfPosesH, etc.) in the work dir.
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  // Renderer -> main: open a native file picker scoped to MTZ files. Used
  // by the covalent-link refmac5 spawn flow. Returns { ok, path } |
  // { canceled } | { ok: false, error }.
  ipcMain.handle("pykeko:pick-mtz-file", async () => {
    try {
      const win = BrowserWindow.getFocusedWindow() || mainWindow;
      const r = await dialog.showOpenDialog(win, {
        title: "Pick MTZ for REFMAC5",
        defaultPath: lastSaveDir || app.getPath("desktop"),
        filters: [{ name: "MTZ", extensions: ["mtz"] }],
        properties: ["openFile"],
      });
      if (r.canceled || !r.filePaths.length) return { canceled: true };
      const fp = r.filePaths[0];
      lastSaveDir = path.dirname(fp);
      return { ok: true, path: fp };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // Renderer -> main: write an arbitrary text file to a path. Used by
  // the covalent-link flow to save the substituted link CIF next to the
  // augmented model CIF. dir falls back to ~/Desktop just like
  // pykeko:save-augmented-cif.
  ipcMain.handle("pykeko:save-text-file", async (_evt, payload) => {
    try {
      const { text, suggestedName, dir } = payload || {};
      if (!text) return { ok: false, error: "no text" };
      const safe = String(suggestedName || "untitled.txt").replace(/[/\\]/g, "_");
      const tryDirs = [dir, effectiveCwd, app.getPath("desktop")].filter(Boolean);
      let lastErr = null;
      for (const d of tryDirs) {
        try {
          const outPath = path.join(d, safe);
          fs.writeFileSync(outPath, String(text), "utf8");
          log("saved text file: " + outPath + " (" + text.length.toLocaleString() + " bytes)");
          return { ok: true, path: outPath };
        } catch (e) {
          lastErr = e;
        }
      }
      return { ok: false, error: String((lastErr && lastErr.message) || lastErr) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // Renderer -> main: spawn refmac5 to refine a covalent-linked model.
  //
  // Inputs (payload):
  //   modelCifPath  — XYZIN, augmented mmCIF with _struct_conn row
  //   mtzPath       — HKLIN, observed structure factors
  //   linkCifPath   — LIBIN, link dictionary (and/or ligand monomer)
  //   nCycles       — NCYC keyword (default 5)
  //   outDir        — where refined.pdb/refined.mtz/refmac.log are written
  //                   (default: dirname of modelCifPath)
  //
  // Refmac5 keywords used:
  //   MAKE HYDR NO        — don't add hydrogens (Coot side handles them)
  //   MAKE CHECK 0        — skip exhaustive structure validation
  //   MAKE NEWLIGAND EXIT NO — don't abort on a ligand not in the std library
  //   NCYC                — refinement cycles
  //
  // Returns:
  //   { ok: true, refinedPdb, refinedMtz, logPath, log }
  //   { ok: false, notInstalled?, error, log? }
  ipcMain.handle("pykeko:run-refmacat", async (_evt, payload) => {
    const { modelCifPath, mtzPath, linkCifPath, nCycles, outDir } = payload || {};
    if (!modelCifPath || !fs.existsSync(modelCifPath)) {
      return { ok: false, error: "model cif path missing or does not exist: " + modelCifPath };
    }
    if (!mtzPath || !fs.existsSync(mtzPath)) {
      return { ok: false, error: "mtz path missing or does not exist: " + mtzPath };
    }

    const refmac = findRefmac5Bin();
    if (!refmac) {
      return {
        ok: false,
        notInstalled: true,
        error: "refmac5 not found. Install CCP4 (https://www.ccp4.ac.uk/) " +
          "or set REFMAC5_BIN to the binary's full path.",
      };
    }

    // refmac5 (and most CCP4 binaries) need $CCP4 / $CLIBD / etc. set —
    // without them the binary aborts with "Cannot open environ.def" before
    // doing anything. The user's interactive shell sources ccp4.setup-sh,
    // but Electron's spawned child doesn't inherit that.
    // Source the setup script in a wrapping shell and forward its env.
    const setupSh = path.join(path.dirname(refmac), "ccp4.setup-sh");
    const hasSetup = fs.existsSync(setupSh);

    const baseDir = outDir && fs.existsSync(outDir) ? outDir : path.dirname(modelCifPath);
    const baseName = path.basename(modelCifPath, path.extname(modelCifPath));
    const refinedPdb = path.join(baseDir, baseName + "_refined.pdb");
    const refinedMtz = path.join(baseDir, baseName + "_refined.mtz");
    const logPath = path.join(baseDir, baseName + "_refmac.log");
    const extraLibOut = path.join(baseDir, baseName + "_extra.cif");

    const args = [
      "XYZIN", modelCifPath,
      "HKLIN", mtzPath,
      "XYZOUT", refinedPdb,
      "HKLOUT", refinedMtz,
      "LIBOUT", extraLibOut,
    ];

    // LIBIN handling — multi-link aware.
    // When the user has declared more than one covalent bond on the same
    // model, each declare wrote a separate `<base>_link_<linkid>.cif` next
    // to the model. refmac5's `LIBIN` keyword only honors a single file,
    // so we scan the directory for all sibling link CIFs matching the
    // model's basename and merge them into a single combined LIBIN.
    //
    // The model PDB contains LINKR records for every declared bond (the
    // executor accumulates them), so refmac knows which links to apply.
    // Without the merged LIBIN it would only have the chem_link template
    // for the LAST declare and would silently fail to apply the others.
    let libinFile = null;
    if (linkCifPath && fs.existsSync(linkCifPath)) {
      try {
        // model basename is the part before _covalent_ in the filename.
        // e.g. /path/5P9I_covalent_CYS-ACR-pre-terminal.pdb → "5P9I"
        const modelBaseName = path.basename(modelCifPath).replace(/_covalent_.*$/, "");
        const dir = path.dirname(linkCifPath);
        const siblings = fs.readdirSync(dir)
          .filter(f => f.startsWith(modelBaseName + "_link_") && f.endsWith(".cif"))
          .map(f => path.join(dir, f))
          .filter(fp => fs.existsSync(fp));
        if (siblings.length > 1) {
          const cifTexts = siblings.map(fp => fs.readFileSync(fp, "utf8"));
          const merged = mergeRefmacLinkCifs(cifTexts);
          libinFile = path.join(baseDir, modelBaseName + "_links_merged.cif");
          fs.writeFileSync(libinFile, merged, "utf8");
          log("refmac5 LIBIN: merged " + siblings.length + " link CIFs → " + libinFile);
        } else {
          libinFile = linkCifPath;
        }
      } catch (e) {
        log("refmac5 LIBIN merge failed (" + e.message + "), falling back to single");
        libinFile = linkCifPath;
      }
      args.unshift("LIBIN", libinFile);
    }

    const cycles = Math.max(1, Math.min(50, Number(nCycles) || 5));
    // Minimal keywords. EMPIRICAL: `MAKE EXIT NO YES` terminates refmac at
    // the makecif stage before any refinement cycles run (verified
    // against 5P9I 2026-06-14) — the "warnings would otherwise stop us"
    // intent is the wrong cure: refmac proceeds past name-clash warnings
    // on its own with the default keyword set, and LINKR matching is
    // automatic too. `MAKE LINK YES` is also unnecessary; refmac honors
    // LINKR records in the input PDB without it.
    const keywords = "NCYC " + cycles + "\nEND\n";

    log("refmac5 invoke: " + refmac + " " + args.join(" "));
    log("refmac5 keywords:\n" + keywords);

    const { spawn } = require("child_process");
    const result = await new Promise((resolve) => {
      let cmd, cmdArgs, cmdOpts;
      if (hasSetup) {
        // Wrap in a shell that sources ccp4.setup-sh first. Quoting the
        // refmac args with single quotes is safe because none contain
        // single quotes (they're absolute paths and CCP4 keywords).
        const quoted = args.map((a) => "'" + String(a).replace(/'/g, "'\\''") + "'").join(" ");
        cmd = "/bin/sh";
        cmdArgs = ["-c", `. '${setupSh}' && exec '${refmac}' ${quoted}`];
        cmdOpts = { cwd: baseDir };
      } else {
        cmd = refmac;
        cmdArgs = args;
        cmdOpts = { cwd: baseDir };
      }
      const child = spawn(cmd, cmdArgs, cmdOpts);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", (err) => resolve({ exit: -1, stdout, stderr: stderr + String(err) }));
      child.on("exit", (code) => resolve({ exit: code, stdout, stderr }));
      // Send keywords on stdin then close.
      try { child.stdin.write(keywords); child.stdin.end(); } catch (e) { /* ignore */ }
    });

    try { fs.writeFileSync(logPath, "$ " + refmac + " " + args.join(" ") + "\n\n" + keywords + "\n--- stdout ---\n" + result.stdout + "\n--- stderr ---\n" + result.stderr, "utf8"); } catch (e) { /* ignore */ }

    const refinedExists = fs.existsSync(refinedPdb);
    if (result.exit !== 0 && !refinedExists) {
      log("refmac5 failed: exit=" + result.exit);
      return {
        ok: false,
        error: "refmac5 exited " + result.exit + (result.stderr ? ": " + result.stderr.split("\n").slice(-5).join(" ") : ""),
        log: result.stdout + "\n" + result.stderr,
        logPath,
      };
    }

    // Also read the refined PDB content so the renderer can load it via
    // `loadCoordsFromString` (Electron's CSP blocks `file://` URLs from
    // the http://localhost:51823 origin the SPA is served from, so the
    // older "loadCoordsFromURL('file://...')" approach silently failed).
    let refinedPdbText = null;
    try {
      refinedPdbText = fs.readFileSync(refinedPdb, "utf8");
    } catch (e) {
      log("refmac5 done but refined-PDB read failed: " + (e && e.message));
    }

    log("refmac5 done: " + refinedPdb);
    return {
      ok: true,
      refinedPdb,
      refinedPdbText,
      refinedMtz: fs.existsSync(refinedMtz) ? refinedMtz : null,
      logPath,
      log: result.stdout.slice(-4000),
    };
  });

  // Renderer -> main: spawn CCP4's `findligand` (Coot 0.9 desktop's
  // ligand-fit tool) to search a map for ligand-shaped density blobs.
  //
  // Why this exists: PyKeko v0.2.41 tried to wrap Coot 1.x's
  // fit_ligand_right_here at the WASM layer. The function compiles
  // and the clustering step runs (verified via Coot's verbose log:
  // "There are 1 clusters" at the right position with score 138),
  // but the final wligand fit step returns an empty vector. The
  // wligand subsystem appears to be broken in the Coot 1.x WASM
  // build — same shape as the embind silent-drop trap but at a
  // different layer. findligand on Coot 0.9 desktop (shipped in
  // CCP4) does the same job correctly out of the box.
  //
  // Inputs (payload):
  //   proteinPdbText   — protein/model PDB (we write to disk)
  //   mtzPath          — path to MTZ on disk (user picked via picker)
  //   fCol, phiCol     — MTZ column labels (default DELFWT/PHDELWT
  //                      for the Fo-Fc difference; pass FWT/PHWT for
  //                      2Fo-Fc)
  //   ligandPdbText    — ligand initial coordinates PDB (we write
  //                      to disk; findligand uses these as the
  //                      starting geometry for conformer generation)
  //   ligandCifText    — chem_comp dictionary for the ligand
  //   sigma            — search level (default 3.0)
  //   clusters         — max clusters to consider (default 5)
  //   samples          — flexible conformer samples (default 10)
  //   flexible         — use flexible torsion search (default true)
  //   absoluteLevel    — optional absolute density cutoff (e/A^3);
  //                      overrides sigma when set
  //
  // Returns:
  //   { ok: true, fittedLigands: [{ pdbText, path, clusterIdx, sampleIdx }, ...],
  //     workDir, logPath, log }
  //   { ok: false, notInstalled?, error, log? }
  ipcMain.handle("pykeko:run-findligand", async (_evt, payload) => {
    const {
      proteinPdbText, mtzPath, fCol, phiCol,
      ligandPdbText, ligandCifText,
      sigma, clusters, samples, flexible, absoluteLevel,
    } = payload || {};
    if (!proteinPdbText) return { ok: false, error: "no protein PDB text" };
    if (!mtzPath || !fs.existsSync(mtzPath)) {
      return { ok: false, error: "MTZ path missing or does not exist: " + mtzPath };
    }
    if (!ligandPdbText) return { ok: false, error: "no ligand PDB text" };
    if (!ligandCifText) return { ok: false, error: "no ligand CIF dict text" };

    const findlig = findFindligandBin();
    if (!findlig) {
      return {
        ok: false,
        notInstalled: true,
        error: "findligand not found. Install CCP4 (https://www.ccp4.ac.uk/) " +
          "or set FINDLIGAND_BIN to the binary's full path.",
      };
    }

    // findligand is a CCP4 binary; needs $CCP4 / $CLIBD set or it aborts.
    // Same trick as refmac5 — wrap in a shell that sources ccp4.setup-sh.
    const setupSh = path.join(path.dirname(findlig), "ccp4.setup-sh");
    const hasSetup = fs.existsSync(setupSh);

    // Working dir: temp dir under /tmp. Each invocation gets its own
    // so concurrent runs don't trample each other's fitted-ligand-*.pdb
    // outputs.
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pykeko-findligand-"));
    const proteinPath = path.join(workDir, "protein.pdb");
    const ligandPath = path.join(workDir, "ligand.pdb");
    const cifPath = path.join(workDir, "ligand.cif");
    const logPath = path.join(workDir, "findligand.log");

    try {
      fs.writeFileSync(proteinPath, String(proteinPdbText), "utf8");
      fs.writeFileSync(ligandPath, String(ligandPdbText), "utf8");
      fs.writeFileSync(cifPath, String(ligandCifText), "utf8");
    } catch (e) {
      return { ok: false, error: "Could not write findligand inputs: " + (e && e.message) };
    }

    const args = [
      "--pdbin", proteinPath,
      "--hklin", mtzPath,
      "--f", String(fCol || "DELFWT"),
      "--phi", String(phiCol || "PHDELWT"),
      "--dictionary", cifPath,
      "--clusters", String(Math.max(1, Math.min(30, Math.round(clusters || 5)))),
    ];
    if (absoluteLevel !== undefined && absoluteLevel !== null) {
      args.push("--absolute", String(absoluteLevel));
    } else {
      args.push("--sigma", String(sigma || 3.0));
    }
    if (flexible !== false) args.push("--flexible");
    args.push("--samples", String(Math.max(1, Math.min(100, Math.round(samples || 10)))));
    args.push(ligandPath);

    log("findligand invoke: " + findlig + " " + args.join(" "));

    const { spawn } = require("child_process");
    const runResult = await new Promise((resolve) => {
      let cmd, cmdArgs;
      if (hasSetup) {
        const quoted = args.map((a) => "'" + String(a).replace(/'/g, "'\\''") + "'").join(" ");
        cmd = "/bin/sh";
        cmdArgs = ["-c", `. '${setupSh}' && exec '${findlig}' ${quoted}`];
      } else {
        cmd = findlig;
        cmdArgs = args;
      }
      const child = spawn(cmd, cmdArgs, { cwd: workDir });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("error", (err) => resolve({ exit: -1, stdout, stderr: stderr + String(err) }));
      child.on("exit", (code) => resolve({ exit: code, stdout, stderr }));
    });

    try {
      fs.writeFileSync(logPath,
        "$ " + findlig + " " + args.join(" ") + "\n\n" +
        "--- stdout ---\n" + runResult.stdout + "\n" +
        "--- stderr ---\n" + runResult.stderr, "utf8");
    } catch (e) { /* non-fatal */ }

    // Collect fitted ligand outputs. findligand writes
    // fitted-ligand-<cluster>-<sample>.pdb files into the working dir.
    const fittedLigands = [];
    try {
      for (const f of fs.readdirSync(workDir).sort()) {
        const m = f.match(/^fitted-ligand-(\d+)-(\d+)\.pdb$/);
        if (!m) continue;
        const fullPath = path.join(workDir, f);
        const pdbText = fs.readFileSync(fullPath, "utf8");
        fittedLigands.push({
          pdbText,
          path: fullPath,
          clusterIdx: parseInt(m[1], 10),
          sampleIdx: parseInt(m[2], 10),
        });
      }
    } catch (e) {
      log("findligand output read failed: " + (e && e.message));
    }

    if (runResult.exit !== 0 && fittedLigands.length === 0) {
      log("findligand failed: exit=" + runResult.exit);
      return {
        ok: false,
        error: "findligand exited " + runResult.exit +
          (runResult.stderr ? ": " + runResult.stderr.split("\n").slice(-5).join(" ") : ""),
        workDir, logPath,
        log: runResult.stdout + "\n" + runResult.stderr,
      };
    }

    log("findligand done: " + fittedLigands.length + " fits in " + workDir);
    return {
      ok: true,
      fittedLigands,
      workDir,
      logPath,
      log: runResult.stdout.slice(-4000),
    };
  });

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 50 * 1024 * 1024) req.destroy(); });
    req.on("end", async () => {
      const reply = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      let msg;
      try { msg = JSON.parse(body || "{}"); } catch (e) { return reply(400, { ok: false, error: "bad json" }); }
      if (msg.token !== CONTROL_TOKEN) return reply(403, { ok: false, error: "bad token" });
      try {
        let result;
        if (msg.verb === "ping") result = { ok: true, title: WINDOW_TITLE, vitePort: SERVE_PORT };
        else if (msg.verb === "screenshot") result = { png: (await win.webContents.capturePage()).toPNG().toString("base64") };
        else result = await invokeRenderer(win, msg.verb, msg.args);
        reply(200, { ok: true, result });
      } catch (e) { reply(200, { ok: false, error: String((e && e.message) || e) }); }
    });
  });
  server.on("error", (e) => log("control server error: " + e.message));
  server.listen(CONTROL_PORT, "127.0.0.1", () => {
    log(`control server on 127.0.0.1:${CONTROL_PORT}`);
    try {
      const ctlFile = controlFilePath();
      fs.mkdirSync(path.dirname(ctlFile), { recursive: true });
      fs.writeFileSync(ctlFile, JSON.stringify({ port: CONTROL_PORT, token: CONTROL_TOKEN, vitePort: SERVE_PORT, title: WINDOW_TITLE, pid: process.pid }, null, 2));
    } catch (e) { log("control file write failed: " + e.message); }
  });
}

// ---- CLI file loading ------------------------------------------------------
// `pykeko a.pdb b.mtz c.cif` launches and loads the files. The pykeko wrapper
// script sets MOORHEN_CWD so relative paths resolve against the shell's cwd
// (Electron's process.cwd() is unreliable for a .app launch). `--new` forces a
// fresh session instead of loading into a running instance.

// -h / --help: print supported flags + load patterns and exit. Handled before
// anything else so it works regardless of whether an instance is already
// running. Skip when running inside the .app's GUI launcher (Electron passes a
// long list of Chromium switches in process.argv that we don't want to misread
// as a user typing `pykeko --help`); only treat -h/--help as a request when the
// CLI launcher invoked us with it explicitly.
if (process.argv.includes("-h") || process.argv.includes("--help")) {
  // Read the wrapper version from package.json (where Node's require works fine,
  // unlike Electron's preload).
  let v = "";
  try { v = require(path.join(__dirname, "package.json")).version || ""; } catch (e) {}
  const cliName = process.argv[0]?.split("/").pop()?.includes("pykeko-dev") ? "pykeko-dev" : "pykeko";
  // eslint-disable-next-line no-console
  console.log(
`${cliName} ${v ? "(v" + v + ")" : ""}

Usage:
  ${cliName} [files...] [PDB_IDs...] [script.pml] [--new]
  ${cliName} -h | --help

Loadable file extensions:
  .pdb .ent .cif .mmcif        coordinates (.cif beside coords attaches as a ligand dictionary)
  .mtz                         reflections (auto-displays as a 2Fo-Fc + Fo-Fc map pair)
  .map .mrc .ccp4              density
  .pb .pykeko                  full Moorhen session (re-loads molecules/maps/view/etc.)
  .gz                          routed by inner extension

PDB IDs:
  Anything matching ^[0-9][a-zA-Z0-9]{3}$ that isn't an existing file gets
  fetched from RCSB.  Example:  ${cliName} 7sj3

Scripts:
  .pml files run through PyKeko's PyMOL command translator AFTER any
  structures/maps from the same invocation are loaded.  Example:
    ${cliName} model.pdb data.mtz refine.pml

Flags:
  --new        Start a fresh instance instead of handing files to a running
               one (default behaviour is single-instance, PyMOL '-R' style).
  -h, --help   Print this message and exit.

Examples:
  ${cliName} model.pdb data.mtz ligand.cif      load coords + maps + dict
  ${cliName} 7sj3                                fetch by PDB id
  ${cliName} 7sj3 refine.pml                     fetch then run a script
  ${cliName} --new                               open a fresh empty window
  ${cliName} session.pykeko                      re-open a saved session
`);
  process.exit(0);
}

const WANT_NEW = process.argv.includes("--new");
const LAUNCH_CWD = process.env.MOORHEN_CWD || process.cwd();
const LOADABLE_RE = /\.(pdb|ent|cif|mmcif|mtz|mrc|map|ccp4|gz|pb|pykeko)$/i;
let initialFilesLoaded = false;
const pendingOpenFiles = []; // macOS "Open With" files arriving before the bridge is ready
// v0.2.45 — `effectiveCwd` is the *active* working directory the user is
// currently sitting in, mutated by `!cd <path>` in the in-app console.
// Starts at LAUNCH_CWD and falls back to $HOME if that's "/" (GUI launches
// have a useless cwd). Everywhere main.js used to fall back to LAUNCH_CWD
// for save destinations now reads `effectiveCwd` so saves track the user's
// `cd`. LAUNCH_CWD itself is preserved as a const so audit logs still tell
// you where the user originally started.
let effectiveCwd = (LAUNCH_CWD && LAUNCH_CWD !== "/") ? LAUNCH_CWD : os.homedir();
// v0.2.45 — directory stack for !pushd / !popd / !dirs. Index 0 is the most
// recently pushed dir; popd pops from the front. The "current" cwd is
// effectiveCwd, not on the stack.
const cwdStack = [];
let lastOpenDir = effectiveCwd; // native open-dialog starts here, then follows the user
// native save-dialog starts at the active cwd; nulled-out variant retained for
// legacy code paths that gate on "no usable launch dir → no default".
let lastSaveDir = effectiveCwd;

function parseFileArgs(argv, cwd) {
  const out = [];
  for (const a of argv) {
    if (typeof a !== "string" || a.startsWith("-")) continue; // skip flags / Chromium switches
    if (!LOADABLE_RE.test(a)) continue;
    const resolved = path.isAbsolute(a) ? a : path.resolve(cwd || process.cwd(), a);
    try { if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) out.push(resolved); } catch (e) {}
  }
  return out;
}

async function loadFilesIntoRenderer(win, filePaths) {
  if (!win || !filePaths || filePaths.length === 0) return;
  const specs = [];
  for (const p of filePaths) {
    try { specs.push({ name: path.basename(p), dataBase64: fs.readFileSync(p).toString("base64") }); }
    catch (e) { log("could not read CLI file " + p + ": " + e.message); }
  }
  if (specs.length === 0) return;
  try { log("loadFiles -> " + JSON.stringify(await invokeRenderer(win, "loadFiles", [specs]))); }
  catch (e) { log("loadFiles failed: " + e.message); }
}

// PDB IDs on the command line (e.g. `pykeko 1crn 7sj3`) — fetched from RCSB.
// A classic PDB ID is 4 chars starting with a digit; a token is only treated as an
// ID if it isn't also an existing file on disk.
const PDB_ID_RE = /^[0-9][a-zA-Z0-9]{3}$/;
function parsePdbIds(argv, cwd) {
  const out = [];
  for (const a of argv) {
    if (typeof a !== "string" || a.startsWith("-")) continue;
    if (!PDB_ID_RE.test(a)) continue;
    const resolved = path.isAbsolute(a) ? a : path.resolve(cwd || process.cwd(), a);
    try { if (fs.existsSync(resolved)) continue; } catch (e) {}
    out.push(a.toLowerCase());
  }
  return out;
}

async function loadPdbIdsIntoRenderer(win, ids) {
  if (!win || !ids || ids.length === 0) return;
  for (const id of ids) {
    const url = `https://files.rcsb.org/download/${id.toUpperCase()}.pdb`;
    try { log(`fetch ${id} -> ` + JSON.stringify(await invokeRenderer(win, "loadCoordsFromURL", [url, id]))); }
    catch (e) { log(`fetch ${id} failed: ` + e.message); }
  }
}

// PyMOL scripts (.pml) on the command line — run through PyKeko's PyMOL translator
// (runPymol), after structures/files are loaded so the script can act on them. This is
// the first "script file type"; .py / other types can hang off the same parse-then-run
// pattern later.
function parseScriptArgs(argv, cwd) {
  const out = [];
  for (const a of argv) {
    if (typeof a !== "string" || a.startsWith("-")) continue;
    if (!/\.pml$/i.test(a)) continue;
    const resolved = path.isAbsolute(a) ? a : path.resolve(cwd || process.cwd(), a);
    try { if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) out.push(resolved); } catch (e) {}
  }
  return out;
}

async function runScriptsInRenderer(win, scriptPaths) {
  if (!win || !scriptPaths || scriptPaths.length === 0) return;
  for (const p of scriptPaths) {
    try {
      const script = fs.readFileSync(p, "utf8");
      log(`runPymol ${path.basename(p)} -> ` + JSON.stringify(await invokeRenderer(win, "runPymol", [script])));
    } catch (e) { log(`runPymol ${p} failed: ` + e.message); }
  }
}

// macOS Finder "Open With → PyKeko" / drag-onto-dock-icon
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  if (mainWindow && initialFilesLoaded) loadFilesIntoRenderer(mainWindow, [filePath]);
  else pendingOpenFiles.push(filePath);
});

function startApp() {
  app.whenReady().then(async () => {
    fs.writeFileSync(LOG_PATH, "=== PyKeko wrapper started " + new Date().toISOString() + " ===\n");
    log("App ready (variant=" + (IS_DIST ? "dist" : "dev") + ", cwd=" + LAUNCH_CWD + (WANT_NEW ? ", --new" : "") + ")");
    const ok = IS_DIST ? await startBundledServer() : await startVite();
    if (ok) {
      createWindow();
      startControlServer(mainWindow);
    } else {
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    log("All windows closed, shutting down");
    if (viteProcess) {
      try { viteProcess.kill("SIGTERM"); } catch (e) {}
    }
    if (staticServer) {
      try { staticServer.close(); } catch (e) {}
    }
    try { fs.unlinkSync(controlFilePath()); } catch (e) {}
    app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

// Single-instance model: by default a second `pykeko ...` hands its files to the
// running instance (PyMOL-RPC-like). `--new` skips the lock for a fresh session
// (clean for the dist app's random ports; the dev variant's fixed vite port 5174
// means a --new dev instance reuses the running server, so --new is mainly a
// dist-app feature).
if (!WANT_NEW && !app.requestSingleInstanceLock()) {
  // A primary instance already holds the lock; Electron delivers our argv to it
  // via the primary's 'second-instance' handler. Nothing else to do — just exit.
  app.quit();
} else {
  if (!WANT_NEW) {
    app.on("second-instance", async (_event, argv, workingDirectory) => {
      log("second-instance argv: " + (argv || []).join(" "));
      const ids = parsePdbIds(argv, workingDirectory);
      const files = parseFileArgs(argv, workingDirectory);
      const scripts = parseScriptArgs(argv, workingDirectory);
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
        await loadPdbIdsIntoRenderer(mainWindow, ids);
        await loadFilesIntoRenderer(mainWindow, files);
        await runScriptsInRenderer(mainWindow, scripts);
      }
    });
  }
  startApp();
}
