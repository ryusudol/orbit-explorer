// The other worlds in the interface: the world switcher, the caption shown in
// transit, the orbiter list, the relay timeline and the selected orbiter's card.

import { useEffect, useRef } from 'react';
import { getController } from '../scene/SceneController';
import { GROUP_HEX } from '../palette';
import { BODIES, BODY_ORDER, type BodyId } from '../sim/bodies';
import { distanceKm, RELAY_MIN_ELEV_DEG, type RelayRow } from '../sim/relay';
import { jdToMs } from '../sim/time';
import { useStore, type FleetRow, type Tab } from '../state/store';
import { Dot, Explain, Section, Segmented, Stat } from './common';
import { fixed, int, lat, lon } from './format';
import { Icon, type IconName } from './icons';

/** A world's swatch: what it looks like from afar. */
export const WORLD_HEX = Object.fromEntries(BODY_ORDER.map((b) => [b, BODIES[b].hex])) as Record<BodyId, string>;
export const SPACECRAFT_HEX = GROUP_HEX[2];
export const MOON_HEX = '#c9c4bc';
/** "the Moon", "Mars" */
export const the = (b: BodyId) => BODIES[b].the;

const EXPLORE = { id: 'explore' as Tab, label: 'Explore', icon: 'explore' as IconName, key: '1' };
const ORBITERS = { id: 'fleet' as Tab, label: 'Orbiters', icon: 'satellite' as IconName, key: '2' };
const RELAY = { id: 'relay' as Tab, label: 'Link to Earth', icon: 'link' as IconName, key: '3' };

export const MODES_BY_WORLD: Record<BodyId, { id: Tab; label: string; icon: IconName; key: string }[]> = Object.fromEntries(
  BODY_ORDER.map((b) => [
    b,
    b === 'earth'
      ? [
          EXPLORE,
          { id: 'route', label: 'Routing', icon: 'route', key: '2' },
          { id: 'conj', label: 'Conjunctions', icon: 'radar', key: '3' },
          { id: 'coverage', label: 'Coverage', icon: 'globe', key: '4' },
          { id: 'catalog', label: 'Catalog', icon: 'layers', key: '5' },
        ]
      : BODIES[b].sites.length
        ? [EXPLORE, ORBITERS, RELAY]
        : [EXPLORE, { ...ORBITERS, label: b === 'oort' ? 'Spacecraft' : 'Moons & craft' }],
  ]),
) as Record<BodyId, { id: Tab; label: string; icon: IconName; key: string }[]>;

/** Light time, as a person would say it: "1.28 s", "14 min 52 s", "23 h 41 min". */
export function lightTime(s: number): string {
  if (s < 60) return `${fixed(s, 2)} s`;
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    return `${h} h ${String(Math.round((s - h * 3600) / 60)).padStart(2, '0')} min`;
  }
  const m = Math.floor(s / 60);
  return `${m} min ${String(Math.round(s - m * 60)).padStart(2, '0')} s`;
}

// ------------------------------------------------------------------ switcher

