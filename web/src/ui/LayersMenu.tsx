import { useEffect, useRef } from 'react';
import { useStore, type Layers } from '../state/store';
import { Segmented } from './common';
import { Icon, type IconName } from './icons';
import { the } from './Worlds';

const TILES: { key: keyof Layers; label: string; icon: IconName; hint: string }[] = [
  { key: 'links', label: 'Laser links', icon: 'mesh', hint: 'Starlink inter-satellite mesh' },
  { key: 'route', label: 'Route', icon: 'route', hint: 'Fastest path and packets' },
  { key: 'cones', label: 'Visibility cones', icon: 'cone', hint: 'Where a terminal sees 25°+' },
  { key: 'coverage', label: 'Coverage', icon: 'heat', hint: 'Satellites in view, heatmap' },
  { key: 'sky', label: 'Milky Way & Sun', icon: 'stars', hint: 'NASA sky map, true Sun' },
];
/** Around the Moon and Mars only the sky and the orbits apply. */
const WORLD_TILES: typeof TILES = [
  { key: 'orbits', label: 'All orbits', icon: 'route', hint: 'Every orbiter’s track, not just the selected one' },
  { key: 'sky', label: 'Milky Way & Sun', icon: 'stars', hint: 'NASA sky map, true Sun' },
];

/** Popover anchored under the Layers button; closes on outside click or Esc. */
export function LayersMenu({ onClose }: { onClose: () => void }) {
  const layers = useStore((s) => s.layers);
  const setLayer = useStore((s) => s.setLayer);
  const body = useStore((s) => s.body);
  const ref = useRef<HTMLDivElement>(null);
  const tiles = body === 'earth' ? TILES : WORLD_TILES;
  const name = body === 'earth' ? 'Earth' : body === 'moon' ? 'the Moon' : 'Mars';

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
          { v: 'earth', label: `Rotate with ${body === 'moon' ? 'Moon' : body === 'mars' ? 'Mars' : 'Earth'}` },
          { v: 'stars', label: 'Fixed to stars' },
        ]}
        onChange={(v) => setLayer('earthFixed', v === 'earth')}
      />
      <p className="popover-note">
        {body !== 'earth'
          ? layers.earthFixed
            ? `The camera turns with ${the(body)}: the ground stays put while orbiters sweep over it.`
            : `The camera holds still against the stars: orbital planes stay fixed and ${name} turns beneath them, once ${body === 'moon' ? 'a month' : 'a sol (24 h 37 min)'}.`
          : layers.earthFixed
            ? 'The camera turns with the planet: cities stay put while satellites sweep over them and the stars wheel past.'
            : 'The camera holds still against the stars: orbital planes stay fixed and the Earth spins beneath them, once a day.'}
      </p>
    </div>
  );
}
