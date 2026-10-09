// The Moon and Mars in the interface: the world switcher, the caption shown in
// transit, the orbiter list, the relay timeline and the selected orbiter's card.

import { getController } from '../scene/SceneController';
import { GROUP_HEX } from '../palette';
import { BODIES, BODY_ORDER, type BodyId } from '../sim/bodies';
import { distanceKm, RELAY_MIN_ELEV_DEG, type RelayRow } from '../sim/relay';
import { jdToMs } from '../sim/time';
import { useStore, type Tab } from '../state/store';
import { Dot, Explain, Section, Segmented, Stat } from './common';
import { fixed, int, lat, lon } from './format';
import { Icon, type IconName } from './icons';

/** A world's swatch: what it looks like from afar. */
export const WORLD_HEX: Record<BodyId, string> = { earth: '#6fa8ff', moon: '#c9c4bc', mars: '#e07a4f' };
export const SPACECRAFT_HEX = GROUP_HEX[2];
export const MOON_HEX = '#c9c4bc';
/** "the Moon", "Mars" */
export const the = (b: BodyId) => (b === 'mars' ? 'Mars' : `the ${BODIES[b].name}`);

export const MODES_BY_WORLD: Record<BodyId, { id: Tab; label: string; icon: IconName; key: string }[]> = {
  earth: [
    { id: 'explore', label: 'Explore', icon: 'explore', key: '1' },
    { id: 'route', label: 'Routing', icon: 'route', key: '2' },
    { id: 'conj', label: 'Conjunctions', icon: 'radar', key: '3' },
    { id: 'coverage', label: 'Coverage', icon: 'globe', key: '4' },
    { id: 'catalog', label: 'Catalogue', icon: 'layers', key: '5' },
  ],
  moon: [
    { id: 'explore', label: 'Explore', icon: 'explore', key: '1' },
    { id: 'fleet', label: 'Orbiters', icon: 'satellite', key: '2' },
    { id: 'relay', label: 'Link to Earth', icon: 'link', key: '3' },
  ],
  mars: [
    { id: 'explore', label: 'Explore', icon: 'explore', key: '1' },
    { id: 'fleet', label: 'Orbiters', icon: 'satellite', key: '2' },
    { id: 'relay', label: 'Link to Earth', icon: 'link', key: '3' },
  ],
};

/** Light time, as a person would say it: "1.28 s", "14 min 52 s". */
export function lightTime(s: number): string {
  if (s < 60) return `${fixed(s, 2)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(Math.round(s - m * 60)).padStart(2, '0')} s`;
}

// ------------------------------------------------------------------ switcher

/** Earth · Moon · Mars. The highlight moves at once; the camera takes a few seconds to follow. */
export function WorldSwitch() {
  const body = useStore((s) => s.body);
  const travel = useStore((s) => s.travel);
  return (
    <div className="glass world-switch" role="radiogroup" aria-label="World">
      {BODY_ORDER.map((b) => (
        <button
          key={b}
          role="radio"
          aria-checked={b === body}
          className={`world${travel?.to === b ? ' arriving' : ''}`}
          onClick={() => getController()?.travelTo(b)}
          title={b === body ? `Back to the opening view of ${the(b)}` : `Fly to ${the(b)}`}
          style={{ ['--w' as string]: WORLD_HEX[b] }}
        >
          <span className="world-dot" aria-hidden="true" />
          <span className="world-name">{BODIES[b].name}</span>
        </button>
      ))}
    </div>
  );
}

const WORLD_KEY: Record<BodyId, string> = { earth: 'E', moon: 'M', mars: '.' };

/**
 * Top left: the world you are at as the page's headline, what is in orbit
 * there, and the other worlds as places to go, with how far away they are now.
 */
