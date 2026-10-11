// The worlds you can fly to, what orbits them and where on them we listen.
// Trajectories come from JPL Horizons (data/fetch-ephemeris.mjs); the ids here
// are Horizons ids. Only the notable moons and every spacecraft are listed here,
// with a caption; the snapshot brings the rest of each planet's moons (all 115 of
// Jupiter's, 290 of Saturn's) with their names and who found them. Mission notes
// are short on purpose: they are a caption.

export type BodyId = 'mercury' | 'venus' | 'earth' | 'moon' | 'mars' | 'jupiter' | 'saturn' | 'uranus' | 'neptune' | 'oort';

export interface Orbiter {
  /** JPL Horizons id: negative for spacecraft, 401/402 for Mars' moons */
  id: number;
  name: string;
  kind: 'spacecraft' | 'moon';
  /** operator and launch year, or discovery for a moon */
  by: string;
  note: string;
  /** natural moons: triaxial radii, km */
  radii?: [number, number, number];
}

export interface Site {
  id: string;
  /** what the site selector says */
  short: string;
  name: string;
  /** what is (or was) there */
  what: string;
  lat: number;
  /** planetocentric east longitude */
  lon: number;
}

export interface Body {
  id: BodyId;
  name: string;
  /** "the Moon", "Mars", "the Oort cloud" */
  the: string;
  kind: 'planet' | 'moon' | 'region';
  /** equatorial radius, km (the Sun's, for the Oort cloud) */
  radiusKm: number;
  /** polar radius, km */
  polarKm: number;
  /** gravitational parameter, km³/s² */
  mu: number;
  /** closest the camera may come to the surface, km */
  minAltitudeKm: number;
  /** farthest the camera may pull back, km from the centre */
  maxDistanceKm: number;
  /** radius the opening view frames: the body plus its busiest orbits, km */
  frameKm: number;
  /** what it looks like from afar */
  hex: string;
  /** how long a day is, for the layers menu */
  turns?: string;
  orbiters: Orbiter[];
  sites: Site[];
  /** said in the orbiter list when nothing is in orbit */
  empty?: string;
}

const AU = 149_597_870.7;
const moon = (id: number, name: string, by: string, note: string, r: number | [number, number, number]): Orbiter => ({
  id,
  name,
  kind: 'moon',
  by,
  note,
  radii: typeof r === 'number' ? [r, r, r] : r,
});

