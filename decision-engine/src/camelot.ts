import type { CamelotKey } from "./types.js";

const KEY_TO_CAMELOT: Record<string, CamelotKey> = {
  "g# minor": "1A", "ab minor": "1A", "b major": "1B", "cb major": "1B",
  "d# minor": "2A", "eb minor": "2A", "f# major": "2B", "gb major": "2B",
  "a# minor": "3A", "bb minor": "3A", "c# major": "3B", "db major": "3B",
  "f minor": "4A", "ab major": "4B",
  "c minor": "5A", "eb major": "5B",
  "g minor": "6A", "bb major": "6B",
  "d minor": "7A", "f major": "7B",
  "a minor": "8A", "c major": "8B",
  "e minor": "9A", "g major": "9B",
  "b minor": "10A", "d major": "10B",
  "f# minor": "11A", "gb minor": "11A", "a major": "11B",
  "c# minor": "12A", "db minor": "12A", "e major": "12B", "fb major": "12B"
};

function normalizeKey(key: string): string {
  return key.toLowerCase().trim().replace(/\s+/g, " ").replace("♯", "#").replace("♭", "b");
}

/** Converts an analysis key to its Camelot code, or null if it is not usable. */
export function toCamelot(key: string): CamelotKey | null {
  const normalized = normalizeKey(key);
  if (/^(?:[1-9]|1[0-2])[ab]$/.test(normalized)) {
    return `${normalized.slice(0, -1)}${normalized.at(-1)!.toUpperCase()}` as CamelotKey;
  }
  return KEY_TO_CAMELOT[normalized] ?? null;
}

function wheelDistance(a: number, b: number): number {
  const raw = Math.abs(a - b);
  return Math.min(raw, 12 - raw);
}

/**
 * Compatibility follows the Camelot wheel instead of raw key-name equality.
 * Same key, relative major/minor, and a one-step wheel move are all valid mixes.
 */
export function harmonicCompatibility(fromKey: string, toKey: string): number {
  const from = toCamelot(fromKey);
  const to = toCamelot(toKey);
  if (!from || !to) return 0.5;

  const fromNumber = Number(from.slice(0, -1));
  const toNumber = Number(to.slice(0, -1));
  const sameMode = from.at(-1) === to.at(-1);
  const distance = wheelDistance(fromNumber, toNumber);

  if (distance === 0 && sameMode) return 1;
  if (distance === 0) return 0.9; // relative major/minor
  if (distance === 1 && sameMode) return 0.82;
  return 0.35;
}