export function WorldTitle() {
  const body = useStore((s) => s.body);
  const travel = useStore((s) => s.travel);
  const timeMs = useStore((s) => s.timeMs);
  const counts = useStore((s) => s.groupCounts);
  const jd = timeMs / 86400000 + 2440587.5;
  const total = counts[0] + counts[1] + counts[2];
  const craft = BODIES[body].orbiters.filter((o) => o.kind === 'spacecraft').length;
  const moons = BODIES[body].orbiters.length - craft;
  const summary =
    body === 'earth' ? (total ? `${int(total)} objects in orbit` : '\u00a0') : `${craft} spacecraft${moons ? ` and ${moons} moons` : ''} in orbit`;
  return (
    <div className={`world-title${travel ? ' arriving' : ''}`}>
      <h1 className="world-h" key={body}>
        {BODIES[body].name}
      </h1>
      <p className="world-sub">{travel ? `Flying from ${the(travel.from)}` : summary}</p>
      <nav className="world-go" aria-label="Fly to">
        {BODY_ORDER.filter((b) => b !== body).map((b) => (
          <button
            key={b}
            className="world-dest"
            onClick={() => getController()?.travelTo(b)}
            title={`Fly to ${the(b)} (${WORLD_KEY[b]})`}
            style={{ ['--w' as string]: WORLD_HEX[b] }}
          >
            <span className="world-dot" aria-hidden="true" />
            <span className="world-name">{BODIES[b].name}</span>
            <span className="world-km">{farKm(distanceKm(body, b, jd))}</span>
            <Icon name="chevronRight" size={12} />
          </button>
        ))}
      </nav>
    </div>
  );
}

const farKm = (km: number) => (km > 3e6 ? `${fixed(km / 1e6, 0)} million km` : `${int(km)} km`);

/** While travelling: where to, and how far that is from home. */
export function TravelCaption() {
  const travel = useStore((s) => s.travel);
  const timeMs = useStore((s) => s.timeMs);
  if (!travel) return null;
  const to = travel.to;
  return (
    <div className="travel-caption" role="status" key={`${travel.from}-${to}`}>
      <span className="travel-k">
        {BODIES[travel.from].name} <Icon name="chevronRight" size={12} /> {BODIES[to].name}
      </span>
      <span className="travel-v">{to === 'earth' ? 'Home' : BODIES[to].name}</span>
      {to !== 'earth' && <span className="travel-note">{distanceNote(to, timeMs)}</span>}
    </div>
  );
}

function distanceNote(to: BodyId, timeMs: number): string {
  const c = getController();
  const lt = c?.lightTimeTo(to, timeMs);
  if (lt === undefined) return '';
  const km = lt * 299_792.458;
  return `${farKm(km)} from Earth · light takes ${lightTime(lt)}`;
}

// ------------------------------------------------------------------ legend

