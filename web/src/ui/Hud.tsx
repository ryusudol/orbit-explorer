import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getController, GROUP_HEX } from '../scene/SceneController';
import { useStore } from '../state/store';
import { CommandPalette } from './CommandPalette';
import { Kbd } from './common';
import { Header } from './Header';
import { Icon } from './icons';
import { LayersMenu } from './LayersMenu';
import { Legend } from './Legend';
import { ModePanel } from './ModePanel';
import { SelectionCard } from './SelectionCard';
import { Timeline } from './Timeline';
import { ZoomControls } from './ZoomControls';
import { MODES_BY_WORLD, OrbiterCard, TravelCaption, WorldGo, WorldTitle } from './Worlds';
import { BODY_ORDER } from '../sim/bodies';

/** At or below this width the layout is a phone's: time on top, panels as a bottom sheet. */
const MOBILE = 760;

const SHORTCUTS: [string, string][] = [
  ['⌘ K  or  /', 'Search objects and actions'],
  ['Space', 'Play or pause time'],
  ['1 – 5', 'Explore, Routing, Conjunctions, Coverage, Catalogue (elsewhere: Explore, Orbiters, and Link to Earth at the Moon and Mars)'],
  ['E  or  M  or  .', 'Fly to the Earth, the Moon or Mars'],
  ['[  or  ]', 'Fly to the next world in, or out, as far as the Oort cloud'],
  ['F', 'Follow the selected object'],
  ['Esc', 'Stop following, then clear the selection'],
  ['R', 'Reset the view'],
  ['L', 'Layers and view'],
  ['H', 'Hide or show the interface'],
];

/** The name of the object under the pointer. Its own component: it updates every frame while the pointer moves. */
function HoverTip() {
  const hover = useStore((s) => s.hover);
  const catalog = getController()?.catalog;
  if (!hover || (!hover.color && !catalog)) return null;
  return (
    <div className="hover-tip" style={{ left: hover.x, top: hover.y, ['--c' as string]: hover.color ?? GROUP_HEX[catalog!.group[hover.index]] }}>
      {hover.name}
      <span className="hover-id">{hover.color ? hover.meta : `#${catalog!.ids[hover.index]}`}</span>
    </div>
  );
}