export const BODIES: Record<BodyId, Body> = {
  mercury: {
    id: 'mercury',
    name: 'Mercury',
    the: 'Mercury',
    kind: 'planet',
    radiusKm: 2440.5,
    polarKm: 2438.3,
    mu: 22031.87,
    minAltitudeKm: 60,
    maxDistanceKm: 1_500_000,
    frameKm: 2440 * 1.6,
    hex: '#a59d94',
    turns: 'once every 59 Earth days, three times for every two orbits',
    orbiters: [
      {
        id: -121,
        name: 'BepiColombo',
        kind: 'spacecraft',
        by: 'ESA · JAXA · 2018',
        note: 'Two orbiters stacked on one transfer module: Europe’s MPO and Japan’s Mio. After seven years and nine planetary flybys they reach Mercury orbit in November 2026, then separate.',
      },
    ],
    sites: [],
    empty: 'Mercury has no moons.',
  },
  venus: {
    id: 'venus',
    name: 'Venus',
    the: 'Venus',
    kind: 'planet',
    radiusKm: 6051.8,
    polarKm: 6051.8,
    mu: 324858.59,
    minAltitudeKm: 300,
    maxDistanceKm: 400_000,
    frameKm: 6052 * 1.5,
    hex: '#e8d7a8',
    turns: 'backwards, once every 243 Earth days; the cloud tops race round in four',
    orbiters: [],
    sites: [],
    empty:
      'Nothing orbits Venus today, and it has no moons. Japan’s Akatsuki, the last orbiter, fell silent in 2024; NASA’s VERITAS and DAVINCI and ESA’s EnVision are planned for the 2030s.',
  },
  earth: {
    id: 'earth',
    name: 'Earth',
    the: 'the Earth',
    kind: 'planet',
    radiusKm: 6378.137,
    polarKm: 6356.752,
    mu: 398600.4418,
    minAltitudeKm: 400,
    maxDistanceKm: 250_000,
    frameKm: 6378 + 700,
    hex: '#6fa8ff',
    orbiters: [],
    sites: [],
  },
  moon: {
    id: 'moon',
    name: 'Moon',
    the: 'the Moon',
    kind: 'moon',
    radiusKm: 1737.4,
    polarKm: 1737.4,
    mu: 4902.8,
    minAltitudeKm: 30,
    maxDistanceKm: 80_000,
    frameKm: 1737.4 + 160,
    hex: '#c9c4bc',
    turns: 'once a month, keeping one face to the Earth',
    orbiters: [
      { id: -85, name: 'LRO', kind: 'spacecraft', by: 'NASA · 2009', note: 'Lunar Reconnaissance Orbiter. Its wide-angle camera and laser altimeter made the map and the relief on this globe.' },
      { id: -152, name: 'Chandrayaan-2', kind: 'spacecraft', by: 'ISRO · 2019', note: 'India’s polar orbiter, mapping water ice and minerals; it was the backup relay for Chandrayaan-3’s lander in 2023.' },
      { id: -155, name: 'Danuri', kind: 'spacecraft', by: 'KARI · 2022', note: 'Korea Pathfinder Lunar Orbiter. It carries NASA’s ShadowCam, which images the permanently shadowed craters at the poles.' },
      { id: -192, name: 'ARTEMIS P1', kind: 'spacecraft', by: 'NASA · 2007', note: 'Two of the five THEMIS probes, moved to the Moon in 2011 to sample the solar wind and Earth’s magnetotail from long, looping orbits.' },
      { id: -193, name: 'ARTEMIS P2', kind: 'spacecraft', by: 'NASA · 2007', note: 'The second ARTEMIS probe. Both loop between ~400 and ~16,000 km over the equator, P1 retrograde and P2 prograde.' },
    ],
    sites: [
      { id: 'apollo11', short: 'Apollo 11', name: 'Tranquility Base', what: 'Apollo 11, 1969', lat: 0.6741, lon: 23.473 },
      { id: 'change4', short: 'Chang’e 4', name: 'Von Kármán crater', what: 'Chang’e 4 and Yutu-2, far side', lat: -45.4446, lon: 177.5991 },
      { id: 'shackleton', short: 'South pole', name: 'Shackleton crater', what: 'South pole, an Artemis target', lat: -89.67, lon: 129.78 },
    ],
  },
  mars: {
    id: 'mars',
    name: 'Mars',
    the: 'Mars',
    kind: 'planet',
    radiusKm: 3389.5,
    polarKm: 3389.5,
    mu: 42828.37,
    minAltitudeKm: 80,
    maxDistanceKm: 140_000,
    frameKm: 3389.5 + 450,
    hex: '#e07a4f',
    turns: 'once a sol (24 h 37 min)',
    orbiters: [
      {
        id: 401,
        name: 'Phobos',
        kind: 'moon',
        by: 'Moon · found 1877',
        note: 'Orbits 6,000 km up, faster than Mars turns, so it rises in the west. Tides are pulling it in: in 30–50 million years it breaks up into a ring.',
        radii: [13.0, 11.4, 9.1],
      },
      {
        id: 402,
        name: 'Deimos',
        kind: 'moon',
        by: 'Moon · found 1877',
        note: 'The small outer moon. Its 30-hour orbit is barely longer than Mars’ day, so it takes ~2½ days to cross the sky.',
        radii: [7.8, 6.0, 5.1],
      },
      { id: -74, name: 'MRO', kind: 'spacecraft', by: 'NASA · 2005', note: 'Mars Reconnaissance Orbiter: HiRISE sees 30 cm detail, and it carries most of the rovers’ data home.' },
      { id: -53, name: 'Mars Odyssey', kind: 'spacecraft', by: 'NASA · 2001', note: 'The longest-serving spacecraft at Mars. It has relayed for every NASA lander since Spirit and Opportunity.' },
      { id: -143, name: 'Trace Gas Orbiter', kind: 'spacecraft', by: 'ESA · Roscosmos · 2016', note: 'ExoMars TGO sniffs the atmosphere for methane and relays for NASA’s rovers.' },
      { id: -41, name: 'Mars Express', kind: 'spacecraft', by: 'ESA · 2003', note: 'Europe’s first planetary mission, still mapping Mars in stereo from a 7-hour ellipse that dips to a few hundred km.' },
      { id: -62, name: 'Hope', kind: 'spacecraft', by: 'UAE · 2020', note: 'Emirates Mars Mission. Its high, slow orbit sees the whole disc, so it can watch the weather at every hour of the local day.' },
    ],
    sites: [
      { id: 'jezero', short: 'Perseverance', name: 'Jezero crater', what: 'Perseverance rover', lat: 18.4447, lon: 77.4508 },
      { id: 'gale', short: 'Curiosity', name: 'Gale crater', what: 'Curiosity rover', lat: -4.5895, lon: 137.4417 },
    ],
  },
  jupiter: {
    id: 'jupiter',
    name: 'Jupiter',
    the: 'Jupiter',
    kind: 'planet',
    radiusKm: 71492,
    polarKm: 66854,
    mu: 126686531.9,
    minAltitudeKm: 5000,
    maxDistanceKm: 120_000_000,
    frameKm: 450_000,
    hex: '#d8b48c',
    turns: 'once every 9 h 56 min, the fastest of any planet',
    orbiters: [
      {
        id: -61,
        name: 'Juno',
        kind: 'spacecraft',
        by: 'NASA · 2011',
        note: 'Loops over Jupiter’s poles about once a month, diving to a few thousand km above the clouds at nearly 60 km/s. Its extended mission has also flown past Ganymede, Europa and Io.',
      },
      moon(501, 'Io', 'Moon · found 1610 (Galileo)', 'The most volcanic world known. Tides from Jupiter, kept going by Europa and Ganymede, knead it hot enough for hundreds of active volcanoes.', [1829.4, 1819.4, 1815.7]),
      moon(502, 'Europa', 'Moon · found 1610 (Galileo)', 'A cracked ice shell over a salt-water ocean holding about twice the water of Earth’s. Europa Clipper arrives in 2030 to look at it closely.', 1560.8),
      moon(503, 'Ganymede', 'Moon · found 1610 (Galileo)', 'The largest moon in the solar system, bigger than Mercury, and the only one with a magnetic field of its own. ESA’s JUICE is due to orbit it from 2034.', 2631.2),
      moon(504, 'Callisto', 'Moon · found 1610 (Galileo)', 'The most heavily cratered surface known: barely changed in four billion years.', 2410.3),
      moon(505, 'Amalthea', 'Moon · found 1892 (Barnard)', 'Red and potato-shaped, 250 km long. It is less dense than water, so it is probably a loose pile of ice and rock.', [125, 73, 64]),
    ],
    sites: [],
  },
  saturn: {
    id: 'saturn',
    name: 'Saturn',
    the: 'Saturn',
    kind: 'planet',
    radiusKm: 60268,
    polarKm: 54364,
    mu: 37931206.2,
    minAltitudeKm: 5000,
    maxDistanceKm: 120_000_000,
    frameKm: 300_000,
    hex: '#e3cf9c',
    turns: 'once every 10 h 33 min',
    orbiters: [
      moon(606, 'Titan', 'Moon · found 1655 (Huygens)', 'Air thicker than Earth’s, and lakes and seas of liquid methane. ESA’s Huygens probe landed here in 2005; NASA’s Dragonfly is to fly in its skies in the 2030s.', 2574.7),
      moon(605, 'Rhea', 'Moon · found 1672 (Cassini)', 'Saturn’s second-largest moon: an old, icy, cratered ball.', 763.8),
      moon(608, 'Iapetus', 'Moon · found 1671 (Cassini)', 'Two-toned: its leading side is as dark as coal, its trailing side as bright as snow, and a ridge up to 20 km high runs along its equator.', 734.3),
      moon(604, 'Dione', 'Moon · found 1684 (Cassini)', 'Bright ice cliffs streak its trailing side. It shares its orbit with two small moons, Helene and Polydeuces.', 561.4),
      moon(603, 'Tethys', 'Moon · found 1684 (Cassini)', 'Almost pure water ice, split by Ithaca Chasma, a canyon some 2,000 km long.', 531.1),
      moon(602, 'Enceladus', 'Moon · found 1789 (Herschel)', 'Geysers at its south pole spray an underground ocean into space, and the spray feeds Saturn’s E ring.', 252.1),
      moon(601, 'Mimas', 'Moon · found 1789 (Herschel)', 'Its crater Herschel is 130 km across, a third of Mimas’ width. Its pull shapes the outer edge of the B ring.', [207.8, 196.7, 190.6]),
      moon(607, 'Hyperion', 'Moon · found 1848 (Bond, Lassell)', 'Spongy and tumbling chaotically: its spin can’t be predicted for long.', [180.1, 133, 102.7]),
      moon(609, 'Phoebe', 'Moon · found 1899 (Pickering)', 'A captured outsider on a backward orbit 13 million km out. Dust knocked off it makes Saturn’s largest, faintest ring.', 106.5),
    ],
    sites: [],
  },
  uranus: {
    id: 'uranus',
    name: 'Uranus',
    the: 'Uranus',
    kind: 'planet',
    radiusKm: 25559,
    polarKm: 24973,
    mu: 5793951.3,
    minAltitudeKm: 2000,
    maxDistanceKm: 80_000_000,
    frameKm: 140_000,
    hex: '#a9dce3',
    turns: 'on its side, once every 17 h 14 min',
    orbiters: [
      moon(703, 'Titania', 'Moon · found 1787 (Herschel)', 'Uranus’ largest moon, cut by canyons up to 1,500 km long.', 788.9),
      moon(704, 'Oberon', 'Moon · found 1787 (Herschel)', 'The outermost of the five big moons: old, dark and cratered.', 761.4),
      moon(702, 'Umbriel', 'Moon · found 1851 (Lassell)', 'The darkest of the five, with one bright ring, Wunda, on a crater floor.', 584.7),
      moon(701, 'Ariel', 'Moon · found 1851 (Lassell)', 'The brightest of the five, with the youngest surface, criss-crossed by canyons.', 578.9),
      moon(705, 'Miranda', 'Moon · found 1948 (Kuiper)', 'A patchwork of grooved terrain, and Verona Rupes, cliffs that may be 20 km high.', [240.4, 234.2, 232.9]),
    ],
    sites: [],
    empty: 'No spacecraft has been to Uranus since Voyager 2 flew by in 1986.',
  },
  neptune: {
    id: 'neptune',
    name: 'Neptune',
    the: 'Neptune',
    kind: 'planet',
    radiusKm: 24764,
    polarKm: 24341,
    mu: 6835099.5,
    minAltitudeKm: 2000,
    maxDistanceKm: 150_000_000,
    frameKm: 120_000,
    hex: '#5b7fe0',
    turns: 'once every 16 h 7 min',
    orbiters: [
      moon(801, 'Triton', 'Moon · found 1846 (Lassell)', 'Orbits backwards, so it was probably captured from the Kuiper belt. Voyager 2 saw nitrogen geysers in 1989; tides are slowly drawing it in.', 1352.6),
      moon(808, 'Proteus', 'Moon · found 1989 (Voyager 2)', 'Dark and boxy, about as big as a body can be before its own gravity pulls it round.', [218, 208, 201]),
      moon(802, 'Nereid', 'Moon · found 1949 (Kuiper)', 'The most eccentric orbit of any moon: it swings between 1.4 and 9.7 million km from Neptune.', 178),
    ],
    sites: [],
    empty: 'No spacecraft has been to Neptune since Voyager 2 flew by in 1989.',
  },
  oort: {
    id: 'oort',
    name: 'Oort Cloud',
    the: 'the Oort cloud',
    kind: 'region',
    radiusKm: 695_700,
    polarKm: 695_700,
    mu: 132712440041.9,
    minAltitudeKm: 3_000_000,
    maxDistanceKm: 400_000 * AU,
    frameKm: 100_000 * AU,
    hex: '#9fb4d8',
    orbiters: [
      {
        id: -31,
        name: 'Voyager 1',
        kind: 'spacecraft',
        by: 'NASA · 1977',
        note: 'Flew past Jupiter and Saturn, crossed the heliopause into interstellar space in August 2012, and is the farthest human-made object. Its signal takes almost a day to reach us.',
      },
      {
        id: -32,
        name: 'Voyager 2',
        kind: 'spacecraft',
        by: 'NASA · 1977',
        note: 'The only spacecraft to have visited Uranus (1986) and Neptune (1989), after Jupiter and Saturn. It left the heliosphere in November 2018.',
      },
    ],
    sites: [],
  },
};

/** Inside out, as the switcher shows them. */
export const BODY_ORDER: BodyId[] = ['mercury', 'venus', 'earth', 'moon', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'oort'];

/** The worlds with a relay planner (their landers and rovers). */
export const hasSites = (b: BodyId) => BODIES[b].sites.length > 0;

/** "the Moon" -> "The Moon", for the start of a sentence. */
export const The = (b: BodyId) => BODIES[b].the.charAt(0).toUpperCase() + BODIES[b].the.slice(1);
