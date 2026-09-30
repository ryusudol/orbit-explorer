import { useEffect, useRef, useState } from 'react';

export type Draw<T> = (root: HTMLDivElement, data: T, width: number) => void;

/**
 * A container React renders once and never touches again: the draw function
 * owns everything inside it. Redraws on data change and on resize.
 */
export function D3Chart<T>({ draw, data, height, label }: { draw: Draw<T>; data: T; height: number; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    setWidth(Math.floor(el.clientWidth));
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (ref.current && width > 0) draw(ref.current, data, width);
  }, [draw, data, width]);

  return <div className="chart" ref={ref} style={{ height }} role="img" aria-label={label} />;
}
