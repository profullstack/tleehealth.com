// Measurement units for the health tracker and account settings.
// An account stores 'imperial', 'metric' or nothing (null = follow the browser
// locale). Only the United States, Liberia and Myanmar default to imperial.

export const UNIT_SYSTEMS = ['imperial', 'metric'];
const IMPERIAL_REGIONS = new Set(['US', 'LR', 'MM']);

/** The region of a BCP 47 tag, guessing the likely one when absent ("en" -> US). */
export function regionOf(tag) {
  try {
    const locale = new Intl.Locale(tag);
    return (locale.region ?? locale.maximize().region ?? '').toUpperCase();
  } catch {
    return '';
  }
}

/** 'imperial' or 'metric' for a list of browser languages (navigator.languages). */
export function detectUnits(languages) {
  const list = (Array.isArray(languages) ? languages : [languages]).filter(Boolean);
  const first = list.find((tag) => regionOf(tag)) ?? list[0];
  return first && IMPERIAL_REGIONS.has(regionOf(first)) ? 'imperial' : 'metric';
}

/** The system to use: the account's saved choice, else the browser's locale. */
export function resolveUnits(saved, languages = globalThis.navigator?.languages ?? [globalThis.navigator?.language]) {
  return UNIT_SYSTEMS.includes(saved) ? saved : detectUnits(languages);
}

// Readings whose unit depends on the system. Readings saved before units existed
// carry no unit and were entered in the metric one.
export const UNITS = {
  weight: { metric: 'kg', imperial: 'lb' },
  temperature: { metric: '°C', imperial: '°F' },
};
export const PLACEHOLDERS = {
  weight: { metric: '70.5', imperial: '155.4' },
  temperature: { metric: '36.8', imperial: '98.2' },
};

const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;

/** Convert a numeric reading between units of the same kind. */
export function convert(value, from, to) {
  if (from === to) return value;
  if (from === 'kg' && to === 'lb') return round(value * 2.2046226218, 1);
  if (from === 'lb' && to === 'kg') return round(value / 2.2046226218, 1);
  if (from === '°C' && to === '°F') return round(value * 9 / 5 + 32, 1);
  if (from === '°F' && to === '°C') return round((value - 32) * 5 / 9, 1);
  throw new Error(`Cannot convert ${from} to ${to}`);
}

/** The text to show for a saved reading in the viewer's unit system. */
export function displayReading(entry, system, fixedUnit) {
  const units = UNITS[entry.kind];
  if (!units) return `${entry.value} ${fixedUnit}`;
  const stored = Object.values(units).includes(entry.unit) ? entry.unit : units.metric;
  const want = units[system] ?? units.metric;
  const n = Number(entry.value);
  if (!Number.isFinite(n) || stored === want) return `${entry.value} ${stored}`;
  return `${convert(n, stored, want)} ${want}`;
}
