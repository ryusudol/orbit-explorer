import { useEffect, useState } from 'react';
import { getController } from '../scene/SceneController';
import { useStore, type Tab } from '../state/store';
import { ConjunctionPanel } from './ConjunctionPanel';
import { LeftPanel } from './LeftPanel';
import { CatalogPanel, CoveragePanel, PerfPanel } from './OtherPanels';
import { RoutePanel } from './RoutePanel';
import { TopBar } from './TopBar';

const TABS: { id: Tab; label: string }[] = [
  { id: 'route', label: 'Routing' },
  { id: 'conj', label: 'Conjunctions' },
  { id: 'coverage', label: 'Coverage' },
  { id: 'catalog', label: 'Catalogue' },
  { id: 'perf', label: 'Performance' },
];

export function Hud() {
  const tab = useStore((s) => s.tab);
  const set = useStore((s) => s.set);
  const hover = useStore((s) => s.hover);
  const [menu, setMenu] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const s = useStore.getState();
      if (e.key === ' ') {
        e.preventDefault();
        s.set({ paused: !s.paused });
      } else if (e.key === 'Escape') {
        getController()?.selectObject(null);
      } else if (e.key === 'f' && s.selected !== null) {
        if (s.follow) s.set({ follow: false });
        else getController()?.flyTo(s.selected);
      } else if (e.key === 'r') {
        getController()?.resetView();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="hud">
      <TopBar onMenu={() => setMenu(!menu)} />
      <LeftPanel open={menu} />
      <section className={`panel right${collapsed ? ' collapsed' : ''}`} aria-label="Analysis">
        <div className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              className="tab"
              aria-selected={tab === t.id}
              onClick={() => {
                set({ tab: t.id });
                setCollapsed(false);
              }}
            >
              {t.label}
            </button>
          ))}
          <span className="spacer" />
          <button className="tab mobile-toggle" onClick={() => setCollapsed(!collapsed)} aria-label="Collapse panel">
            {collapsed ? '▴' : '▾'}
          </button>
        </div>
        <div className="tab-body" role="tabpanel">
          {tab === 'route' && <RoutePanel />}
          {tab === 'conj' && <ConjunctionPanel />}
          {tab === 'coverage' && <CoveragePanel />}
          {tab === 'catalog' && <CatalogPanel />}
          {tab === 'perf' && <PerfPanel />}
        </div>
      </section>
      {hover && (
        <div className="hover-tip" style={{ left: hover.x, top: hover.y }}>
          {hover.name}
        </div>
      )}
      <footer className="attribution">
        SGP4 · frames · routing · screening: own Rust/WASM · elements: CelesTrak · imagery: NASA Blue &amp; Black Marble ·{' '}
        <span className="muted">drag to orbit · scroll to zoom · click a satellite · F follow · R reset</span>
      </footer>
    </div>
  );
}
