// Build the dist (default) and dev desktop apps from this single repo:
//   npm run package         -> PyKeko.app    (self-contained dist, no vite/node at runtime)
//   npm run package:dev     -> PyKekoDev.app (~/Moorhen-dev/baby-gru, vite port 5174, devtools)
//   npm run make            -> PyKeko.dmg + PyKeko.app
//
// The selected variant is baked into variant.json (read by main.js at runtime),
// so the packaged, double-clickable app knows which Moorhen tree and port to use
// without relying on shell environment variables at launch.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const VARIANTS = {
  // dist variant: self-contained, redistributable build. The .app bundles a
  // pre-built static dist/ tree and serves it via an in-process HTTP server,
  // so it does not depend on ~/Moorhen, node, npm, emsdk, or vite at runtime.
  dist: {
    name: "PyKeko",
    config: {
      bundledDist: "static",  // relative to app.asar.unpacked or Resources/app/
      logPath: "/tmp/pykeko.log",
      title: "PyKeko",
    },
  },
  dev: {
    name: "PyKekoDev",
    config: {
      moorhenSubdir: "Moorhen-dev/baby-gru",
      vitePort: 5174,
      logPath: "/tmp/pykeko-dev.log",
      title: "PyKeko Dev",
      devTools: true,
    },
  },
};

const VARIANT_KEY = process.env.MOORHEN_VARIANT || "dist";
const variant = VARIANTS[VARIANT_KEY] || VARIANTS.dist;
const IS_DIST = VARIANT_KEY === "dist";

// Where the baby-gru source tree lives on the build machine.
const BABY_GRU = path.join(os.homedir(), "Moorhen", "baby-gru");
// Staging directory inside PyKeko. Becomes Resources/app/static/ in
// the packaged app via packagerConfig.extraResource (added below for dist).
const STATIC_DIR = path.join(__dirname, "static");

function log(msg) {
  process.stdout.write("[forge.config] " + msg + "\n");
}

function buildBabyGruSpa() {
  log("Building baby-gru SPA bundle (this takes a few minutes)...");

  // Run codegen first (idempotent — same scripts the wrapper runs at first launch).
  for (const script of ["create-version", "transpile-ts-worker", "transpile-protobuf", "transpile-graphql-codegen"]) {
    log("  npm run " + script);
    execFileSync("npm", ["run", script], { cwd: BABY_GRU, stdio: "inherit" });
  }

  // The repo's vite.config.mts is set up for LIBRARY builds (build.lib).
  // For the SPA we drop a transient alt config alongside it that loads the
  // base config's plugins but disables lib mode. outDir points directly at
  // PyKeko/static so vite copies built JS + public/ contents there
  // in one step. Cleaned up in finally{}.
  log("Staging built bundle in " + STATIC_DIR);
  if (fs.existsSync(STATIC_DIR)) fs.rmSync(STATIC_DIR, { recursive: true, force: true });

  const altCfgPath = path.join(BABY_GRU, ".vite.config.dist-app.mts");
  const altCfg = `
import baseConfig from "./vite.config.mts";
import { defineConfig } from "vite";

// Disable library-build config so vite builds a real SPA from index.html.
const base = baseConfig as any;
export default defineConfig({
  ...base,
  build: {
    outDir: ${JSON.stringify(STATIC_DIR)},
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    target: "esnext",
    rollupOptions: { output: {} },
  },
});
`;
  fs.writeFileSync(altCfgPath, altCfg);

  try {
    log("  npx vite build --config .vite.config.dist-app.mts");
    execFileSync("npx", ["vite", "build", "--config", ".vite.config.dist-app.mts"], {
      cwd: BABY_GRU,
      stdio: "inherit",
    });
  } finally {
    try { fs.unlinkSync(altCfgPath); } catch (e) {}
  }

  if (!fs.existsSync(STATIC_DIR)) {
    throw new Error("vite build did not produce " + STATIC_DIR);
  }
  log("Static bundle size: " + execFileSync("du", ["-sh", STATIC_DIR]).toString().trim());
}

module.exports = {
  packagerConfig: {
    name: variant.name,
    icon: path.join(__dirname, "PyKeko.icns"),
    // For dist, ship the static bundle alongside the JS so main.js can find
    // it at runtime via path.join(process.resourcesPath, 'static').
    // For both variants, ship the prebuilt Mol* viewer template (Route B export):
    // viewer-template/dist/ -> process.resourcesPath/dist/index.html.
    extraResource: [
      ...(IS_DIST ? [STATIC_DIR] : []),
      path.join(__dirname, "viewer-template", "dist"),
    ],
    // Exclude paths that have NO business being inside the .app. Without this,
    // electron-packager bundles the *entire* project working directory into
    // Resources/app/, which means viewer-template/node_modules (~200 MB) ends
    // up in every dmg — see commit b/c v0.2.18 first shipped a 489 MB dmg.
    // Anything we ACTUALLY need at runtime is either (a) wrapper code
    // (preload.js, main.js, package.json) which lives at the PyKeko root and
    // is bundled by default, or (b) explicitly added via extraResource above.
    // The viewer-template/dist single inlined HTML is added via extraResource
    // so the source dir doesn't need to ship.
    ignore: [
      /^\/\.attic($|\/)/,                 // local backup dmgs
      /^\/\.git($|\/)/,                   // git metadata
      /^\/out($|\/)/,                     // previous build output (avoids recursive bundling)
      /^\/viewer-template($|\/)/,         // viewer-template source + node_modules (the dist/ goes via extraResource)
      /^\/static($|\/)/,                  // staged static dir (also goes via extraResource for dist)
      /\.pykeko$/,                         // stray test session files
      /\.cif$/,                            // stray test PDB downloads
      /\.pdb$/,                            // stray test PDB downloads
    ],
  },
  hooks: {
    // Bake the variant config so the packaged app self-describes its target tree/port.
    prePackage: async () => {
      fs.writeFileSync(
        path.join(__dirname, "variant.json"),
        JSON.stringify(variant.config, null, 2) + "\n"
      );
      if (IS_DIST) {
        buildBabyGruSpa();
      }
    },
  },
  makers: [
    { name: "@electron-forge/maker-zip", platforms: ["darwin"] },
    // DMG for the dist variant only — dev keeps producing .zip
    ...(IS_DIST
      ? [{
          name: "@electron-forge/maker-dmg",
          config: {
            name: "PyKeko",
            overwrite: true,
          },
          platforms: ["darwin"],
        }]
      : []),
  ],
};
