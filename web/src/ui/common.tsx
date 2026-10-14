import type { ReactNode } from 'react';
import { Icon } from './icons';

/** A labeled figure. `unit` is set smaller beside the value. */
export function Stat({ k, v, unit, tone }: { k: string; v: string; unit?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="stat">
      <span className="stat-k">{k}</span>
      <span className={`stat-v${tone ? ` ${tone}` : ''}`}>
        {v}
        {unit && <span className="stat-u">{unit}</span>}
      </span>
    </div>
  );
}

/** Splits "12.3 ms" into value and unit so figures can share one style. */
export function StatAuto({ k, v }: { k: string; v: string }) {
  const m = /^([−+\-]?[\d.,]+)\s?(.*)$/.exec(v);
  return m ? <Stat k={k} v={m[1]} unit={m[2] || undefined} /> : <Stat k={k} v={v} />;
}

export function Section({ title, aside, children, className }: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={className ? `section ${className}` : 'section'}>
      {(title || aside) && (
        <header className="section-head">
          {title && <h2 className="section-title">{title}</h2>}
          {aside && <span className="section-aside">{aside}</span>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Switch({ on, onChange, label, children, hint }: { on: boolean; onChange: (v: boolean) => void; label?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <button className="switch-row" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <span className="switch-label">{children}</span>
      {hint !== undefined && <span className="switch-hint">{hint}</span>}
      <span className="switch" aria-hidden="true" />
    </button>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  size,
}: {
  value: T;
  options: { v: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  label: string;
  size?: 'sm';
}) {
  return (
    <div className={`segmented${size ? ` ${size}` : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.v)} role="radio" aria-checked={o.v === value} title={o.title} onClick={() => onChange(o.v)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Method notes: present but out of the way. */
export function Explain({ title = 'How it works', children }: { title?: string; children: ReactNode }) {
  return (
    <details className="explain">
      <summary>
        <Icon name="info" size={14} />
        {title}
        <Icon name="chevronDown" size={14} className="explain-chevron" />
      </summary>
      <div className="explain-body">{children}</div>
    </details>
  );
}

export function Dot({ color, size }: { color: string; size?: number }) {
  return <span className="dot" style={{ background: color, color, ...(size ? { width: size, height: size } : null) }} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
