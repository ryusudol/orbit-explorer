export interface City {
  id: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
}

export const CITIES: City[] = [
  { id: 'lon', name: 'London', country: 'United Kingdom', lat: 51.5072, lon: -0.1276 },
  { id: 'nyc', name: 'New York', country: 'United States', lat: 40.7128, lon: -74.006 },
  { id: 'chi', name: 'Chicago', country: 'United States', lat: 41.8781, lon: -87.6298 },
  { id: 'fra', name: 'Frankfurt', country: 'Germany', lat: 50.1109, lon: 8.6821 },
  { id: 'lax', name: 'Los Angeles', country: 'United States', lat: 34.0522, lon: -118.2437 },
  { id: 'sao', name: 'São Paulo', country: 'Brazil', lat: -23.5505, lon: -46.6333 },
  { id: 'jnb', name: 'Johannesburg', country: 'South Africa', lat: -26.2041, lon: 28.0473 },
  { id: 'bom', name: 'Mumbai', country: 'India', lat: 19.076, lon: 72.8777 },
  { id: 'sin', name: 'Singapore', country: 'Singapore', lat: 1.3521, lon: 103.8198 },
  { id: 'hkg', name: 'Hong Kong', country: 'China', lat: 22.3193, lon: 114.1694 },
  { id: 'tyo', name: 'Tokyo', country: 'Japan', lat: 35.6762, lon: 139.6503 },
  { id: 'syd', name: 'Sydney', country: 'Australia', lat: -33.8688, lon: 151.2093 },
];

export const cityById = (id: string) => CITIES.find((c) => c.id === id) ?? CITIES[0];

/** "Tokyo, Japan"; a city-state is named once. */
export const placeName = (c: City) => (c.country === c.name ? c.name : `${c.name}, ${c.country}`);
