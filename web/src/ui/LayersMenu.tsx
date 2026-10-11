import { useEffect, useRef } from 'react';
import { useStore, type Layers } from '../state/store';
import { Segmented } from './common';
import { Icon, type IconName } from './icons';
import { the } from './Worlds';
import { BODIES } from '../sim/bodies';

const TILES: { key: keyof Layers; label: string; icon: IconName; hint: string }[] = [
  { key: 'links', label: 'Laser links', icon: 'mesh', hint: 'Starlink inter-satellite mesh' },
  { key: 'route', label: 'Route', icon: 'route', hint: 'Fastest path and packets' },
  { key: 'cones', label: 'Visibility cones', icon: 'cone', hint: 'Where a terminal sees 25°+' },
  { key: 'coverage', label: 'Coverage', icon: 'heat', hint: 'Satellites in view, heatmap' },
  { key: 'sky', label: 'Milky Way & Sun', icon: 'stars', hint: 'NASA sky map, true Sun' },
];
/** Away from the Earth only the sky and the orbits apply (and at Venus, its radar map). */
const WORLD_TILES: typeof TILES = [
  { key: 'orbits', label: 'All orbits', icon: 'route', hint: 'Every orbiter’s track, and the planets’ from afar' },
  { key: 'sky', label: 'Milky Way & Sun', icon: 'stars', hint: 'NASA sky map, true Sun' },
];
const MOONS_TILE: (typeof TILES)[number] = { key: 'moons', label: 'Moons', icon: 'moon', hint: 'Hide them to pick out the spacecraft' };
const VENUS_TILE: (typeof TILES)[number] = { key: 'radar', label: 'Radar surface', icon: 'eye', hint: 'Magellan’s map, under the clouds' };

/** Popover anchored under the Layers button; closes on outside click or Esc. */
export function LayersMenu({ onClose }: { onClose: () => void }) {
  const layers = useStore((s) => s.layers);
  const setLayer = useStore((s) => s.setLayer);
  const body = useStore((s) => s.body);
  const ref = useRef<HTMLDivElement>(null);
  const hasMoons = BODIES[body].orbiters.some((o) => o.kind === 'moon');
  const tiles = body === 'earth' ? TILES : body === 'venus' ? [...WORLD_TILES, VENUS_TILE] : hasMoons ? [WORLD_TILES[0], MOONS_TILE, WORLD_TILES[1]] : WORLD_TILES;
  const B = BODIES[body];

  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!ref.current?.contains(t) && !t.closest('[aria-haspopup="dialog"]')) onClose();
    };
    window.addEventListener('pointerdown', down);
    return () => window.removeEventListener('pointerdown', down);
  }, [onClose]);

  return (
    <div className="glass popover layers-menu" role="dialog" aria-label="Layers and view" ref={ref}>
      <div className="popover-label">Layers</div>
      <div className="layer-tiles">
        {tiles.map((t) => (
          <button key={t.key} className="layer-tile" role="switch" aria-checked={layers[t.key]} onClick={() => setLayer(t.key, !layers[t.key])} title={t.hint}>
            <span className="layer-icon">
              <Icon name={t.icon} size={18} />
            </span>
            <span className="layer-text">
              <span className="layer-name">{t.label}</span>
              <span className="layer-hint">{t.hint}</span>
            </span>
            <span className="layer-check" aria-hidden="true" />
          </button>
        ))}
      </div>

      <div className="popover-label">View</div>
      <Segmented
        label="Reference frame"
        value={layers.earthFixed ? 'earth' : 'stars'}
        options={[
          { v: 'earth', label: body === 'oort' ? 'Turn with the stars' : `Rotate with ${B.name}` },
          { v: 'stars', label: 'Fixed to stars' },
        ]}
        onChange={(v) => setLayer('earthFixed', v === 'earth')}
      />
      <p className="popover-note">
        {body === 'oort'
          ? 'Out here nothing turns: the view is fixed to the stars either way.'
          : body !== 'earth'
            ? layers.earthFixed
              ? `The camera turns with ${the(body)}: the ${B.kind === 'planet' && ['jupiter', 'saturn', 'uranus', 'neptune'].includes(body) ? 'cloud tops stay' : 'ground stays'} put while orbiters sweep over ${B.kind === 'planet' && ['jupiter', 'saturn', 'uranus', 'neptune'].includes(body) ? 'them' : 'it'}.`
              : `The camera holds still against the stars: orbital planes stay fixed and ${the(body)} turns beneath them, ${B.turns ?? ''}.`
          : layers.earthFixed
            ? 'The camera turns with the planet: cities stay put while satellites sweep over them and the stars wheel past.'
            : 'The camera holds still against the stars: orbital planes stay fixed and the Earth spins beneath them, once a day.'}
      </p>
    </div>
  );
}
