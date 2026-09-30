import { useStore } from '../state/store';

export function Loader() {
  const phase = useStore((s) => s.phase);
  const step = useStore((s) => s.loadingStep);
  const error = useStore((s) => s.error);
  if (phase === 'ready') return null;
  return (
    <div className="loader" role="status" aria-live="polite">
      {phase === 'error' ? (
        <div className="panel error-box">
          <div className="h">Can't start</div>
          <div>{error}</div>
          <p className="note">
            Orbit Explorer needs a browser with WebGPU or WebGL 2, and module workers. Recent Chrome, Edge, Safari and Firefox all qualify.
          </p>
        </div>
      ) : (
        <div className="loader-box">
          <div className="brand-name">ORBIT EXPLORER</div>
          <div className="loader-step">{step}…</div>
          <div className="loader-bar" />
        </div>
      )}
    </div>
  );
}
