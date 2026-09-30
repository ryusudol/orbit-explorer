import { useEffect, useRef } from 'react';
import { SceneController } from './scene/SceneController';
import { decodeCatalog, meanAltitudeKm, type Catalog } from './sim/catalog';
import { useStore, type CatalogMeta } from './state/store';
import { Hud } from './ui/Hud';
import { Loader } from './ui/Loader';

async function loadCatalog(): Promise<{ catalog: Catalog; meta: CatalogMeta }> {
  const [bin, meta] = await Promise.all([
    fetch('/data/catalog.bin').then((r) => {
      if (!r.ok) throw new Error(`catalogue snapshot: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch('/data/catalog.json').then((r) => r.json() as Promise<CatalogMeta>),
  ]);
  return { catalog: decodeCatalog(bin), meta };
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const phase = useStore((s) => s.phase);

  useEffect(() => {
    const set = useStore.getState().set;
    if (!globalThis.crossOriginIsolated) {
      set({
        phase: 'error',
        error:
          'This page needs cross-origin isolation (COOP/COEP headers) to share memory between the physics workers and the renderer. Serve it with the provided Vite config or the public/_headers file.',
      });
      return;
    }
    let controller: SceneController | null = null;
    let cancelled = false;
    // start on the next task: StrictMode's immediate mount/unmount/mount in
    // development then never spins up a second renderer and worker pool
    const start = setTimeout(() => boot().catch(fail), 0);
    const boot = async () => {
      const { catalog, meta } = await loadCatalog();
      if (cancelled) return;
      const counts: [number, number, number] = [0, 0, 0];
      const altitude = new Float32Array(catalog.count);
      for (let i = 0; i < catalog.count; i++) {
        counts[catalog.group[i]]++;
        altitude[i] = meanAltitudeKm(catalog, i);
      }
      set({ meta, groupCounts: counts, altitudeKm: altitude, groups: catalog.group });
      controller = new SceneController(canvasRef.current!, labelsRef.current!, catalog);
      if (import.meta.env.DEV) Object.assign(globalThis, { __kessler: { store: useStore, controller } });
      await controller.init();
      if (!cancelled) {
        performance.mark('kessler-ready'); // first interactive frame, for load-time measurements
        set({ phase: 'ready', readyMs: performance.now() });
      }
    };
    const fail = (err: unknown) => {
      console.error(err);
      set({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
    };
    return () => {
      cancelled = true;
      clearTimeout(start);
      controller?.dispose();
    };
  }, []);

  return (
    <div className="app">
      <div className="viewport">
        <canvas ref={canvasRef} aria-label="3D view of Earth orbit" />
        <div className="label-layer" ref={labelsRef} />
      </div>
      {phase === 'ready' && <Hud />}
      <Loader />
    </div>
  );
}
