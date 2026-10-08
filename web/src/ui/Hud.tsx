import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getController, GROUP_HEX } from '../scene/SceneController';
import { useStore } from '../state/store';
import { CommandPalette } from './CommandPalette';
import { Dot, Kbd } from './common';
import { Header, MODES } from './Header';
import { Icon } from './icons';
import { LayersMenu } from './LayersMenu';
import { Legend } from './Legend';
import { ModePanel } from './ModePanel';
import { SelectionCard } from './SelectionCard';
import { Timeline } from './Timeline';
import { ZoomControls } from './ZoomControls';

/** At or below this width the layout is a phone's: time on top, panels as a bottom sheet. */
const MOBILE = 760;

const SHORTCUTS: [string, string][] = [
  ['⌘ K  or  /', 'Search objects and actions'],
  ['Space', 'Play or pause time'],
  ['1 – 5', 'Explore, Routing, Conjunctions, Coverage, Catalogue'],
  ['F', 'Follow the selected object'],
  ['Esc', 'Stop following, then clear the selection'],
  ['R', 'Reset the view'],
  ['L', 'Layers and view'],
  ['H', 'Hide or show the interface'],
];

export function Hud() {
  const hover = useStore((s) => s.hover);
  const selected = useStore((s) => s.selected);
  const follow = useStore((s) => s.follow);
  const tab = useStore((s) => s.tab);
  const [palette, setPalette] = useState(false);
  const [layers, setLayers] = useState(false);
  const [help, setHelp] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLSelectElement || t instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useStore.getState();
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === ' ') {
        if (t instanceof HTMLButtonElement) return; // let buttons activate
        e.preventDefault();
        s.set({ paused: !s.paused });
      } else if (key === 'Escape') {
        if (help) setHelp(false);
        else if (layers) setLayers(false);
        else if (s.follow) getController()?.stopFollowing();
        else if (s.selected !== null) getController()?.selectObject(null);
        else if (s.tab !== 'explore') s.set({ tab: 'explore' });
      } else if (key === '/') {
        e.preventDefault();
        setPalette(true);
      } else if (key === '?') {
        setHelp((h) => !h);
      } else if (key === 'f' && s.selected !== null) {
        if (s.follow) getController()?.stopFollowing();
        else getController()?.flyTo(s.selected);
      } else if (key === 'r') {
        getController()?.resetView();
      } else if (key === 'h') {
        setHidden((h) => !h);
      } else if (key === 'l') {
        setLayers((l) => !l);
      } else {
        const mode = MODES.find((m) => m.key === key);
        if (mode) {
          s.set({ tab: mode.id });
          setCollapsed(false);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [help, layers]);

  // a phone starts on the bare globe; the tab bar opens the analysis sheet
  useEffect(() => {
    if (window.innerWidth <= MOBILE) useStore.getState().set({ tab: 'explore' });
  }, []);

  // on a phone, a selection gets the bottom of the screen: tuck the panel away
  useEffect(() => {
    if (selected !== null && window.innerWidth <= MOBILE) setCollapsed(true);
  }, [selected]);
  useEffect(() => setCollapsed(false), [tab]);

  // tell the renderer which parts of the screen the interface covers, so the globe centres in the rest
  useLayoutEffect(() => {
    const root = rootRef.current!;
    // layout boxes, not getBoundingClientRect: entrance animations transform the panels
    const box = (sel: string) => {
      const el = root.querySelector<HTMLElement>(sel);
      if (!el) return null;
      let left = 0, top = 0;
      for (let e: HTMLElement | null = el; e && e !== root; e = e.offsetParent as HTMLElement | null) {
        left += e.offsetLeft;
        top += e.offsetTop;
      }
      return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight };
    };
    const measure = () => {
      const W = window.innerWidth, H = window.innerHeight;
      const insets = { left: 0, right: 0, top: 0, bottom: 0 };
      if (!hidden) {
        const panel = box('.mode-panel');
        const dock = box('.dock');
        const header = box('.topbar');
        const tabs = box('.mode-nav');
        if (W > MOBILE) {
          if (panel) insets.right = W - panel.left;
          if (header) insets.top = header.bottom * 0.6;
          if (dock) insets.bottom = (H - dock.top) * 0.7;
        } else {
          if (dock) insets.top = dock.bottom;
          insets.bottom = H - Math.min(panel?.top ?? H, tabs?.top ?? H);
        }
      }
      getController()?.setViewInsets(insets);
    };
    measure();
    const ro = new ResizeObserver(measure);
    root.querySelectorAll('.mode-panel, .dock, .topbar, .mode-nav').forEach((el) => ro.observe(el));
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [hidden, collapsed, tab]);

  const catalog = getController()?.catalog;
  const name = selected !== null && catalog ? catalog.names[selected] : '';

  return (
    <div className={`hud${hidden ? ' ui-hidden' : ''}${selected !== null ? ' has-selection' : ''}`} ref={rootRef}>
      {/* soft black falloffs so type can sit directly on the scene, no bars */}
      <div className="vignette top" aria-hidden="true" />
      <div className="vignette bottom" aria-hidden="true" />
      <Header onSearch={() => setPalette(true)} onLayers={() => setLayers((l) => !l)} layersOpen={layers} onHelp={() => setHelp(true)} />
      {layers && <LayersMenu onClose={() => setLayers(false)} />}

      <div className="left-rail">
        <Legend />
        <SelectionCard />
      </div>

      {follow && (
        <div className="glass follow-pill" role="status">
          <span className="follow-ring" />
          <span>
            Following <b>{name}</b>
          </span>
          <button onClick={() => getController()?.stopFollowing()} title="Stop following and zoom out">
            Stop <Kbd>Esc</Kbd>
          </button>
        </div>
      )}

      <ModePanel collapsed={collapsed} onCollapse={setCollapsed} />
      <Timeline />
      <ZoomControls hidden={hidden} onToggleUi={() => setHidden((h) => !h)} />

      <button className="credits" onClick={() => setHelp(true)}>
        Data: CelesTrak · NASA · ESA
      </button>

      {hover && catalog && (
        <div className="hover-tip" style={{ left: hover.x, top: hover.y }}>
          <Dot color={GROUP_HEX[catalog.group[hover.index]]} />
          {hover.name}
          <span className="hover-id">#{catalog.ids[hover.index]}</span>
        </div>
      )}

      {palette && <CommandPalette onClose={() => setPalette(false)} />}

      {help && (
        <div className="scrim" onPointerDown={() => setHelp(false)}>
          <div className="glass modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onPointerDown={(e) => e.stopPropagation()}>
            <header className="modal-head">
              <h2 id="help-title">Orbit Explorer</h2>
              <button className="icon-btn" onClick={() => setHelp(false)} aria-label="Close" autoFocus>
                <Icon name="x" size={15} />
              </button>
            </header>
            <p className="modal-lede">
              Every tracked object in Earth orbit, propagated live with SGP4 in your browser. Drag to orbit, scroll or pinch to zoom, click any dot to
              inspect it.
            </p>
            <dl className="shortcuts">
              {SHORTCUTS.map(([k, v]) => (
                <div key={k}>
                  <dt>
                    {k.split('  or  ').map((part, i) => (
                      <span key={part}>
                        {i > 0 && <span className="or">or</span>}
                        <Kbd>{part}</Kbd>
                      </span>
                    ))}
                  </dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
            <p className="modal-credits">
              Orbital elements: <a href="https://celestrak.org" target="_blank" rel="noreferrer">CelesTrak</a>. Earth: NASA Blue Marble Next Generation and
              Black Marble 2016. Milky Way: NASA/Goddard Space Flight Center Scientific Visualization Studio, Deep Star Maps 2020, from ESA Gaia DR2. Stars:
              ESA Hipparcos catalogue. SGP4, frames, routing and screening: own Rust/WASM.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
