import { useStore, type Tab } from '../state/store';
import { ConjunctionPanel } from './ConjunctionPanel';
import { Icon, type IconName } from './icons';
import { CatalogPanel, CoveragePanel, PerfPanel } from './OtherPanels';
import { RoutePanel } from './RoutePanel';
import { FleetPanel, RelayPanel, the } from './Worlds';

const PANELS: Partial<Record<Tab, { title: string; blurb: string; icon: IconName; body: () => React.ReactNode }>> = {
  route: { title: 'Laser routing', blurb: 'The fastest path across Starlink’s laser mesh, rebuilt 4× a second.', icon: 'route', body: () => <RoutePanel /> },
  conj: { title: 'Conjunctions', blurb: 'Close approaches between every tracked object, screened ahead.', icon: 'radar', body: () => <ConjunctionPanel /> },
  coverage: { title: 'Coverage', blurb: 'Where on Earth a Starlink satellite is in view right now.', icon: 'globe', body: () => <CoveragePanel /> },
  catalog: { title: 'Catalog', blurb: 'What is up there, and at which altitude.', icon: 'layers', body: () => <CatalogPanel /> },
  perf: { title: 'Engine', blurb: 'How fast the physics and renderer run in this browser.', icon: 'gauge', body: () => <PerfPanel /> },
  fleet: { title: 'Orbiters', blurb: 'What circles this world, on its missions’ own trajectories.', icon: 'satellite', body: () => <FleetPanel /> },
  relay: { title: 'Link to Earth', blurb: 'When a site can talk to Earth: directly, or through an orbiter passing over.', icon: 'link', body: () => <RelayPanel /> },
};

/** The analysis for the current mode, in a card that sizes to its content. */
export function ModePanel({ collapsed, onCollapse }: { collapsed: boolean; onCollapse: (v: boolean) => void }) {
  const tab = useStore((s) => s.tab);
  const body = useStore((s) => s.body);
  const set = useStore((s) => s.set);
  const p = PANELS[tab];
  if (!p) return null;
  // the Earth's analyses don't exist elsewhere, and the other worlds' don't on Earth
  const earthOnly = tab === 'route' || tab === 'conj' || tab === 'coverage' || tab === 'catalog';
  if ((body === 'earth') === (tab === 'fleet' || tab === 'relay') || (body !== 'earth' && earthOnly)) return null;
  const blurb = tab === 'fleet' ? `What circles ${the(body)}, on its missions’ own trajectories.` : p.blurb;
  return (
    <section key={tab} className={`glass card mode-panel${collapsed ? ' collapsed' : ''}`} aria-label={p.title}>
      <button className="sheet-handle" onClick={() => onCollapse(!collapsed)} aria-label={collapsed ? 'Expand' : 'Collapse'} />
      <header className="panel-head">
        <span className="panel-icon">
          <Icon name={p.icon} size={18} />
        </span>
        <div className="panel-title">
          <h1>{p.title}</h1>
          <p>{blurb}</p>
        </div>
        <button className="icon-btn" onClick={() => set({ tab: 'explore' })} aria-label="Close panel" title="Close">
          <Icon name="x" size={15} />
        </button>
      </header>
      <div className="panel-body">{p.body()}</div>
    </section>
  );
}
