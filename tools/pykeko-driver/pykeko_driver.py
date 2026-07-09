"""
pykeko_driver.py — Playwright-based helpers for driving a running PyKeko
from Python scripts.

Usage:
    from pykeko_driver import PyKekoSession
    with PyKekoSession() as pk:
        pk.load_pdb_from_web("5L0E")
        pk.pymol("hide everything; show cartoon, polymer; show sticks, resn 6ZN")
        pk.pymol("color red, resn 6ZN")
        pk.wait_ms(500)
        pk.screenshot("/tmp/test-5l0e.png")
        print(pk.eval_selection("byres polymer within 5 of organic"))

The pattern assumes PyKeko is already running with
`--remote-debugging-port=9222 --remote-allow-origins=*`. If not,
`PyKekoSession(launch=True)` will pkill + relaunch from /Applications.

Compared to the raw-CDP `expr()` / `call()` boilerplate this replaces,
this module gets us:
    - context manager for setup/teardown
    - typed helpers for the common PyKeko surfaces (evaluateSelection,
      runPymol, screenshot, load-coords, log tail)
    - Playwright auto-waiting (no more time.sleep(1.5) races before
      screenshots; the DOM/APIs are queried when actually ready)
    - one-line PyMOL command dispatch that returns {ok, error}
    - context manager auto-closes the browser connection
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.request
from contextlib import contextmanager
from typing import Any, Optional

from playwright.sync_api import Page, Playwright, sync_playwright


DEFAULT_CDP_PORT = 9222
DEFAULT_APP_PATH = "/Applications/PyKeko.app"
DEFAULT_LOG_PATH = "/tmp/pykeko.log"


class PyKekoSession:
    """
    Attach to a running PyKeko and drive it via Playwright.

    Parameters
    ----------
    port : int
        Chrome DevTools Protocol port PyKeko was launched with.
    launch : bool
        If True, kill any running PyKeko and relaunch with debug flags.
    app_path : str
        Path to the .app bundle (only used if launch=True).
    wait_after_launch : float
        Seconds to sleep after `open -a`, giving PyKeko's WASM worker time
        to initialise before we try to attach. Empirically ~10s.
    """

    def __init__(
        self,
        port: int = DEFAULT_CDP_PORT,
        launch: bool = False,
        app_path: str = DEFAULT_APP_PATH,
        wait_after_launch: float = 12.0,
    ):
        self.port = port
        self.launch = launch
        self.app_path = app_path
        self.wait_after_launch = wait_after_launch
        self._pw: Optional[Playwright] = None
        self._browser = None
        self._page: Optional[Page] = None

    # ------------------------------------------------------------------ lifecycle

    def __enter__(self) -> "PyKekoSession":
        if self.launch:
            self._relaunch()
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.connect_over_cdp(f"http://127.0.0.1:{self.port}")
        # Playwright's connect_over_cdp exposes existing contexts. PyKeko has one.
        contexts = self._browser.contexts
        if not contexts:
            raise RuntimeError("No browser context on CDP endpoint; is PyKeko running?")
        pages = contexts[0].pages
        if not pages:
            raise RuntimeError("No pages in PyKeko context; something is very wrong.")
        # PyKeko has a single visible renderer page.
        self._page = pages[0]
        # Wait until MoorhenControlApi is exposed by the bridge — this is the
        # single biggest source of races in the old CDP scripts.
        self._page.wait_for_function(
            "() => window.MoorhenControlApi && typeof window.MoorhenControlApi.evalJs === 'function'",
            timeout=30_000,
        )
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if self._browser:
                self._browser.close()
        finally:
            if self._pw:
                self._pw.stop()

    def _relaunch(self) -> None:
        subprocess.run(["pkill", "-f", "PyKeko"], check=False)
        time.sleep(1)
        try:
            os.remove(DEFAULT_LOG_PATH)
        except FileNotFoundError:
            pass
        subprocess.run(
            [
                "open", "-a", self.app_path,
                "--args",
                f"--remote-debugging-port={self.port}",
                "--remote-allow-origins=*",
            ],
            check=True,
        )
        time.sleep(self.wait_after_launch)

    # ------------------------------------------------------------------ API surface

    @property
    def page(self) -> Page:
        """Direct Playwright Page handle; use for anything not in the helper API."""
        if not self._page:
            raise RuntimeError("PyKekoSession is not open; use `with PyKekoSession() as pk:`")
        return self._page

    def js(self, source: str, await_promise: bool = True) -> Any:
        """Run arbitrary JS in the renderer and return its result.

        Bypasses MoorhenControlApi.evalJs (which is for the REPL's
        expression-first semantics and would double-wrap an async
        arrow function into a returned-function-object). Uses
        Playwright's `page.evaluate` directly — accepts either an
        arrow function `() => ...` / `async () => ...` or a plain
        expression / statement block.
        """
        # Playwright's evaluate expects a JS function expression as the
        # first arg. If the source already begins with `(` or `async` /
        # `function`, pass verbatim. Otherwise wrap it.
        stripped = source.strip()
        if stripped.startswith(("(", "async", "function")):
            return self.page.evaluate(source)
        # Wrap as an async arrow so await inside works.
        return self.page.evaluate(f"async () => {{ {source} }}")

    def pymol(self, script: str) -> dict:
        """Run PyMOL script via the in-app translator. Returns {ok, error?}."""
        return self.page.evaluate(
            f"async () => await window.MoorhenControlApi.runPymol({json.dumps(script)})"
        )

    def eval_selection(self, expr: str) -> dict:
        """Evaluate a selection-algebra expression. Returns {ok, count, cids} | {ok:false,error}."""
        return self.page.evaluate(
            f"async () => await window.MoorhenControlApi.evaluateSelection({json.dumps(expr)})"
        )

    def load_pdb_from_web(self, pdb_id: str, name: Optional[str] = None) -> None:
        """Fetch a PDB from RCSB and load as a new molecule."""
        name = name or pdb_id.upper()
        self.page.evaluate(
            "async ({id, name}) => { "
            "const t = await (await fetch(`https://files.rcsb.org/download/${id}.pdb`)).text(); "
            "await window.MoorhenControlApi.loadCoordsFromString(t, name); "
            "}",
            {"id": pdb_id.upper(), "name": name},
        )
        # Wait until at least one molecule with atoms appears in the store.
        self.page.wait_for_function(
            "() => (window.__moorhen_molecules__ || []).some(m => (m.atomCount || 0) > 0)",
            timeout=30_000,
        )

    def load_pdb_from_file(self, path: str, name: Optional[str] = None) -> None:
        """Load a PDB / mmCIF from local disk."""
        with open(path) as fh:
            text = fh.read()
        name = name or os.path.basename(path)
        self.page.evaluate(
            "async ({text, name}) => await window.MoorhenControlApi.loadCoordsFromString(text, name)",
            {"text": text, "name": name},
        )
        self.page.wait_for_function(
            "() => (window.__moorhen_molecules__ || []).some(m => (m.atomCount || 0) > 0)",
            timeout=30_000,
        )

    def go_to_residue(self, cid: str, mol_no: Optional[int] = None) -> None:
        """Centre the view on a residue CID."""
        if mol_no is None:
            self.page.evaluate(
                f"async () => await window.MoorhenControlApi.goToResidue({json.dumps(cid)})"
            )
        else:
            self.page.evaluate(
                f"async () => await window.MoorhenControlApi.goToResidue({json.dumps(cid)}, {mol_no})"
            )

    def screenshot(self, path: str, full_page: bool = False) -> None:
        """Save a PNG screenshot of the renderer.

        Playwright's built-in `page.screenshot()` API times out against
        Electron's remote-debugging endpoint (it waits for animation
        frames + compositor stability that Electron doesn't advertise
        the same way headless Chromium does). Fall back to the CDP
        `Page.captureScreenshot` command via a session — this is what
        the pre-Playwright raw-CDP scripts used successfully.
        """
        import base64
        session = self.page.context.new_cdp_session(self.page)
        try:
            params = {"format": "png"}
            if full_page:
                params["captureBeyondViewport"] = True
            result = session.send("Page.captureScreenshot", params)
            data = base64.b64decode(result["data"])
            with open(path, "wb") as fh:
                fh.write(data)
        finally:
            session.detach()

    def get_state(self) -> dict:
        """Return {molecules: [...], maps: [...], activeMap: ...}."""
        return self.page.evaluate("async () => await window.MoorhenControlApi.getState()")

    def wait_ms(self, ms: int) -> None:
        """Deliberate delay. Prefer wait_for()/wait_for_function() when possible."""
        self.page.wait_for_timeout(ms)

    def hover_canvas(self) -> None:
        """Move the mouse to the centre of the 3D canvas.

        Necessary before dispatching keyboard shortcuts: Moorhen only
        installs `document.onkeydown` on the canvas mouseenter event
        (see mgWebGL.tsx:1311). Without the hover, keyboard shortcuts
        like Cmd+Z / n / p / etc. are silently dropped.
        """
        box = self.page.evaluate(
            "() => { const c = document.querySelector('canvas'); if (!c) return null; "
            "const r = c.getBoundingClientRect(); "
            "return { x: r.left + r.width/2, y: r.top + r.height/2 }; }"
        )
        if not box:
            raise RuntimeError("no canvas found on page")
        self.page.mouse.move(box["x"], box["y"])
        self.page.wait_for_timeout(200)  # give React time to run the mouseenter handler

    def press(self, keys: str) -> None:
        """Press a keyboard shortcut against the 3D canvas.

        Hovers the canvas first (see hover_canvas). Accepts Playwright's
        key syntax: 'Meta+Z', 'Control+Shift+Z', 'n', 'ArrowUp', etc.
        """
        self.hover_canvas()
        self.page.keyboard.press(keys)

    def wait_for(self, js_condition: str, timeout_ms: int = 10_000) -> None:
        """Block until a JS predicate returns truthy in the renderer.

        Example:
            pk.wait_for("() => document.querySelector('.some-class') !== null")
        """
        self.page.wait_for_function(js_condition, timeout=timeout_ms)

    # ------------------------------------------------------------------ log helpers

    def log_tail(self, lines: int = 40) -> str:
        """Return the last N lines of /tmp/pykeko.log."""
        try:
            with open(DEFAULT_LOG_PATH) as fh:
                content = fh.read()
        except FileNotFoundError:
            return ""
        return "\n".join(content.splitlines()[-lines:])

    def log_grep(self, pattern: str, lines: int = 40) -> list[str]:
        """Return lines matching pattern in the log tail."""
        import re
        tail = self.log_tail(lines * 10)
        return [ln for ln in tail.splitlines() if re.search(pattern, ln)][-lines:]


# ---------------------------------------------------------------------------- smoke

def _smoke():
    """Sanity check — used by `python -m pykeko_driver` or the accompanying smoke script."""
    print("=== PyKeko driver smoke ===")
    with PyKekoSession() as pk:
        # Bridge is up (we already waited in __enter__)
        state = pk.get_state()
        print(f"Molecules loaded at start: {len(state.get('molecules', []))}")

        # Load a covalent test case
        print("Loading 5L0E...")
        pk.load_pdb_from_web("5L0E")

        # Verify selection-algebra parser handles digit-leading resn
        sel = pk.eval_selection("resn 6ZN")
        print(f"resn 6ZN -> ok={sel.get('ok')}, count={sel.get('count')}")
        assert sel.get("ok") and sel.get("count", 0) > 0, "selection failed"

        # Verify narrow-CID color rule (the v0.3.1 fix)
        pk.pymol("hide everything; show cartoon, polymer; show sticks, resn 6ZN; color slate, polymer; color cyan, resn 6ZN")
        pk.go_to_residue("//A/911")

        pk.pymol("color red, resn 6ZN and elem C")
        pk.wait_ms(400)  # give the WebGL a frame to render
        pk.screenshot("/tmp/pykeko-driver-smoke.png")
        print("Screenshot saved to /tmp/pykeko-driver-smoke.png")

        # Log check
        color_lines = pk.log_grep(r"\[pymol.*color")
        print(f"Log traces: {len(color_lines)} color command(s) recorded")
        for ln in color_lines[-3:]:
            print(f"  {ln[-160:]}")

    print("=== smoke OK ===")


if __name__ == "__main__":
    _smoke()