/** Every world, as swatches (phones and narrow windows). The highlight moves at once; the camera takes a few seconds to follow. */
export function WorldSwitch() {
  const body = useStore((s) => s.body);
  const travel = useStore((s) => s.travel);
  const ref = useRef<HTMLDivElement>(null);
  // on a phone the strip scrolls: keep the world we're at (or heading to) in view
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-checked="true"]');
    if (el && ref.current && ref.current.scrollWidth > ref.current.clientWidth) el.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
  }, [body]);
  return (
    <div className="glass world-switch" role="radiogroup" aria-label="World" ref={ref}>
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

export const WORLD_KEY: Partial<Record<BodyId, string>> = { earth: 'E', moon: 'M', mars: '.' };

/** The destinations outward from the Sun, the Moon tucked under the Earth. */
const DESTINATIONS: BodyId[] = ['mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'oort'];

/** A moon or a region rather than a planet: drawn as a child or apart. */
const ROW_KIND: Partial<Record<BodyId, string>> = { moon: ' sub', oort: ' beyond' };

/** What orbits a world, in a few words. */
function summaryOf(body: BodyId, fleet: { kind: string; valid?: boolean; periodH?: number }[], total: number): string {
  if (body === 'earth') return total ? `${int(total)} objects in orbit` : '\u00a0';
  const list: { kind: string; valid?: boolean; periodH?: number }[] = fleet.length ? fleet : BODIES[body].orbiters;
  // spacecraft not yet in orbit (BepiColombo) are listed with no period
  const arriving = list.filter((o) => o.kind === 'spacecraft' && o.valid && o.periodH === 0).length;
  const craft = list.filter((o) => o.kind === 'spacecraft').length - arriving;
  const moons = list.length - craft - arriving;
  if (body === 'oort') return 'The edge of the solar system, and the two Voyagers on their way out';
  const parts = [craft ? `${craft} spacecraft` : '', moons ? `${int(moons)} ${moons === 1 ? 'moon' : 'moons'}` : ''].filter(Boolean);
  const coming = arriving ? `${arriving} spacecraft arriving` : '';
  if (!parts.length) return coming || 'Nothing in orbit';
  return `${parts.join(' and ')} in orbit${coming ? `, ${coming}` : ''}`;
}

/** Top left: the world you are at as the page's headline, and what is in orbit there. */
export function WorldTitle() {
  const body = useStore((s) => s.body);
  const travel = useStore((s) => s.travel);
  const counts = useStore((s) => s.groupCounts);
  const fleet = useStore((s) => s.fleet);
  const total = counts[0] + counts[1] + counts[2];
  return (
    <div className={`world-title${travel ? ' arriving' : ''}`}>
      <h1 className="world-h" key={body}>
        {BODIES[body].name}
      </h1>
      <p className="world-sub">{travel ? `Flying from ${the(travel.from)}` : summaryOf(body, travel ? [] : fleet, total)}</p>
    </div>
  );
}

/** Top right, while no panel is open: every world as a place to go, in one column, with how far away it is now. */
export function WorldGo() {
  const body = useStore((s) => s.body);
  const timeMs = useStore((s) => s.timeMs);
  const jd = timeMs / 86400000 + 2440587.5;
  return (
    <nav className="world-go" aria-label="Fly to">
      <div className="world-go-head">
        <span>Fly to</span>
        <span className="world-go-unit">From {body === 'earth' ? 'Earth' : the(body)}</span>
      </div>
      <div className="world-col">
        {DESTINATIONS.map((b) => {
          const here = b === body;
          const key = WORLD_KEY[b];
          const km = here || b === 'oort' ? 0 : distanceKm(body, b, jd);
          const far = b === 'oort' ? '2,000+ au' : here ? '' : nearKm(km);
          const hint = here ? `Back to the opening view of ${the(b)}` : `Fly to ${the(b)}${key ? ` (${key})` : ''}`;
          const light = km ? ` · light takes ${lightTime(km / 299_792.458)}` : '';
          return (
            <button
              key={b}
              className={`world-dest${ROW_KIND[b] ?? ''}`}
              aria-current={here ? 'location' : undefined}
              onClick={() => getController()?.travelTo(b)}
              title={hint + light}
              style={{ ['--w' as string]: WORLD_HEX[b] }}
            >
              <span className="world-dot" aria-hidden="true" />
              <span className="world-name">{BODIES[b].name}</span>
              <span className="world-km">{far}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/** "384,400 km", "54 million km", "4.35 billion km" */
export const farKm = (km: number) => (km > 2e9 ? `${fixed(km / 1e9, 2)} billion km` : km > 3e6 ? `${fixed(km / 1e6, 0)} million km` : `${int(km)} km`);

/** The same, short enough to sit in a column: "391,790 km", "45M km", "1.26B km" */
const nearKm = (km: number) => (km >= 1e9 ? `${fixed(km / 1e9, 2)}B km` : km > 3e6 ? `${fixed(km / 1e6, 0)}M km` : `${int(km)} km`);

/** While traveling: where to, and how far that is from home. */
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
  if (to === 'oort') return 'From 2,000 to 100,000 au from the Sun · light takes 12 days to 1.6 years';
  const c = getController();
  const lt = c?.lightTimeTo(to, timeMs);
  if (lt === undefined) return '';
  const km = lt * 299_792.458;
  return `${farKm(km)} from Earth · light takes ${lightTime(lt)}`;
}

// ------------------------------------------------------------------ legend

/** Away from the Earth, the key names what the dots are. */
export function WorldLegend() {
  const fleet = useStore((s) => s.fleet);
  const layers = useStore((s) => s.layers);
  const setLayer = useStore((s) => s.setLayer);
  const body = useStore((s) => s.body);
  const travel = useStore((s) => s.travel);
  // in flight the live rows are the old world's; count the destination's roster instead
  const list = fleet.length && !travel ? fleet : BODIES[body].orbiters;
  const craft = list.filter((f) => f.kind === 'spacecraft').length;
  const moons = list.filter((f) => f.kind === 'moon').length;
  return (
    <div className="legend-bar" role="group" aria-label="What is in orbit">
      {craft > 0 && (
        <span className="glass legend-chip static" style={{ ['--c' as string]: SPACECRAFT_HEX }}>
          <span className="legend-dot" />
          <span className="legend-name">Spacecraft</span>
          <span className="legend-count">{craft}</span>
        </span>
      )}
      {moons > 0 && (
        // a switch: hiding the moons leaves the spacecraft easy to find and pick
        <button
          className="glass legend-chip"
          role="switch"
          aria-checked={layers.moons}
          onClick={() => setLayer('moons', !layers.moons)}
          title={`${layers.moons ? 'Hide' : 'Show'} the moons`}
          style={{ ['--c' as string]: MOON_HEX }}
        >
          <span className="legend-dot" />
          <span className="legend-name">Moons</span>
          <span className="legend-count">{int(moons)}</span>
        </button>
      )}
      <button className="glass legend-chip" role="switch" aria-checked={layers.orbits} onClick={() => setLayer('orbits', !layers.orbits)} title={`${layers.orbits ? 'Hide' : 'Show'} every orbit`} style={{ ['--c' as string]: 'var(--ink)' }}>
        <span className="legend-ring" />
        <span className="legend-name">Orbits</span>
      </button>
      {body === 'venus' && (
        <button
          className="glass legend-chip"
          role="switch"
          aria-checked={layers.radar}
          onClick={() => setLayer('radar', !layers.radar)}
          title="See the surface as Magellan’s radar did, through the clouds"
          style={{ ['--c' as string]: '#e8a35a' }}
        >
          <span className="legend-ring" />
          <span className="legend-name">Radar surface</span>
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ orbiters

const distKm = (km: number) => (km >= 1e6 ? `${fixed(km / 1e6, km >= 1e7 ? 1 : 2)} M km` : `${int(km)} km`);

function FleetRows({ rows, body, empty }: { rows: { o: { id: number; name: string; kind: string; by: string }; row?: FleetRow }[]; body: BodyId; empty?: string }) {
  const orbiter = useStore((s) => s.orbiter);
  const travel = useStore((s) => s.travel);
  if (!rows.length) return empty ? <p className="fleet-empty">{empty}</p> : null;
  const R = BODIES[body].radiusKm;
  return (
    <div className="event-list fleet-list" role="list">
      {rows.map(({ o, row }) => {
        const sel = orbiter === o.id;
        const moon = o.kind === 'moon';
        // spacecraft: height above the surface (or cloud tops); moons: distance from the center
        const fig = !row?.valid ? '—' : body === 'oort' ? `${fixed((row.altKm + R) / 149_597_870.7, 1)} au` : moon ? distKm(row.altKm + R) : distKm(row.altKm);
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
            <Dot color={moon ? MOON_HEX : SPACECRAFT_HEX} />
            <span className="event-names">
              <span>{o.name}</span>
              <span className="muted">{o.by}</span>
            </span>
            <span className="event-figs">
              <span className="event-miss">{fig}</span>
              <span className="event-when">
                {row?.valid ? (body === 'oort' ? 'leaving' : row.periodH ? periodText(row.periodH) : 'arriving') : travel || !row ? '' : 'no trajectory'}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A long list, folded until asked for. */
function Fold({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <details className="fold">
      <summary>
        <span>{title}</span>
        <span className="fold-count">{int(count)}</span>
        <Icon name="chevronDown" size={14} className="explain-chevron" />
      </summary>
      {children}
    </details>
  );
}

export function FleetPanel() {
  const body = useStore((s) => s.body);
  const fleet = useStore((s) => s.fleet);
  const travel = useStore((s) => s.travel);
  const B = BODIES[body];
  // until the snapshot arrives (or in flight), the curated list stands in
  const live = !travel && fleet.length > 0;
  const byId = new Map(fleet.map((f) => [f.id, f]));
  const curated = B.orbiters.map((o) => ({ o, row: live ? byId.get(o.id) : undefined }));
  const extra = live ? fleet.filter((f) => !f.curated).map((f) => ({ o: f, row: f })) : [];
  const craft = curated.filter((x) => x.o.kind === 'spacecraft');
  const majors = curated.filter((x) => x.o.kind === 'moon');
  const inner = extra.filter((x) => x.row.periodH < 20 * 24);
  const outer = extra.filter((x) => x.row.periodH >= 20 * 24);
  const nCraft = craft.length;
  const nMoons = majors.length + extra.length;
  const nothing = !nCraft && !nMoons;
  return (
    <>
      <Section>
        <div className="hero">
          <span className="hero-v">{body === 'oort' || nCraft >= nMoons ? nCraft : int(nMoons)}</span>
          <span className="hero-u">
            {body === 'oort'
              ? 'spacecraft beyond the planets, on their way to the stars'
              : nothing
                ? `things in orbit around ${the(body)}`
                : nCraft >= nMoons
                  ? `${body === 'mercury' ? 'spacecraft arriving at' : 'working spacecraft around'} ${the(body)}${nMoons ? `, and its ${nMoons} moons` : ''}`
                  : `moons around ${the(body)}${nCraft ? `, and ${nCraft} spacecraft` : ''}`}
          </span>
        </div>
        {B.empty && <p className="fleet-empty">{B.empty}</p>}
      </Section>
      {nCraft > 0 && (
        <Section title="Spacecraft" aside={body === 'oort' ? 'from the Sun' : 'altitude now · period'}>
          <FleetRows rows={craft} body={body} />
        </Section>
      )}
      {majors.length > 0 && (
        <Section title={extra.length ? 'Major moons' : 'Moons'} aside="from the center · period">
          <FleetRows rows={majors} body={body} />
        </Section>
      )}
      {extra.length > 0 && (
        <Section title="Every other moon" aside="from the center · period">
          {inner.length > 0 && (
            <Fold title="Inner moons" count={inner.length}>
              <FleetRows rows={inner} body={body} />
            </Fold>
          )}
          {outer.length > 0 && (
            <Fold title="Irregular moons, captured" count={outer.length}>
              <FleetRows rows={outer} body={body} />
            </Fold>
          )}
        </Section>
      )}
      <Section>
        <Explain title="Where these orbits come from">
          {body === 'oort' ? (
            <>
              The Voyagers’ trajectories are the navigation team’s, as served by JPL Horizons: their whole paths since 1977, and their positions now. The Kuiper belt is every known
              trans-Neptunian object in JPL’s Small-Body Database, placed on its orbit. The Oort cloud itself is a model: nothing out there has ever been seen. It is inferred from
              the long-period comets that fall in from every direction.
            </>
          ) : (
            <>
              There are no TLEs beyond Earth, and SGP4 models Earth’s gravity and air. These are the missions’ own trajectories and JPL’s moon ephemerides, as served by JPL
              Horizons. Every deploy samples position and velocity every few minutes for the spacecraft and for every moon that goes around in under 20 days, and the scene
              interpolates between samples with cubic Hermite splines. The slow, distant irregular moons take months to years to go around, so each gets one set of orbital elements,
              moved by two-body motion. A mission’s prediction ends where its team last published one, so a spacecraft can vanish when you scrub far ahead.
            </>
          )}
        </Explain>
      </Section>
    </>
  );
}

const periodText = (h: number) =>
  !Number.isFinite(h) ? '' : h < 48 ? `${fixed(h, h < 10 ? 2 : 1)} h` : h < 24 * 730 ? `${fixed(h / 24, h < 24 * 100 ? 1 : 0)} d` : `${fixed(h / 24 / 365.25, 1)} yr`;

// ------------------------------------------------------------------ relay

const ROW_LABEL = (key: RelayRow['key'], body: BodyId) =>
  key === 'sun' ? 'Daylight' : key === 'earth' ? 'Earth, direct' : (BODIES[body].orbiters.find((o) => o.id === key)?.name ?? String(key));

export function RelayPanel() {
  const body = useStore((s) => s.body);
  const site = useStore((s) => s.site);
  const plan = useStore((s) => s.relay);
  const timeMs = useStore((s) => s.timeMs);
  const set = useStore((s) => s.set);
  if (body !== 'moon' && body !== 'mars') return null;
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
const dayMonth = (ms: number) => new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short', timeZone: 'UTC' });

// ------------------------------------------------------------------ selected orbiter

export function OrbiterCard() {
  const info = useStore((s) => s.orbiterInfo);
  const body = useStore((s) => s.body);
  const follow = useStore((s) => s.follow);
  if (!info || body === 'earth') return null;
  const o = BODIES[body].orbiters.find((x) => x.id === info.id);
  const color = info.kind === 'moon' ? MOON_HEX : SPACECRAFT_HEX;
  const lit = info.sunlit >= 0.999 ? 'Sunlit' : `In ${the(body)}’s shadow`;
  const day = (ms: number) => new Date(ms).toISOString().slice(5, 10);
  const window = info.source === 'track' ? `${day(info.spanMs[0])} – ${day(info.spanMs[1])}` : `elements of ${new Date(info.spanMs[0]).toISOString().slice(0, 10)}`;
  const moon = info.kind === 'moon';
  const R = BODIES[body].radiusKm;
  const out = body === 'oort';
  return (
    <section className="glass card selection" aria-label="Selected orbiter" style={{ ['--c' as string]: color }}>
      <header className="sel-head">
        <span className="sel-mark" aria-hidden="true" />
        <div className="sel-title">
          <h2 title={info.name}>{info.name}</h2>
          <p>{o?.by ?? info.by}</p>
        </div>
        <button className="icon-btn" onClick={() => getController()?.selectOrbiter(null)} aria-label="Clear selection" title="Clear (Esc)">
          <Icon name="x" size={15} />
        </button>
      </header>

      {info.valid ? (
        <>
          <div className="sel-hero">
            {out ? (
              <div>
                <span className="sel-v">{fixed(info.sunAu, 1)}</span>
                <span className="sel-u">au</span>
                <span className="sel-k">from the Sun</span>
              </div>
            ) : moon ? (
              <div>
                <span className="sel-v">{distKm(info.altKm + R).replace(' km', '')}</span>
                <span className="sel-u">km</span>
                <span className="sel-k">from {the(body)}’s center</span>
              </div>
            ) : (
              <div>
                <span className="sel-v">{int(info.altKm)}</span>
                <span className="sel-u">km</span>
                <span className="sel-k">altitude</span>
              </div>
            )}
            <div>
              <span className="sel-v">{fixed(info.speedKms, 2)}</span>
              <span className="sel-u">km/s</span>
              <span className="sel-k">{out ? 'from the Sun' : 'speed'}</span>
            </div>
          </div>
          {out ? (
            <dl className="sel-facts">
              <div>
                <dt>From Earth</dt>
                <dd>{farKm(info.earthKm)}</dd>
              </div>
              <div>
                <dt>Each year</dt>
                <dd>{fixed((info.speedKms * 365.25 * 86400) / 149_597_870.7, 2)} au</dd>
              </div>
            </dl>
          ) : !info.orbiting ? (
            // still arriving: no orbit yet, so no period or apsides; where it is headed instead
            <dl className="sel-facts">
              <div className="wide">
                <dt>Status</dt>
                <dd>{info.radialKms < 0 ? `Arriving · not yet in orbit` : 'Not in orbit'}</dd>
              </div>
              <div>
                <dt>{info.radialKms < 0 ? 'Closing at' : 'Receding at'}</dt>
                <dd>{fixed(Math.abs(info.radialKms), 2)} km/s</dd>
              </div>
              {Number.isFinite(info.closestKm) && (
                <div>
                  <dt>{info.closestAtEnd ? `By ${dayMonth(info.closestMs)}` : `Closest · ${dayMonth(info.closestMs)}`}</dt>
                  <dd>{int(info.closestKm - R)} km</dd>
                </div>
              )}
              <div className="wide">
                <dt>Over</dt>
                <dd>
                  {lat(info.latDeg)} {lon(info.lonDeg)}
                </dd>
              </div>
            </dl>
          ) : (
            <dl className="sel-facts">
              <div>
                <dt>Period</dt>
                <dd>{periodText(info.periodH) || '—'}</dd>
              </div>
              <div>
                <dt>Inclination</dt>
                <dd>{fixed(info.inclinationDeg, 1)}°</dd>
              </div>
              <div>
                <dt>{moon ? 'Closest' : 'Periapsis'}</dt>
                <dd>{Number.isFinite(info.periapsisKm) ? (moon ? distKm(info.periapsisKm + R) : `${int(info.periapsisKm)} km`) : '—'}</dd>
              </div>
              <div>
                <dt>{moon ? 'Farthest' : 'Apoapsis'}</dt>
                <dd>{Number.isFinite(info.apoapsisKm) ? (moon ? distKm(info.apoapsisKm + R) : `${int(info.apoapsisKm)} km`) : 'unbound'}</dd>
              </div>
              <div className="wide">
                <dt>Over</dt>
                <dd>
                  {lat(info.latDeg)} {lon(info.lonDeg)}
                </dd>
              </div>
            </dl>
          )}
        </>
      ) : (
        <p className="sel-empty">No published trajectory at this time. Its window runs {window} (UTC).</p>
      )}

      {(o?.note || info.note) && <p className="sel-about">{o?.note ?? info.note}</p>}

      <p className="sel-notes">
        {info.valid && !out && (
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
      <p className="sel-source">{info.source === 'track' ? `Trajectory: JPL Horizons · ${window}` : `Orbit: JPL Horizons · ${window}, two-body`}</p>
    </section>
  );
}
