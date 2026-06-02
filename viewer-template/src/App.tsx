// Self-contained Mol* viewer template. PyKeko replaces the
// __PYKEKO_MVS_JSON_PLACEHOLDER__ inside index.html with an MVS JSON document at
// export time. On load we parse it and hand it to Mol*'s loadMVS.
//
// History note: a "density follows camera" widget was attempted here
// (commit 2026-06-01) but rolled back. Mol* 4.18's MVS-loaded volume reps
// expose only ['type', 'colorTheme', 'sizeTheme'] as state-tree params —
// the geometric `clip` param available on standalone VolumeRepresentation3D
// isn't there, and Representation.State.clipping is per-atom-loci (no
// meaning for volumes). Cannot dynamically clip the volume isosurface
// through the supported API surface. The exporters' static crop centred on
// the camera target at export time covers most of the same value at no
// runtime cost; future revival paths are (a) Mol* upstream adding clip to
// the volume-rep transformer, or (b) implementing volume-data masking that
// rewrites grid values outside the sphere and forces a re-mesh on camera
// change (~50-200ms per move, viable but laggy on big maps).

import { useEffect, useRef, useState } from 'react';
import { createPluginUI } from 'molstar/lib/mol-plugin-ui';
import { renderReact18 } from 'molstar/lib/mol-plugin-ui/react18';
import { DefaultPluginUISpec } from 'molstar/lib/mol-plugin-ui/spec';
import { PluginSpec } from 'molstar/lib/mol-plugin/spec';
import type { PluginUIContext } from 'molstar/lib/mol-plugin-ui/context';
import { loadMVS } from 'molstar/lib/extensions/mvs/load';
import { MVSData } from 'molstar/lib/extensions/mvs/mvs-data';
import { MolViewSpec } from 'molstar/lib/extensions/mvs/behavior';
import { StateActions } from 'molstar/lib/mol-plugin-state/actions';
import { PluginCommands } from 'molstar/lib/mol-plugin/commands';
import 'molstar/build/viewer/molstar.css';

const PLACEHOLDER = '__PYKEKO_MVS_JSON_PLACEHOLDER__';

