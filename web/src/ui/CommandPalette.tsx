import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getController, GROUP_HEX } from '../scene/SceneController';
import { useStore } from '../state/store';
import { Dot, Kbd } from './common';
import { int, km, regime } from './format';
import { GROUP_SHORT } from './groups';
import { Icon, type IconName } from './icons';
import { BODIES, BODY_ORDER } from '../sim/bodies';
import { MOON_HEX, SPACECRAFT_HEX, WORLD_HEX, the } from './Worlds';

/** Well-known objects, by NORAD ID, for one-keystroke exploring. */
const FEATURED: { norad: number; name: string; note: string }[] = [
  { norad: 25544, name: 'International Space Station', note: 'Crewed, since 1998' },
  { norad: 48274, name: 'Tiangong', note: 'China’s space station' },
  { norad: 20580, name: 'Hubble Space Telescope', note: 'Since 1990' },
  { norad: 49260, name: 'Landsat 9', note: 'Sun-synchronous imaging' },
  { norad: 41866, name: 'GOES-16', note: 'Geostationary weather' },
];

interface Item {
  id: string;
  section: string;
  title: string;
  meta?: string;
  lead: ReactNode;
  run: () => void;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const alt = useStore((s) => s.altitudeKm);
  const layers = useStore((s) => s.layers);
  const body = useStore((s) => s.body);
  const c = getController()?.catalog;

  const icon = (name: IconName) => (
    <span className="cmd-icon">
      <Icon name={name} size={16} />
    </span>
  );

