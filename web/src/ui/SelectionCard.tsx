import { getController, GROUP_HEX } from '../scene/SceneController';
import { useStore } from '../state/store';
import { fixed, int, lat, lon, regime } from './format';
import { GROUP_SHORT } from './groups';
import { Icon } from './icons';

export function SelectionCard() {
  const info = useStore((s) => s.selectedInfo);
  const selected = useStore((s) => s.selected);
  const follow = useStore((s) => s.follow);
  if (selected === null || !info) return null;

  const sunlit = info.sunlit > 0.001;
  const lit = info.sunlit >= 0.999 ? 'Sunlit' : !sunlit ? 'In Earth’s shadow' : `Penumbra, ${int(info.sunlit * 100)}% lit`;
  const age = info.epochAgeH < 48 ? `${fixed(info.epochAgeH, 0)} h` : `${fixed(info.epochAgeH / 24, 1)} d`;

  return (
    <section className="glass card selection" aria-label="Selected object" style={{ ['--c' as string]: GROUP_HEX[info.group] }}>
      <header className="sel-head">
        <span className="sel-mark" aria-hidden="true" />
        <div className="sel-title">
          <h2 title={info.name}>{info.name}</h2>
          <p>
            {GROUP_SHORT[info.group]} · {regime((info.perigeeKm + info.apogeeKm) / 2)} · #{info.norad}
          </p>
        </div>
        <button className="icon-btn" onClick={() => getController()?.selectObject(null)} aria-label="Clear selection" title="Clear (Esc)">
          <Icon name="x" size={15} />
        </button>
      </header>

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
          <dd>{fixed(info.periodMin, 1)} min</dd>
        </div>
        <div>
          <dt>Inclination</dt>
          <dd>{fixed(info.inclinationDeg, 1)}°</dd>
        </div>
        <div>
          <dt>Perigee</dt>
          <dd>{int(info.perigeeKm)} km</dd>
        </div>
        <div>
          <dt>Apogee</dt>
          <dd>{int(info.apogeeKm)} km</dd>
        </div>
        <div className="wide">
          <dt>Over</dt>
          <dd>
            {lat(info.latDeg)} {lon(info.lonDeg)}
          </dd>
        </div>
      </dl>

      <p className="sel-notes">
        <span className={sunlit ? 'sun' : undefined}>
          <Icon name={sunlit ? 'sun' : 'moon'} size={13} />
          {lit}
        </span>
        <span className={info.epochAgeH > 72 ? 'warn' : undefined} title="Age of the element set at the simulated time; SGP4 error grows with it">
          <Icon name="clock" size={13} />
          Elements {age} old
        </span>
      </p>

      <button
        className={`btn wide ${follow ? 'following' : 'primary'}`}
        onClick={() => (follow ? getController()?.stopFollowing() : getController()?.flyTo(selected))}
        title={follow ? 'Stop following and zoom out (Esc)' : 'Fly to it and ride along (F)'}
      >
        <Icon name={follow ? 'stop' : 'crosshair'} size={14} />
        {follow ? 'Stop following' : 'Follow'}
      </button>
    </section>
  );
}
