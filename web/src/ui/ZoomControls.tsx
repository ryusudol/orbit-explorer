import { getController } from '../scene/SceneController';
import { Icon } from './icons';

export function ZoomControls({ hidden, onToggleUi }: { hidden: boolean; onToggleUi: () => void }) {
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
      </div>
      <button className="glass round-btn" onClick={onToggleUi} aria-pressed={hidden} aria-label={hidden ? 'Show interface' : 'Hide interface'} title={`${hidden ? 'Show' : 'Hide'} interface (H)`}>
        <Icon name={hidden ? 'eye' : 'eyeOff'} size={16} />
      </button>
    </div>
  );
}
