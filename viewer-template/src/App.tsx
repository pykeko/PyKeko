// Self-contained Mol* viewer template. PyKeko replaces the
// __PYKEKO_MVS_JSON_PLACEHOLDER__ inside index.html with an MVS JSON document at
// export time. On load we parse it and hand it to Mol*'s loadMVS.
//
// Camera-follow density: MVS itself can't carry a clip param on
// volume_representation (see molstar/molstar#1844). What it CAN do is leave
// the volume reps in the state tree where we can reach them post-load.
// Mol*'s underlying VolumeRepresentation3D has a `clip` param (a renderable
// GPU uniform — updating it is essentially free, no re-mesh) inside its
// `type.params`. After loadMVS we walk the state tree, find every volume
// rep cell, and add a sphere clip that follows the camera target. Updating
// the clip on camera change is one state-tree update per volume per frame,
// throttled so we only fire when the user pauses.

import { useEffect, useRef, useState } from 'react';
import { throttleTime } from 'rxjs';
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
import { StateTransforms } from 'molstar/lib/mol-plugin-state/transforms';
import { Mat4, Vec3 } from 'molstar/lib/mol-math/linear-algebra';
import 'molstar/build/viewer/molstar.css';

// Half-side of the sphere that clips volume isosurfaces around the camera
// target. PyKeko/Coot default is ~13 Å; 20 Å feels a bit roomier and
// matches the export-time embedded cube radius so the user has visible
// density up to the embedded region's boundary.
const DENSITY_CLIP_RADIUS = 20;
// Throttle camera updates — fire the leading edge so a single drag updates
// once, but don't burn frames if the user keeps moving.
const CAMERA_THROTTLE_MS = 80;

const PLACEHOLDER = '__PYKEKO_MVS_JSON_PLACEHOLDER__';

/** Build a clip-props object for the volume rep's `type.params.clip` slot.
 *  variant: 'pixel' → per-fragment clip (vs 'instance' = per-vertex; pixel is
 *  visually smoother for spheres). One sphere object centered at `target` with
 *  uniform scale. The rotation/transform fields aren't used by spheres but the
 *  schema requires them. */
function makeClipSphere(target: Vec3, radius: number) {
    return {
        variant: 'pixel' as const,
        objects: [{
            type: 'sphere' as const,
            invert: false,
            position: Vec3.create(target[0], target[1], target[2]),
            rotation: { axis: Vec3.create(1, 0, 0), angle: 0 },
            scale: Vec3.create(radius, radius, radius),
            transform: Mat4.identity(),
        }],
    };
}

/** After loadMVS: walk the state tree, find every volume representation
 *  cell, set an initial sphere clip on it, and subscribe to camera moves
 *  so the clip follows. Returns the rxjs subscription so the caller can
 *  unsubscribe on dispose. Returns null if the scene has no volume reps. */
function wireCameraFollowDensity(plugin: PluginUIContext) {
    const cells = plugin.state.data.selectQ(q => q.ofTransformer(StateTransforms.Representation.VolumeRepresentation3D));
    if (!cells || cells.length === 0) return null;
    const volumeRefs = cells.map(c => c.transform.ref);

    const applyClipAt = async (target: Vec3) => {
        const clip = makeClipSphere(target, DENSITY_CLIP_RADIUS);
        const update = plugin.build();
        for (const ref of volumeRefs) {
            update.to(ref).update((old: any) => {
                // type.params is a nested object: {isoValue, clip, alpha, ...}.
                // Only patch clip; preserve everything else (isoValue is what
                // the MVS contour-slider in the right panel reads/writes).
                if (!old?.type?.params) return old;
                return {
                    ...old,
                    type: { ...old.type, params: { ...old.type.params, clip } },
                };
            });
        }
        await update.commit();
    };

    // Seed: clip wherever the camera target is right now.
    const cam = plugin.canvas3d?.camera.state;
    if (cam) void applyClipAt(cam.target as unknown as Vec3);

    // And re-clip on every camera settle. throttleTime(leading=true) fires
    // immediately on the first move of a burst and again at most every N ms
    // until the burst stops.
    return plugin.canvas3d!.camera.stateChanged
        .pipe(throttleTime(CAMERA_THROTTLE_MS, undefined, { leading: true, trailing: true }))
        .subscribe(state => {
            void applyClipAt(state.target as unknown as Vec3);
        });
}

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
            // Expose the plugin for power users / debugging — they can script
            // Mol* in the console (e.g. tweak the clip radius:
            //   const p = window.__molstar;
            //   p.state.data.cells.forEach(c => { ... }).
            // Mol*'s own demo viewer does the same; harmless.
            (window as any).__molstar = plugin;
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
                // Wire camera-follow density (no-op if the scene has no maps).
                const followSub = wireCameraFollowDensity(plugin);
                if (followSub) (plugin as any).__pykekoFollowSub = followSub;
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
            (plugin as any)?.__pykekoFollowSub?.unsubscribe?.();
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
