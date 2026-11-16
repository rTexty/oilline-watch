import { describe, expect, it } from 'vitest';
import { celsiusToKelvin, centistokesToM2s } from '../../src/physics/units';
import { waltherCoefficients, waltherViscosity } from '../../src/physics/properties';

describe('synthetic oil properties', () => {
  const coefficients = waltherCoefficients(
    { temperatureK: 313.15, viscosityM2s: 10e-6 },
    { temperatureK: 333.15, viscosityM2s: 5e-6 },
  );
  it('converts input units and reproduces viscosity anchors', () => {
    expect(celsiusToKelvin(40)).toBeCloseTo(313.15, 12);
    expect(centistokesToM2s(10)).toBeCloseTo(10e-6, 15);
    expect(waltherViscosity(313.15, coefficients)).toBeCloseTo(10e-6, 14);
    expect(waltherViscosity(333.15, coefficients)).toBeCloseTo(5e-6, 14);
    expect(waltherViscosity(323.15, coefficients)).toBeCloseTo(6.89390519844e-6, 14);
  });
  it('accepts the declared boundaries and rejects extrapolation and non-finite input', () => {
    expect(waltherViscosity(308.15, coefficients)).toBeGreaterThan(0);
    expect(waltherViscosity(338.15, coefficients)).toBeGreaterThan(0);
    expect(() => waltherViscosity(308.149, coefficients)).toThrow();
    expect(() => waltherViscosity(338.151, coefficients)).toThrow();
    expect(() => waltherViscosity(NaN, coefficients)).toThrow();
  });
});

it('rejects Celsius temperatures accidentally supplied as absolute Kelvin anchors', () => {
  expect(() => waltherCoefficients(
    { temperatureK: 40, viscosityM2s: 10e-6 },
    { temperatureK: 60, viscosityM2s: 5e-6 },
  )).toThrow();
});
