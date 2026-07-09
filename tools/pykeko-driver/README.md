# pykeko-driver

Playwright-based helpers for driving a running PyKeko from Python scripts.
Replaces the ad-hoc raw-CDP `expr()` / `call()` boilerplate that used to
appear at the top of every smoke test.

## Install

```
pip install playwright
```

(Chromium download NOT needed — we attach to Electron's Chromium.)

## Use

Launch PyKeko once with the debug port open (any of these work):

```
open -a /Applications/PyKeko.app --args --remote-debugging-port=9222 '--remote-allow-origins=*'
```

Then in Python:

```python
from pykeko_driver import PyKekoSession

with PyKekoSession() as pk:
    pk.load_pdb_from_web("5L0E")
    pk.pymol("hide everything; show cartoon, polymer; show sticks, resn 6ZN")
    pk.pymol("color red, resn 6ZN and elem C")
    pk.screenshot("/tmp/test.png")
    print(pk.eval_selection("byres polymer within 5 of organic"))
```

Or pass `launch=True` to have the driver pkill + relaunch PyKeko for you:

```python
with PyKekoSession(launch=True) as pk:
    ...
```

## Smoke test

```
python pykeko_driver.py
```

Loads 5L0E, runs the v0.3.1 narrow-CID colour-rule regression, saves a
screenshot to `/tmp/pykeko-driver-smoke.png`, and checks the log for the
translator's `[pymol:*] color …` trace lines.

## When to use this vs raw CDP

- **This module**: any new interactive smoke test, screenshot capture,
  or bug-repro during development.
- **Raw CDP** (websocket): only when you need protocol-level features not
  exposed via Playwright (e.g. injecting exceptions into the runtime,
  driving multiple attached DevTools sessions in parallel).

## API surface

Beyond the constructor:

| method | what it does |
| --- | --- |
| `pk.js(source)` | Run arbitrary JS via MoorhenControlApi.evalJs, return the parsed result |
| `pk.pymol(script)` | Run PyMOL commands via the in-app translator |
| `pk.eval_selection(expr)` | Evaluate a selection-algebra expression |
| `pk.load_pdb_from_web(id)` | Fetch from RCSB, load as a molecule, wait until visible |
| `pk.load_pdb_from_file(path)` | Same but from local disk |
| `pk.go_to_residue(cid, mol_no?)` | Centre the view on a residue CID |
| `pk.screenshot(path)` | Save a PNG of the renderer |
| `pk.get_state()` | Return molecules/maps/activeMap snapshot |
| `pk.wait_ms(ms)` | Deliberate delay (prefer wait_for) |
| `pk.wait_for(js_cond)` | Block until a JS predicate is truthy |
| `pk.log_tail(n)` | Last N lines of /tmp/pykeko.log |
| `pk.log_grep(pat)` | Filter log lines matching a regex |
| `pk.page` | Direct Playwright Page handle (escape hatch) |
