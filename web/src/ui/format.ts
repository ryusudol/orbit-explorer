export const int = (n: number) => Math.round(n).toLocaleString('en-US');

export const fixed = (n: number, d = 1) => n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

export function compact(n: number): string {
  if (n >= 1e9) return `${fixed(n / 1e9, 1)}B`;
  if (n >= 1e6) return `${fixed(n / 1e6, 1)}M`;
  if (n >= 1e4) return `${fixed(n / 1e3, 1)}K`;
  return int(n);
}

export function ms(n: number): string {
  if (n >= 1000) return `${fixed(n / 1000, 2)} s`;
  if (n >= 100) return `${int(n)} ms`;
  if (n >= 10) return `${fixed(n, 1)} ms`;
  return `${fixed(n, 2)} ms`;
}

export function km(n: number): string {
  if (n < 1) return `${int(n * 1000)} m`;
  if (n < 10) return `${fixed(n, 2)} km`;
  return `${int(n)} km`;
}

export function relative(minutes: number): string {
  const sign = minutes < 0 ? '−' : '+';
  const m = Math.abs(minutes);
  if (m < 0.5) return 'now';
  if (m < 60) return `${sign}${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  return `${sign}${h} h ${String(Math.round(m - h * 60)).padStart(2, '0')} m`;
}

export const lat = (d: number) => `${Math.abs(d).toFixed(2)}°${d >= 0 ? 'N' : 'S'}`;
export const lon = (d: number) => `${Math.abs(d).toFixed(2)}°${d >= 0 ? 'E' : 'W'}`;

/** Orbital regime from mean altitude: LEO below 2,000 km, GEO near 35,786 km. */
export function regime(altKm: number): string {
  if (altKm < 2000) return 'LEO';
  if (Math.abs(altKm - 35786) < 600) return 'GEO';
  if (altKm < 35786) return 'MEO';
  return 'HEO';
}

/** "Wed, Oct 8, 2026" in UTC. */
export const utcDate = (ms: number) =>
  new Date(ms).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function duration(s: number): string {
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${fixed(s / 3600, 1)} h`;
  return `${fixed(s / 86400, 1)} d`;
}