export function App() {
    const hostRef = useRef<HTMLDivElement>(null);
    const [status, setStatus] = useState('Initializing Mol*…');
    // Track right-panel collapse state so the toggle button reflects what's open.
    // 'full' = right panel shown; 'hidden' = right panel collapsed (more canvas).
    const [rightOpen, setRightOpen] = useState(true);
    const pluginRef = useRef<PluginUIContext | null>(null);

    const toggleRight = () => {
        const p = pluginRef.current;
        if (!p) return;
        const cur = p.layout.state.regionState;
        const next = cur.right === 'hidden' ? 'full' : 'hidden';
        PluginCommands.Layout.Update(p, { state: { regionState: { ...cur, right: next } } });
        setRightOpen(next === 'full');
    };

    useEffect(() => {
        if (!hostRef.current) return;
        let cancelled = false;
        let plugin: PluginUIContext | null = null;

        (async () => {
            // Default plugin UI (state tree, rep editor, snapshots, sequence panel, etc.)
            // plus the MolViewSpec behavior so loadMVS can run.
            const baseSpec = DefaultPluginUISpec();
            // Camera FOV: PyMOL defaults to 20° (tight perspective); Mol* to 45°
            // (wide-angle). The exporter injects window.__PYKEKO_FOV__ to carry
            // PyMOL's actual FOV through, so the on-screen framing of MVS camera
            // (position, target, up) matches what PyMOL rendered. Falls back to
            // Mol*'s 45° default when not set.
            const fov = (typeof (window as any).__PYKEKO_FOV__ === 'number')
                ? (window as any).__PYKEKO_FOV__
                : undefined;
            // UI trim: an exported viewer shows ONE scene, so we hide the
            // panels that exist for the general-purpose Mol* viewer
            // (DownloadStructure / DownloadDensity / LoadTrajectory pickers,
            // and the "Remote States" snapshot-sharing list). What remains:
            //   - Open Files action  (drag/drop / file picker still works)
            //   - State Tree, Plugin State (Snapshots), Help, Settings tabs
            //     (reachable via the icon column on the left)
            //   - Right-panel Structure Tools (Components/Quick Styles/etc.)
            //   - Sequence viewer on top
            // The left panel starts collapsed (just the icon column), so a
            // user opening an export sees the structure without UI clutter,
            // and can click any icon to bring up that tab.
            const trimmedActions = (baseSpec.actions ?? []).filter(a =>
                a.action === StateActions.DataFormat.OpenFiles
            );
            const spec = {
                ...baseSpec,
                actions: trimmedActions,
                behaviors: [...(baseSpec.behaviors ?? []), PluginSpec.Behavior(MolViewSpec)],
                layout: {
                    initial: {
                        isExpanded: false,
                        showControls: true,
                        controlsDisplay: 'reactive' as const,
                        regionState: { left: 'collapsed' as const, top: 'full' as const, right: 'full' as const, bottom: 'full' as const },
                    },
                },
                components: {
                    ...(baseSpec.components ?? {}),
                    remoteState: 'none' as const,
                },
                canvas3d: fov !== undefined ? { camera: { fov } } : undefined,
            };

            plugin = await createPluginUI({ target: hostRef.current!, spec, render: renderReact18 });
            if (cancelled) { plugin.dispose(); return; }
            pluginRef.current = plugin;
            // Keep our local rightOpen state in sync if anything else mutates the layout.
            const sub = plugin.layout.events.updated.subscribe(() => {
                setRightOpen(plugin!.layout.state.regionState.right !== 'hidden');
            });
            (plugin as any).__pykekoLayoutSub = sub;

            const node = document.getElementById('__pykeko_mvs__');
            const text = node?.textContent?.trim();
            if (!text || text === PLACEHOLDER) {
                setStatus('No MVS data injected — this is the empty template. Generate one via PyKeko → Export or pymol_to_molstar.');
                return;
            }

            try {
                setStatus('Loading view…');
                const mvs = MVSData.fromMVSJ(text);
                await loadMVS(plugin, mvs, { sanityChecks: true });
                setStatus('');
            } catch (e: any) {
                console.error(e);
                setStatus(`Error loading MVS: ${e?.message ?? String(e)}`);
            }
        })().catch((e) => {
            console.error(e);
            setStatus(`Error: ${e?.message ?? String(e)}`);
        });

        return () => {
            cancelled = true;
            (plugin as any)?.__pykekoLayoutSub?.unsubscribe?.();
            plugin?.dispose();
            pluginRef.current = null;
        };
    }, []);

    return (
        <>
            <div ref={hostRef} style={{ position: 'absolute', inset: 0 }} />
            {status && (
                <div style={{
                    position: 'absolute', top: 8, left: 8, padding: '6px 10px',
                    background: 'rgba(0,0,0,0.7)', color: '#fff', borderRadius: 4,
                    fontFamily: 'system-ui, sans-serif', fontSize: 12, zIndex: 10,
                    maxWidth: '60ch',
                }}>{status}</div>
            )}
            {/* Right-panel toggle. Mol* has no built-in button for this, but
                the right-side Structure Tools eat a lot of canvas; a chevron
                in the top-right of the viewport gives us a one-click hide/show. */}
            <button
                onClick={toggleRight}
                title={rightOpen ? 'Hide Structure Tools (right panel)' : 'Show Structure Tools (right panel)'}
                style={{
                    position: 'absolute', top: 8,
                    // Sit just inside the canvas edge — moves with the right panel.
                    right: rightOpen ? 'calc(var(--msp-control-panel-width, 300px) + 8px)' : 8,
                    width: 28, height: 28, padding: 0,
                    background: 'rgba(0,0,0,0.5)', color: '#fff',
                    border: '1px solid rgba(255,255,255,0.2)', borderRadius: 4,
                    fontFamily: 'system-ui, sans-serif', fontSize: 16, lineHeight: '24px',
                    cursor: 'pointer', zIndex: 10,
                }}
                aria-label={rightOpen ? 'Hide right panel' : 'Show right panel'}
            >
                {rightOpen ? '›' : '‹'}
            </button>
        </>
    );
}
