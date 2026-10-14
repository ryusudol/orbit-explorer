// A small stroke icon set (24 px grid, 1.75 px strokes) so the UI needs no icon
// dependency. Paths are drawn in currentColor and inherit the text color.

const PATHS = {
  play: <path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.5-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8Z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="6" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" />
      <rect x="14" y="4.5" width="4" height="15" rx="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  swap: <path d="M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  home: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.3 3.5 5.1 3.5 8.5s-1.1 6.2-3.5 8.5c-2.4-2.3-3.5-5.1-3.5-8.5s1.1-6.2 3.5-8.5Z" />
    </>
  ),
  rotate: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.5h-4.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  eyeOff: (
    <>
      <path d="M10 5.7c.6-.1 1.3-.2 2-.2 6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.4 3.2M6.6 6.6C4 8.3 2.5 12 2.5 12S6 18.5 12 18.5c1.8 0 3.3-.6 4.6-1.4" />
      <path d="M9.9 9.9a2.8 2.8 0 0 0 4 4M3.5 3.5l17 17" />
    </>
  ),
  route: (
    <>
      <circle cx="5.5" cy="18" r="2.2" />
      <circle cx="18.5" cy="6" r="2.2" />
      <path d="M7.5 17h6a3 3 0 0 0 0-6h-3a3 3 0 0 1 0-6h6" />
    </>
  ),
  radar: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <path d="m12 12 5.5-5.5" />
      <circle cx="16.3" cy="15.6" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.8 9.5h16.4M3.8 14.5h16.4M12 3.5c2.4 2.3 3.5 5.1 3.5 8.5s-1.1 6.2-3.5 8.5c-2.4-2.3-3.5-5.1-3.5-8.5s1.1-6.2 3.5-8.5Z" />
    </>
  ),
  layers: (
    <>
      <path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8 12 3.5Z" />
      <path d="m3.5 12 8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" />
    </>
  ),
  gauge: (
    <>
      <path d="M4.2 17.5a8.5 8.5 0 1 1 15.6 0" />
      <path d="m12 13 4-4.5" />
      <circle cx="12" cy="13.5" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  satellite: (
    <>
      <rect x="9.2" y="9.2" width="5.6" height="5.6" rx="1" transform="rotate(45 12 12)" />
      <path d="m8.1 8.1-3.6-3.6M4.5 8.1l3.6-3.6M15.9 15.9l3.6 3.6M19.5 15.9l-3.6 3.6" />
      <path d="M4.5 8.1 2.7 6.3l1.8-1.8M19.5 15.9l1.8 1.8-1.8 1.8" />
    </>
  ),
  crosshair: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
    </>
  ),
  locate: (
    <>
      <circle cx="12" cy="12" r="6.5" />
      <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="3.8" />
      <path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6.5 10h1M10.5 10h1M14.5 10h1M8 14h8" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.6v.1" />
    </>
  ),
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  menu: <path d="M4 7h16M4 12h16M4 17h10" />,
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M15 4v16" />
    </>
  ),
  bolt: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  link: <path d="M5 12h14M13 6l6 6-6 6" />,
  help: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.6 9.4a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.7M12 16.9v.1" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none" />,
  cone: (
    <>
      <path d="M12 4 5.5 18.5h13L12 4Z" />
      <ellipse cx="12" cy="18.5" rx="6.5" ry="1.8" />
    </>
  ),
  stars: (
    <>
      <path d="M12 3.5l1.6 4.4 4.4 1.6-4.4 1.6L12 15.5l-1.6-4.4L6 9.5l4.4-1.6L12 3.5Z" />
      <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" />
    </>
  ),
  mesh: (
    <>
      <circle cx="5" cy="7" r="1.6" />
      <circle cx="12" cy="4.5" r="1.6" />
      <circle cx="19" cy="8" r="1.6" />
      <circle cx="8" cy="16" r="1.6" />
      <circle cx="16.5" cy="17.5" r="1.6" />
      <path d="M6.5 6.5l4-1.5M13.5 5l4 2.4M5.6 8.6 7.4 14.4M9.6 16.4l5.3 1M18.4 9.5l-1.5 6.4M11.4 6l-2.6 8.4" />
    </>
  ),
  heat: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5c-3 3-3 14 0 17M12 3.5c3 3 3 14 0 17" opacity="0.5" />
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" opacity="0.6" />
    </>
  ),
  explore: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

/**
 * The Orbit Explorer mark, monochrome hairlines: a planet, an inclined orbit
 * that passes in front of it and fades where it runs behind, and a satellite
 * riding it. The planet's outline breaks where the orbit crosses over it.
 * Drawn in currentColor.
 */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg
      className="logo"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10.79 20.67A7 7 0 1 1 22.96 15.25M22.66 18.14A7 7 0 0 1 13.13 22.39" />
      <path d="M3.58 21.53A13.6 3.8 -24 0 1 7.85 16.16M21.57 10.05A13.6 3.8 -24 0 1 24.7 9.51" opacity="0.42" />
      <path d="M28.35 10.33A13.6 3.8 -24 1 1 3.58 21.53" />
      <circle cx="27.08" cy="9.6" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}
