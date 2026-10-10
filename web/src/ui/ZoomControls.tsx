import { useState } from 'react';
import { getController } from '../scene/SceneController';
import { Icon } from './icons';

export function ZoomControls({ hidden, onToggleUi }: { hidden: boolean; onToggleUi: () => void }) {
  // the browser only asks for location when this is clicked
  const [locating, setLocating] = useState<'idle' | 'asking' | 'unavailable'>('idle');
  const locate = async () => {
    const c = getController();
    if (!c || locating === 'asking') return;
    setLocating('asking');
    setLocating((await c.goToMyLocation()) ? 'idle' : 'unavailable');
  };
  const locateTitle =
    locating === 'asking' ? 'Finding your location…' : locating === 'unavailable' ? 'Location unavailable: allow it in the browser’s site settings, then try again' : 'Go to my location';

  return (
    <div className="zoom-controls">
      <div className="glass control-stack" role="group" aria-label="Zoom">
        <button className="icon-btn" onClick={() => getController()?.zoomBy(0.7)} aria-label="Zoom in" title="Zoom in">
          <Icon name="plus" size={16} />
        </button>
        <button className="icon-btn" onClick={() => getController()?.zoomBy(1 / 0.7)} aria-label="Zoom out" title="Zoom out">
          <Icon name="minus" size={16} />
        </button>
        <button className="icon-btn" onClick={() => getController()?.resetView()} aria-label="Reset view" title="Reset view (R)">
          <Icon name="home" size={16} />
        </button>
        <button
          className={`icon-btn ${locating === 'unavailable' ? 'unavailable' : ''}`}
          onClick={locate}
          aria-busy={locating === 'asking'}
          aria-label={locateTitle}
          title={locateTitle}
        >
          <Icon name="locate" size={16} />
        </button>
      </div>
      <button className="glass round-btn" onClick={onToggleUi} aria-pressed={hidden} aria-label={hidden ? 'Show interface' : 'Hide interface'} title={`${hidden ? 'Show' : 'Hide'} interface (H)`}>
        <Icon name={hidden ? 'eye' : 'eyeOff'} size={16} />
      </button>
    </div>
  );
}
