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
    if (process.env.AceDRG_BIN && fs.existsSync(process.env.AceDRG_BIN)) {
      return process.env.AceDRG_BIN;
    }
    const candidates = [
      "/Applications/ccp4-9/bin/acedrg",
      "/Applications/CCP4-9.app/Contents/CCP4/bin/acedrg",
      "/Applications/ccp4-8.0/bin/acedrg",
      "/opt/ccp4-9/bin/acedrg",
      path.join(os.homedir(), "ccp4-9", "bin", "acedrg"),
      path.join(os.homedir(), "ccp4-9.0", "bin", "acedrg"),
    ];
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (e) { /* skip */ }
    }
    // Last resort: PATH lookup via `which`. This honours the user's shell
    // setup if they `source ccp4.setup-sh` in .zprofile.
    try {
      const { execFileSync } = require("child_process");
      const which = execFileSync("which", ["acedrg"], { encoding: "utf8" }).trim();
      if (which) return which;
    } catch (e) { /* not on PATH */ }
    return null;
  }

  ipcMain.handle("pykeko:acedrg-smiles", async (_evt, payload) => {
    const { smiles, tlc } = payload || {};
    if (!smiles || typeof smiles !== "string") {
      return { ok: false, error: "missing SMILES" };
    }
    const cleanTlc = String(tlc || "LIG").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "LIG";

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
const LOADABLE_RE = /\.(pdb|ent|cif|mmcif|mtz|mrc|map|ccp4|gz)$/i;
let initialFilesLoaded = false;
const pendingOpenFiles = []; // macOS "Open With" files arriving before the bridge is ready
let lastOpenDir = LAUNCH_CWD; // native open-dialog starts here, then follows the user
// native save-dialog starts at the launch dir when that's usable (CLI launch from
// a project folder), else falls back to the Desktop (a GUI launch has cwd "/"). Then follows the user.
let lastSaveDir = (LAUNCH_CWD && LAUNCH_CWD !== "/") ? LAUNCH_CWD : null;

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