export function Hud() {
  const selected = useStore((s) => s.selected);
  const orbiter = useStore((s) => s.orbiter);
  const follow = useStore((s) => s.follow);
  const followName = useStore((s) => (s.body === 'earth' ? s.selectedInfo?.name : s.orbiterInfo?.name) ?? '');
  const tab = useStore((s) => s.tab);
  // the snapshot builder records its source: Space-Track's terms ask for a citation
  const spaceTrack = useStore((s) => s.meta?.source.startsWith('Space-Track') ?? false);
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
        else if (s.orbiter !== null) getController()?.selectOrbiter(null);
        else if (s.selected !== null) getController()?.selectObject(null);
        else if (s.tab !== 'explore') s.set({ tab: 'explore' });
      } else if (key === '/') {
        e.preventDefault();
        setPalette(true);
      } else if (key === '?') {
        setHelp((h) => !h);
      } else if (key === 'f' && s.body !== 'earth' && s.orbiter !== null) {
        if (s.follow) getController()?.stopFollowing();
        else getController()?.flyToOrbiter(s.orbiter);
      } else if (key === 'f' && s.selected !== null) {
        if (s.follow) getController()?.stopFollowing();
        else getController()?.flyTo(s.selected);
      } else if (key === 'e' || key === 'm' || key === '.') {
        getController()?.travelTo(key === 'e' ? 'earth' : key === 'm' ? 'moon' : 'mars');
      } else if (key === '[' || key === ']') {
        // step inward or outward through the worlds, from where we are (or are heading)
        const from = BODY_ORDER.indexOf(s.travel?.to ?? s.body);
        const to = BODY_ORDER[Math.max(0, Math.min(BODY_ORDER.length - 1, from + (key === ']' ? 1 : -1)))];
        if (to !== (s.travel?.to ?? s.body)) getController()?.travelTo(to);
      } else if (key === 'r') {
        getController()?.resetView();
      } else if (key === 'h') {
        setHidden((h) => !h);
      } else if (key === 'l') {
        setLayers((l) => !l);
      } else {
        const mode = MODES_BY_WORLD[s.body].find((m) => m.key === key);
        if (mode) {
          s.set({ tab: mode.id });
          setCollapsed(false);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [help, layers]);

  // on a phone, a selection gets the bottom of the screen: tuck the panel away
  useEffect(() => {
    if ((selected !== null || orbiter !== null) && window.innerWidth <= MOBILE) setCollapsed(true);
  }, [selected, orbiter]);
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

  return (
    <div className={`hud${hidden ? ' ui-hidden' : ''}${selected !== null || orbiter !== null ? ' has-selection' : ''}${tab !== 'explore' || layers ? ' panel-open' : ''}`} ref={rootRef}>
      {/* soft black falloffs so type can sit directly on the scene, no bars */}
      <div className="vignette top" aria-hidden="true" />
      <div className="vignette bottom" aria-hidden="true" />
      <Header onSearch={() => setPalette(true)} onLayers={() => setLayers((l) => !l)} layersOpen={layers} onHelp={() => setHelp(true)} />
      {layers && <LayersMenu onClose={() => setLayers(false)} />}

      <div className="left-rail">
        <WorldTitle />
        <Legend />
        <SelectionCard />
        <OrbiterCard />
      </div>
      <TravelCaption />

      {follow && (
        <div className="glass follow-pill" role="status">
          <span className="follow-ring" />
          <span>
            Following <b>{followName}</b>
          </span>
          <button onClick={() => getController()?.stopFollowing()} title="Stop following and zoom out">
            Stop <Kbd>Esc</Kbd>
          </button>
        </div>
      )}

      <WorldGo />
      <ModePanel collapsed={collapsed} onCollapse={setCollapsed} />
      <Timeline />
      <ZoomControls hidden={hidden} onToggleUi={() => setHidden((h) => !h)} />

      <button className="credits" onClick={() => setHelp(true)}>
        Data: {spaceTrack ? 'Space-Track' : 'CelesTrak'} · NASA/JPL · USGS · ESA
      </button>

      <HoverTip />

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
              Every tracked object in Earth orbit, propagated live with SGP4 in your browser; every planet, every known moon and the spacecraft
              around them on JPL’s trajectories; and the Voyagers on their way out past the Kuiper belt toward the Oort cloud. Drag to orbit, scroll
              or pinch to zoom, click any dot to inspect it, and pick a world at the top right to fly there.
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
              Orbital elements:{' '}
              {spaceTrack ? (
                <a href="https://www.space-track.org" target="_blank" rel="noreferrer">
                  Space-Track.org
                </a>
              ) : (
                <a href="https://celestrak.org" target="_blank" rel="noreferrer">
                  CelesTrak
                </a>
              )}
              . Starlink hardware generations: Jonathan McDowell, planet4589.org. Earth: NASA Blue Marble Next Generation and
              Black Marble 2016. Milky Way: NASA/Goddard Space Flight Center Scientific Visualization Studio, Deep Star Maps 2020, from ESA Gaia DR2. Stars:
              ESA Hipparcos catalogue. Moon: NASA LRO (LROC WAC colour, LOLA elevation) via the SVS CGI Moon Kit. Mars: Viking colour mosaic (USGS
              Astrogeology), MGS MOLA elevation (PDS). Mercury: MESSENGER MDIS colour and elevation (USGS). Venus: Magellan radar and topography
              (USGS). Jupiter, Saturn, Uranus and Neptune: Hubble OPAL global maps (Simon et al., STScI). Moons: Galileo, Voyager and Cassini mosaics
              (USGS Astrogeology). Planets: VSOP87 (IMCCE). Orbiters, moons and the Voyagers: JPL Horizons. Kuiper belt: JPL Small-Body Database.
              SGP4, frames, routing and screening: own Rust/WASM.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
