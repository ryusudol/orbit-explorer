import { useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { Kbd } from './common';
import { Icon, Logo } from './icons';
import { MODES_BY_WORLD, WorldSwitch } from './Worlds';

export function Header({ onSearch, onLayers, layersOpen, onHelp }: { onSearch: () => void; onLayers: () => void; layersOpen: boolean; onHelp: () => void }) {
  const perf = useStore((s) => s.perf);
  const tab = useStore((s) => s.tab);
  const set = useStore((s) => s.set);
  const live = useStore((s) => !s.paused && s.rate === 1 && Math.abs(s.timeMs - Date.now()) < 5000);
  return (
    <header className="topbar">
      <div className="brand">
        <Logo size={26} />
        <span className="brand-name">Orbit Explorer</span>
      </div>
      {/* on phones, where the headline doesn't fit, the worlds sit in the header */}
      <WorldSwitch />

      <ModeNav />

      <div className="top-actions">
        <button
          className={`glass status-chip${tab === 'perf' ? ' active' : ''}`}
          onClick={() => set({ tab: tab === 'perf' ? 'explore' : 'perf' })}
          title="Engine: frame time, SGP4 and the conjunction benchmark"
        >
          <span className={`pulse${live ? '' : ' idle'}`} />
          <span className="status-fps">{Math.round(perf.fps)} fps</span>
          <span className="status-backend">{perf.backend}</span>
        </button>
        <button className="glass search-bar" onClick={onSearch} aria-label="Search satellites and actions" title="Search (⌘K)">
          <Icon name="search" size={14} />
          <span className="search-bar-text">Search</span>
          <Kbd>⌘K</Kbd>
        </button>
        <button className={`glass pill-btn${layersOpen ? ' active' : ''}`} onClick={onLayers} aria-expanded={layersOpen} aria-haspopup="dialog" title="Layers and view (L)">
          <Icon name="sliders" size={16} />
          <span className="pill-label">Layers</span>
        </button>
        <button className="glass round-btn" onClick={onHelp} aria-label="Keyboard shortcuts and about" title="Shortcuts (?)">
          <Icon name="help" size={17} />
        </button>
      </div>
    </header>
  );
}

/** Segmented mode switcher; the highlight slides between modes. */
function ModeNav() {
  const tab = useStore((s) => s.tab);
  const body = useStore((s) => s.body);
  const set = useStore((s) => s.set);
  const listRef = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null);
  const modes = MODES_BY_WORLD[body];
  const active = modes.some((m) => m.id === tab) ? tab : null;

  useLayoutEffect(() => {
    const measure = () => {
      const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
      setIndicator(el ? { x: el.offsetLeft, w: el.offsetWidth } : null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (listRef.current) ro.observe(listRef.current);
    return () => ro.disconnect();
  }, [active, body]);

  return (
    <nav className="glass mode-nav" aria-label="Mode">
      <div className="mode-list" role="tablist" ref={listRef}>
        {indicator && <span className="mode-indicator" style={{ transform: `translateX(${indicator.x}px)`, width: indicator.w }} aria-hidden="true" />}
        {modes.map((m) => (
          <button key={m.id} role="tab" aria-selected={m.id === active} className="mode" onClick={() => set({ tab: m.id })} title={`${m.label} (${m.key})`}>
            <Icon name={m.icon} size={16} />
            <span className="mode-label">{m.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