  const items = useMemo<Item[]>(() => {
    if (!c) return [];
    const st = useStore.getState();
    // an Earth object from the Moon or Mars: fly home first
    const fly = (i: number) => () => getController()?.travelTo('earth', () => getController()?.selectObject(i, true));
    const worlds: Item[] = BODY_ORDER.filter((b) => b !== body).map((b) => ({
      id: `w-${b}`,
      section: 'Worlds',
      title: `Fly to ${the(b)}`,
      meta: b === 'earth' ? 'E' : b === 'moon' ? 'M' : '.',
      lead: <Dot color={WORLD_HEX[b]} />,
      run: () => getController()?.travelTo(b),
    }));
    const orbiters = (['moon', 'mars'] as const).flatMap((b) =>
      BODIES[b].orbiters.map<Item>((o) => ({
        id: `orb${o.id}`,
        section: `Around ${the(b)}`,
        title: o.name,
        meta: o.by,
        lead: <Dot color={o.kind === 'moon' ? MOON_HEX : SPACECRAFT_HEX} />,
        run: () => getController()?.travelTo(b, () => getController()?.selectOrbiter(o.id, true)),
      })),
    );
    const objectMeta = (i: number) => `${alt ? `${regime(alt[i])} · ${km(alt[i])} · ` : ''}#${c.ids[i]}`;
    const actions: Item[] = [
      { id: 'reset', section: 'View', title: 'Reset view', meta: 'R', lead: icon('home'), run: () => getController()?.resetView() },
      {
        id: 'frame',
        section: 'View',
        title: layers.earthFixed ? 'Hold the view fixed to the stars' : 'Rotate the view with the Earth',
        lead: icon('rotate'),
        run: () => st.setLayer('earthFixed', !layers.earthFixed),
      },
      { id: 'sky', section: 'View', title: `${layers.sky ? 'Hide' : 'Show'} the Milky Way and Sun`, lead: icon('stars'), run: () => st.setLayer('sky', !layers.sky) },
      { id: 'coverage', section: 'View', title: `${layers.coverage ? 'Hide' : 'Show'} the coverage heatmap`, lead: icon('heat'), run: () => st.setLayer('coverage', !layers.coverage) },
      { id: 'conj', section: 'Analysis', title: 'Upcoming conjunctions', meta: '3', lead: icon('radar'), run: () => st.set({ tab: 'conj' }) },
      { id: 'route', section: 'Analysis', title: 'Laser routing latency', meta: '2', lead: icon('route'), run: () => st.set({ tab: 'route' }) },
      { id: 'perf', section: 'Analysis', title: 'Engine performance', lead: icon('gauge'), run: () => st.set({ tab: 'perf' }) },
    ];

    const query = q.trim().toUpperCase();
    if (!query) {
      const featured = FEATURED.map((f) => ({ ...f, i: c.ids.indexOf(f.norad) }))
        .filter((f) => f.i >= 0)
        .map<Item>((f) => ({
          id: `f${f.norad}`,
          section: 'Featured',
          title: f.name,
          meta: `${f.note} · ${objectMeta(f.i)}`,
          lead: icon('satellite'),
          run: fly(f.i),
        }));
      const here = body === 'earth' ? featured : orbiters.filter((o) => o.section === `Around ${the(body)}`);
      return [...worlds, ...here, ...actions];
    }

    // a NORAD ID, also as the cards show it ("#100224") or "NORAD 100224": the exact match first,
    // then IDs it begins (while typing one out), then names containing the digits (STARLINK-31002)
    const digits = /^(?:#|NORAD\s*)?(\d+)$/.exec(query)?.[1];
    const hits: number[] = [];
    const exact = digits ? c.ids.indexOf(Number(digits)) : -1;
    if (exact >= 0) hits.push(exact);
    const collect = (max: number, keep: (i: number) => boolean) => {
      for (let i = 0; i < c.count && hits.length < max; i++) if (keep(i) && !hits.includes(i)) hits.push(i);
    };
    if (digits) collect(5, (i) => String(c.ids[i]).startsWith(digits));
    collect(10, (i) => c.names[i].toUpperCase().includes(digits ?? query));
    if (digits) collect(10, (i) => String(c.ids[i]).startsWith(digits));
    const objects = hits.map<Item>((i) => ({
      id: `o${i}`,
      section: 'Objects',
      title: c.names[i],
      meta: `${GROUP_SHORT[c.group[i]]} · ${objectMeta(i)}`,
      lead: <Dot color={GROUP_HEX[c.group[i]]} />,
      run: fly(i),
    }));
    const words = query.toLowerCase();
    const named = (list: Item[]) => list.filter((a) => a.title.toLowerCase().includes(words) || (a.meta ?? '').toLowerCase().includes(words));
    return [...named(worlds), ...named(orbiters), ...objects, ...actions.filter((a) => a.title.toLowerCase().includes(words))];
  }, [q, c, alt, layers, body]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (it: Item | undefined) => {
    if (!it) return;
    onClose();
    it.run();
  };

  let lastSection = '';
  return (
    <div className="scrim palette-scrim" onPointerDown={onClose}>
      <div className="glass palette" role="dialog" aria-modal="true" aria-label="Search and commands" onPointerDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            value={q}
            placeholder={`Search ${c ? int(c.count) : ''} objects by name or NORAD ID…`}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((a) => Math.min(items.length - 1, a + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === 'Enter') {
                run(items[active]);
              } else if (e.key === 'Escape') {
                onClose();
              }
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `cmd-${items[active].id}` : undefined}
            spellCheck={false}
            autoComplete="off"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {items.length === 0 && (
            <div className="palette-empty">
              {c && /^(?:#|norad\s*)?\d+$/i.test(q.trim())
                ? `No object with NORAD ID ${q.trim().replace(/^\D+/, '')} in this snapshot (${new Date(c.generatedMs).toISOString().slice(0, 10)}).`
                : `Nothing matches “${q.trim()}”.`}
            </div>
          )}
          {items.map((it, k) => {
            const head = it.section !== lastSection ? it.section : null;
            lastSection = it.section;
            return (
              <div key={it.id}>
                {head && <div className="palette-section">{head}</div>}
                <button id={`cmd-${it.id}`} role="option" aria-selected={k === active} className="cmd" onMouseMove={() => setActive(k)} onClick={() => run(it)}>
                  {it.lead}
                  <span className="cmd-title">{it.title}</span>
                  {it.meta && <span className="cmd-meta">{it.meta}</span>}
                  <span className="cmd-enter" aria-hidden="true">
                    <Icon name="link" size={13} />
                  </span>
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> move
          </span>
          <span>
            <Kbd>↵</Kbd> open
          </span>
          <span>Objects fly the camera to them and follow.</span>
        </div>
      </div>
    </div>
  );
}
