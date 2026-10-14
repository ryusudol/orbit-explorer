import { GROUP_HEX } from '../scene/SceneController';
import { useStore } from '../state/store';
import { int } from './format';
import { GROUP_LAYER, GROUP_SHORT, LEGEND_ORDER } from './groups';
import { WorldLegend } from './Worlds';

/** The color key is also the filter: each chip shows or hides its group. */
export function Legend() {
  const layers = useStore((s) => s.layers);
  const setLayer = useStore((s) => s.setLayer);
  const counts = useStore((s) => s.groupCounts);
  const body = useStore((s) => s.body);
  if (body !== 'earth') return <WorldLegend />;
  return (
    <div className="legend-bar" role="group" aria-label="Object groups">
      {LEGEND_ORDER.map((g) => {
        const on = layers[GROUP_LAYER[g]];
        return (
          <button
            key={g}
            className="glass legend-chip"
            role="switch"
            aria-checked={on}
            onClick={() => setLayer(GROUP_LAYER[g], !on)}
            title={`${on ? 'Hide' : 'Show'} ${GROUP_SHORT[g].toLowerCase()}`}
            style={{ ['--c' as string]: GROUP_HEX[g] }}
          >
            <span className="legend-dot" />
            <span className="legend-name">{GROUP_SHORT[g]}</span>
            <span className="legend-count">{int(counts[g])}</span>
          </button>
        );
      })}
    </div>
  );
}