/** At the Moon or Mars, the key names what the dots are. */
export function WorldLegend() {
  const fleet = useStore((s) => s.fleet);
  const layers = useStore((s) => s.layers);
  const setLayer = useStore((s) => s.setLayer);
  const body = useStore((s) => s.body);
  // in flight the live rows are empty; count the destination's roster instead
  const list = fleet.length ? fleet : BODIES[body].orbiters;
  const craft = list.filter((f) => f.kind === 'spacecraft').length;
  const moons = list.filter((f) => f.kind === 'moon').length;
  return (
    <div className="legend-bar" role="group" aria-label="What is in orbit">
      <span className="glass legend-chip static" style={{ ['--c' as string]: SPACECRAFT_HEX }}>
        <span className="legend-dot" />
        <span className="legend-name">Spacecraft</span>
        <span className="legend-count">{craft}</span>
      </span>
      {moons > 0 && (
        <span className="glass legend-chip static" style={{ ['--c' as string]: MOON_HEX }}>
          <span className="legend-dot" />
          <span className="legend-name">Moons</span>
          <span className="legend-count">{moons}</span>
        </span>
      )}
      <button className="glass legend-chip" role="switch" aria-checked={layers.orbits} onClick={() => setLayer('orbits', !layers.orbits)} title={`${layers.orbits ? 'Hide' : 'Show'} every orbit`} style={{ ['--c' as string]: 'var(--ink)' }}>
        <span className="legend-ring" />
        <span className="legend-name">Orbits</span>
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ orbiters

export function FleetPanel() {
  const body = useStore((s) => s.body);
  const fleet = useStore((s) => s.fleet);
  const orbiter = useStore((s) => s.orbiter);
  const travel = useStore((s) => s.travel);
  const list = BODIES[body].orbiters;
  const craft = list.filter((o) => o.kind === 'spacecraft').length;
  const moons = list.length - craft;
  return (
    <>
      <Section>
        <div className="hero">
          <span className="hero-v">{craft}</span>
          <span className="hero-u">
            working spacecraft around {the(body)}
            {moons ? `, and its ${moons} moons` : ''}
          </span>
        </div>
      </Section>
      <Section title="In orbit" aside="altitude now · period">
        <div className="event-list fleet-list" role="list">
          {list.map((o) => {
            const row = fleet.find((f) => f.id === o.id);
            const sel = orbiter === o.id;
            return (
              <button
                key={o.id}
                role="listitem"
                className="event fleet-row"
                aria-pressed={sel}
                disabled={!!travel || !row?.valid}
                onClick={() => getController()?.selectOrbiter(sel ? null : o.id, !sel)}
                title={row?.valid ? `Fly to ${o.name}` : 'No published trajectory for this time'}
              >
                <Dot color={o.kind === 'moon' ? MOON_HEX : SPACECRAFT_HEX} />
                <span className="event-names">
                  <span>{o.name}</span>
                  <span className="muted">{o.by}</span>
                </span>
                <span className="event-figs">
                  <span className="event-miss">{row?.valid ? `${int(row.altKm)} km` : '—'}</span>
                  <span className="event-when">{row?.valid ? periodText(row.periodH) : travel || !row ? '' : 'no trajectory'}</span>
                </span>
              </button>
            );
          })}
        </div>
        <Explain title="Where these orbits come from">
          There are no TLEs beyond Earth, and SGP4 models Earth’s gravity and air. These are the missions’ own trajectories, reconstructed and
          predicted by their navigation teams, as served by JPL Horizons. Every deploy, every 6 hours, samples position and velocity every 3 minutes (5–10 for the
          slow ones) and the scene interpolates between samples with cubic Hermite splines, under 50 m off. A mission’s prediction ends where its
          team last published one, so a dot can vanish when you scrub far ahead.
        </Explain>
      </Section>
    </>
  );
}

const periodText = (h: number) => (h < 48 ? `${fixed(h, h < 10 ? 2 : 1)} h` : `${fixed(h / 24, 1)} d`);

// ------------------------------------------------------------------ relay

const ROW_LABEL = (key: RelayRow['key'], body: BodyId) =>
  key === 'sun' ? 'Daylight' : key === 'earth' ? 'Earth, direct' : (BODIES[body].orbiters.find((o) => o.id === key)?.name ?? String(key));

export function RelayPanel() {
  const body = useStore((s) => s.body);
  const site = useStore((s) => s.site);
  const plan = useStore((s) => s.relay);
  const timeMs = useStore((s) => s.timeMs);
  const set = useStore((s) => s.set);
  if (body === 'earth') return null;
  const sites = BODIES[body].sites;
  const chosen = sites.find((x) => x.id === site[body]) ?? sites[0];
  const current = plan && plan.body === body && plan.site === chosen.id ? plan : null;

  const t0 = current ? jdToMs(current.jd0) : timeMs;
  const t1 = current ? jdToMs(current.jd1) : timeMs + 864e5;
  const x = (ms: number) => Math.max(0, Math.min(1, (ms - t0) / (t1 - t0))) * 100;
  const earth = current?.rows.find((r) => r.key === 'earth');
  const earthUp = (earth?.now ?? -1) > 0;
  const relays = current?.rows.filter((r) => typeof r.key === 'number') ?? [];
  const next = relays
    .flatMap((r) => r.passes.map((p) => ({ r, p })))
    .filter(({ p }) => jdToMs(p.end) > timeMs)
    .sort((a, b) => a.p.start - b.p.start)[0];
  const nextIn = next ? (jdToMs(next.p.start) - timeMs) / 60000 : null;
  const nowX = x(timeMs);

  return (
    <>
      <Section>
        <div className="field">
          <span className="field-k">Site</span>
          <Segmented label="Surface site" value={chosen.id} options={sites.map((s) => ({ v: s.id, label: s.short, title: `${s.name}: ${s.what}` }))} onChange={(v) => set({ site: { ...site, [body]: v }, relay: null })} />
        </div>
        <p className="site-note">
          {chosen.name} · {chosen.what} · {lat(chosen.lat)} {lon(chosen.lon)}
        </p>
        <div className="hero">
          <span className="hero-v">{current ? lightTime(current.lightTimeS) : '—'}</span>
          <span className="hero-u">for a signal to cross from Earth, one way</span>
        </div>
        <div className="metrics">
          <Stat k="Earth" v={current ? (earthUp ? `${fixed(earth!.now, 0)}°` : 'Below') : '—'} tone={current ? (earthUp ? 'good' : 'bad') : undefined} />
          <Stat
            k="Next pass"
            v={nextIn === null ? '—' : nextIn <= 0 ? 'Now' : nextIn < 60 ? `${Math.round(nextIn)}` : `${fixed(nextIn / 60, 1)}`}
            unit={nextIn === null || nextIn <= 0 ? undefined : nextIn < 60 ? 'min' : 'h'}
          />
          <Stat k="Local time" v={current ? clock(current.localSolarH) : '—'} />
        </div>
      </Section>

      <Section title="Next 24 hours" aside={`passes above ${RELAY_MIN_ELEV_DEG}°`}>
        <div className="relay-chart" role="img" aria-label={`When the Earth and each orbiter are above the horizon at ${chosen.name} over the next day`}>
          {current?.rows.map((r) => (
            <div key={String(r.key)} className={`relay-row ${r.key === 'sun' ? 'sun' : r.key === 'earth' ? 'earth' : 'craft'}`}>
              <span className="relay-k">{ROW_LABEL(r.key, body)}</span>
              <span className="relay-track">
                {r.passes.map((p, i) => {
                  const a = x(jdToMs(p.start)), b = x(jdToMs(p.end));
                  if (b <= 0 || a >= 100) return null;
                  return (
                    <span
                      key={i}
                      className="relay-pass"
                      style={{ left: `${a}%`, width: `${Math.max(0.5, b - a)}%`, opacity: r.key === 'sun' || r.key === 'earth' ? undefined : 0.45 + 0.55 * Math.min(1, p.peak / 60) }}
                      title={`${ROW_LABEL(r.key, body)}: ${hm(jdToMs(p.start))}–${hm(jdToMs(p.end))} UTC, highest ${fixed(p.peak, 0)}°`}
                    />
                  );
                })}
              </span>
            </div>
          ))}
          <div className="relay-axis" aria-hidden="true">
            {[0, 6, 12, 18, 24].map((h) => (
              <span key={h} style={{ left: `${(h / 24) * 100}%` }}>
                {h === 0 ? 'Now' : `+${h} h`}
              </span>
            ))}
          </div>
          {current && <span className="relay-now" style={{ left: `calc(122px + (100% - 122px) * ${nowX / 100})` }} aria-hidden="true" />}
        </div>
        <Explain>
          {body === 'mars' ? (
            <>
              A rover can talk to Earth directly while the Earth is up, but slowly: a few hundred bits per second from its high-gain antenna. Most of
              its data goes up to an orbiter in a pass of a few minutes, at up to 2 Mbit/s, and the orbiter forwards it on its own large dish. Each bar
              is a time the Earth or an orbiter is above the site’s horizon ({RELAY_MIN_ELEV_DEG}° for orbiters), from JPL trajectories and the IAU
              rotation model of Mars; brighter bars pass higher.
            </>
          ) : (
            <>
              The Moon keeps one face to the Earth, so on the near side the Earth never sets, and on the far side it never rises: Chang’e 4 talks
              through the Queqiao relay satellites, parked beyond the Moon. Near the poles the Earth skims the horizon, rising and setting with the Moon’s
              monthly libration, which is why polar landers need relays too. Bars mark when the Earth or an orbiter is above the site’s horizon (
              {RELAY_MIN_ELEV_DEG}° for orbiters).
            </>
          )}
        </Explain>
      </Section>
    </>
  );
}

const clock = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.floor((h % 1) * 60)).padStart(2, '0')}`;
const hm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

// ------------------------------------------------------------------ selected orbiter

export function OrbiterCard() {
  const info = useStore((s) => s.orbiterInfo);
  const body = useStore((s) => s.body);
  const follow = useStore((s) => s.follow);
  if (!info || body === 'earth') return null;
  const o = BODIES[body].orbiters.find((x) => x.id === info.id);
  const color = info.kind === 'moon' ? MOON_HEX : SPACECRAFT_HEX;
  const lit = info.sunlit >= 0.999 ? 'Sunlit' : `In ${the(body)}’s shadow`;
  const window = `${new Date(info.spanMs[0]).toISOString().slice(5, 10)} – ${new Date(info.spanMs[1]).toISOString().slice(5, 10)}`;
  return (
    <section className="glass card selection" aria-label="Selected orbiter" style={{ ['--c' as string]: color }}>
      <header className="sel-head">
        <span className="sel-mark" aria-hidden="true" />
        <div className="sel-title">
          <h2 title={info.name}>{info.name}</h2>
          <p>{o?.by}</p>
        </div>
        <button className="icon-btn" onClick={() => getController()?.selectOrbiter(null)} aria-label="Clear selection" title="Clear (Esc)">
          <Icon name="x" size={15} />
        </button>
      </header>

      {info.valid ? (
        <>
          <div className="sel-hero">
            <div>
              <span className="sel-v">{int(info.altKm)}</span>
              <span className="sel-u">km</span>
              <span className="sel-k">altitude</span>
            </div>
            <div>
              <span className="sel-v">{fixed(info.speedKms, 2)}</span>
              <span className="sel-u">km/s</span>
              <span className="sel-k">speed</span>
            </div>
          </div>
          <dl className="sel-facts">
            <div>
              <dt>Period</dt>
              <dd>{periodText(info.periodH)}</dd>
            </div>
            <div>
              <dt>Inclination</dt>
              <dd>{fixed(info.inclinationDeg, 1)}°</dd>
            </div>
            <div>
              <dt>Periapsis</dt>
              <dd>{int(info.periapsisKm)} km</dd>
            </div>
            <div>
              <dt>Apoapsis</dt>
              <dd>{int(info.apoapsisKm)} km</dd>
            </div>
            <div className="wide">
              <dt>Over</dt>
              <dd>
                {lat(info.latDeg)} {lon(info.lonDeg)}
              </dd>
            </div>
          </dl>
        </>
      ) : (
        <p className="sel-empty">No published trajectory at this time. Its window runs {window} (UTC).</p>
      )}

      {o && <p className="sel-about">{o.note}</p>}

      <p className="sel-notes">
        {info.valid && (
          <span className={info.sunlit > 0.5 ? 'sun' : undefined}>
            <Icon name={info.sunlit > 0.5 ? 'sun' : 'moon'} size={13} />
            {lit}
          </span>
        )}
        <span title="One-way light time from Earth">
          <Icon name="clock" size={13} />
          {lightTime(info.lightTimeS)} from Earth
        </span>
      </p>

      {info.valid && (
        <button
          className={`btn wide ${follow ? 'following' : 'primary'}`}
          onClick={() => (follow ? getController()?.stopFollowing() : getController()?.flyToOrbiter(info.id))}
          title={follow ? 'Stop following and zoom out (Esc)' : 'Fly to it and ride along (F)'}
        >
          <Icon name={follow ? 'stop' : 'crosshair'} size={14} />
          {follow ? 'Stop following' : 'Follow'}
        </button>
      )}
      <p className="sel-source">Trajectory: JPL Horizons · {window}</p>
    </section>
  );
}
