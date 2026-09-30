import { useMemo, useState } from 'react';
import { getController, GROUP_HEX } from '../scene/SceneController';
import { useStore, type Layers } from '../state/store';
import { fixed, int, km, lat, lon } from './format';

const GROUPS: { key: keyof Layers; label: string }[] = [
  { key: 'starlink', label: 'Starlink' },
  { key: 'debris', label: 'Debris & rocket bodies' },
  { key: 'payload', label: 'Other payloads' },
];

const LAYERS: { key: keyof Layers; label: string }[] = [
  { key: 'links', label: 'Laser links' },
  { key: 'route', label: 'Route & packets' },
  { key: 'cones', label: 'Ground visibility cones' },
  { key: 'coverage', label: 'Coverage map' },
  { key: 'trail', label: 'Orbit of selection' },
  { key: 'eclipse', label: 'Earth-shadow dimming' },
  { key: 'earthFixed', label: 'Camera turns with Earth' },
];

function Toggle({ on, onChange, children, count }: { on: boolean; onChange: (v: boolean) => void; children: React.ReactNode; count?: number }) {
  return (
    <button className="toggle" role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <span className="switch" />
      <span className="name">{children}</span>
      {count !== undefined && <span className="count">{int(count)}</span>}
    </button>
  );
}

export function LeftPanel({ open }: { open: boolean }) {
  const layers = useStore((s) => s.layers);
  const setLayer = useStore((s) => s.setLayer);
  const counts = useStore((s) => s.groupCounts);
  return (
    <aside className={`left${open ? ' open' : ''}`}>
      <div className="panel">
        <div className="section">
          <h2 className="h">Objects</h2>
          {GROUPS.map((g, i) => (
            <Toggle key={g.key} on={layers[g.key]} onChange={(v) => setLayer(g.key, v)} count={counts[i]}>
              <span className="row">
                <span className="dot" style={{ background: GROUP_HEX[i] }} />
                {g.label}
              </span>
            </Toggle>
          ))}
        </div>
        <div className="section">
          <h2 className="h">Layers</h2>
          {LAYERS.map((l) => (
            <Toggle key={l.key} on={layers[l.key]} onChange={(v) => setLayer(l.key, v)}>
              {l.label}
            </Toggle>
          ))}
        </div>
        <div className="section">
          <Search />
        </div>
      </div>
      <Inspector />
    </aside>
  );
}

function Search() {
  const [q, setQ] = useState('');
  const results = useMemo(() => {
    const c = getController()?.catalog;
    const query = q.trim().toUpperCase();
    if (!c || query.length < 2) return [];
    const out: number[] = [];
    const asId = /^\d+$/.test(query) ? Number(query) : -1;
    for (let i = 0; i < c.count && out.length < 8; i++) {
      if (c.ids[i] === asId || c.names[i].toUpperCase().includes(query)) out.push(i);
    }
    return out;
  }, [q]);
  const c = getController()?.catalog;
  return (
    <>
      <h2 className="h">Find an object</h2>
      <input className="search" placeholder="Name or NORAD ID, e.g. ISS, 25544" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search the catalogue" />
      {results.length > 0 && c && (
        <div className="results">
          {results.map((i) => (
            <button
              key={i}
              className="result"
              onClick={() => {
                getController()?.selectObject(i, true);
                setQ('');
              }}
            >
              <span className="dot" style={{ background: GROUP_HEX[c.group[i]] }} />
              <span>{c.names[i]}</span>
              <span className="id">{c.ids[i]}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function Inspector() {
  const info = useStore((s) => s.selectedInfo);
  const selected = useStore((s) => s.selected);
  const follow = useStore((s) => s.follow);
  if (selected === null || !info) return null;
  const lit = info.sunlit >= 0.999 ? 'Sunlit' : info.sunlit <= 0.001 ? 'In Earth’s shadow' : `Penumbra ${int(info.sunlit * 100)}%`;
  return (
    <div className="panel">
      <div className="section">
        <div className="inspector-name">
          <span className="dot" style={{ background: GROUP_HEX[info.group] }} />
          {info.name}
        </div>
        <div className="sub mono">
          NORAD {info.norad} · elements {fixed(info.epochAgeH, 1)} h old
        </div>
      </div>
      <div className="section grid2">
        <Stat k="latitude" v={lat(info.latDeg)} />
        <Stat k="longitude" v={lon(info.lonDeg)} />
        <Stat k="altitude" v={km(info.altKm)} />
        <Stat k="speed" v={`${fixed(info.speedKms, 2)} km/s`} />
        <Stat k="period" v={`${fixed(info.periodMin, 1)} min`} />
        <Stat k="inclination" v={`${fixed(info.inclinationDeg, 2)}°`} />
        <Stat k="perigee" v={km(info.perigeeKm)} />
        <Stat k="apogee" v={km(info.apogeeKm)} />
      </div>
      <div className="section row">
        <span className="sub">{lit}</span>
        <span className="spacer" />
        <button className="btn sm" onClick={() => (follow ? useStore.getState().set({ follow: false }) : getController()?.flyTo(selected))}>
          {follow ? 'Stop following' : 'Follow'}
        </button>
        <button className="btn sm" onClick={() => getController()?.selectObject(null)} aria-label="Clear selection">
          ✕
        </button>
      </div>
    </div>
  );
}

export function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv stat">
      <span className="kv-k">{k}</span>
      <span className="kv-v">{v}</span>
    </div>
  );
}
