export const MICROSECONDS_PER_SECOND = 1_000_000;

export function celsiusToKelvin(temperatureC: number): number {
  return temperatureC + 273.15;
}

export function centistokesToM2s(viscosityCst: number): number {
  return viscosityCst * 1e-6;
}
