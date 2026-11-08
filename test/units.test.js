import { describe, expect, test } from 'bun:test';
import { convert, detectUnits, displayReading, resolveUnits } from '../apps/web/public/app/units.js';

describe('units', () => {
  test('en-US and other US locales default to imperial', () => {
    expect(detectUnits(['en-US'])).toBe('imperial');
    expect(detectUnits(['es-US', 'es'])).toBe('imperial');
    expect(detectUnits(['en'])).toBe('imperial'); // en maximizes to en-Latn-US
  });

  test('everyone else defaults to metric', () => {
    for (const tag of ['en-GB', 'en-CA', 'en-AU', 'de-DE', 'fr', 'ja-JP', 'es-MX', 'pt-BR']) expect(detectUnits([tag])).toBe('metric');
    expect(detectUnits([])).toBe('metric');
    expect(detectUnits(['not a tag'])).toBe('metric');
  });

  test('an account choice beats the locale', () => {
    expect(resolveUnits('metric', ['en-US'])).toBe('metric');
    expect(resolveUnits('imperial', ['de-DE'])).toBe('imperial');
    expect(resolveUnits(null, ['en-US'])).toBe('imperial');
    expect(resolveUnits('bogus', ['de-DE'])).toBe('metric');
  });

  test('converts weight and temperature', () => {
    expect(convert(70, 'kg', 'lb')).toBe(154.3);
    expect(convert(154.3, 'lb', 'kg')).toBe(70);
    expect(convert(37, '°C', '°F')).toBe(98.6);
    expect(convert(98.6, '°F', '°C')).toBe(37);
  });

  test('old readings without a unit were metric and convert for imperial viewers', () => {
    expect(displayReading({ kind: 'weight', value: '70' }, 'imperial')).toBe('154.3 lb');
    expect(displayReading({ kind: 'weight', value: '70' }, 'metric')).toBe('70 kg');
    expect(displayReading({ kind: 'temperature', value: '98.6', unit: '°F' }, 'imperial')).toBe('98.6 °F');
    expect(displayReading({ kind: 'temperature', value: '98.6', unit: '°F' }, 'metric')).toBe('37 °C');
    expect(displayReading({ kind: 'heart-rate', value: '72' }, 'imperial', 'bpm')).toBe('72 bpm');
  });
});
