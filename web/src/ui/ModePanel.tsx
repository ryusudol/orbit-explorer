import { useStore, type Tab } from '../state/store';
import { ConjunctionPanel } from './ConjunctionPanel';
import { Icon, type IconName } from './icons';
import { CatalogPanel, CoveragePanel, PerfPanel } from './OtherPanels';
import { RoutePanel } from './RoutePanel';

const PANELS: Partial<Record<Tab, { title: string; blurb: string; icon: IconName; body: () => React.ReactNode }>> = {
  route: { title: 'Laser routing', blurb: 'The fastest path across Starlink’s laser mesh, rebuilt 4× a second.', icon: 'route', body: () => <RoutePanel /> },
  conj: { title: 'Conjunctions', blurb: 'Close approaches between every tracked object, screened ahead.', icon: 'radar', body: () => <ConjunctionPanel /> },
  coverage: { title: 'Coverage', blurb: 'Where on Earth a Starlink satellite is in view right now.', icon: 'globe', body: () => <CoveragePanel /> },
  catalog: { title: 'Catalogue', blurb: 'What is up there, and at which altitude.', icon: 'layers', body: () => <CatalogPanel /> },
  perf: { title: 'Engine', blurb: 'How fast the physics and renderer run in this browser.', icon: 'gauge', body: () => <PerfPanel /> },
};

/** The analysis for the current mode, in a card that sizes to its content. */
export function ModePanel({ collapsed, onCollapse }: { collapsed: boolean; onCollapse: (v: boolean) => void }) {
  const tab = useStore((s) => s.tab);
  const set = useStore((s) => s.set);
  const p = PANELS[tab];
  if (!p) return null;
  return (
    <section key={tab} className={`glass card mode-panel${collapsed ? ' collapsed' : ''}`} aria-label={p.title}>
      <button className="sheet-handle" onClick={() => onCollapse(!collapsed)} aria-label={collapsed ? 'Expand' : 'Collapse'} />
      <header className="panel-head">
        <span className="panel-icon">
          <Icon name={p.icon} size={18} />
        </span>
        <div className="panel-title">
          <h1>{p.title}</h1>
          <p>{p.blurb}</p>
        </div>
        <button className="icon-btn" onClick={() => set({ tab: 'explore' })} aria-label="Close panel" title="Close">
          <Icon name="x" size={15} />
        </button>
      </header>
      <div className="panel-body">{p.body()}</div>
    </section>
  );
}
