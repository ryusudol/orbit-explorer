declare module '*/data/fetch-tles.mjs' {
  export function classify(name: string, id: number, hint?: number): number;
  export function isoToJd(iso: string): number;
  export const Category: Record<string, number>;
}
