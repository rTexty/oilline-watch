import { z } from 'zod';

export const SCHEMA_VERSION = 1;
export const UNITS_VERSION = 1;
export const MODEL_VERSION = '1';
export const BANK_VERSION = '1';
export const CHALLENGE_WARMUP_US = 30_000_000;
export const CHALLENGE_HORIZON_US = 330_000_000;
export const LAMINAR_HORIZON_US = 30_000_000;
export const THERMAL_HORIZON_US = 3_600_000_000;
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;

export const modelTimeSchema = z.number().int().nonnegative();
export const schemaVersionSchema = z.literal(SCHEMA_VERSION);
export const modelVersionSchema = z.literal(MODEL_VERSION);
export const bankVersionSchema = z.literal(BANK_VERSION);
export const profileIdSchema = z.enum([
  'synthetic-oil-turbulent-v1',
  'synthetic-oil-laminar-v1',
  'synthetic-oil-thermal-v1',
]);
export const modeSchema = z.enum(['turbulent', 'laminar', 'thermal']);
export const sensorProfileIdSchema = z.enum([
  'synthetic-oil-nominal-v1',
  'synthetic-oil-adverse-v1',
  'none',
]);
export const anchorIdSchema = z.literal([0, 1, 2, 3, 4, 5, 6, 7, 8]);

export type TimeUs = z.infer<typeof modelTimeSchema>;
export type ModelTime = TimeUs;
export type ProfileId = z.infer<typeof profileIdSchema>;
export type AnchorId = z.infer<typeof anchorIdSchema>;

const positive = z.number().positive();
const temperature = z.number().min(308.15).max(338.15);
const pressure = z.number().min(250_000).max(2_000_000);

export const geometrySchema = z.strictObject({
  lengthM: positive,
  diameterM: positive,
  wallThicknessM: positive,
  roughnessM: z.number().nonnegative(),
  youngModulusPa: positive,
  supportFactor: positive,
}).refine((geometry) => geometry.roughnessM / geometry.diameterM <= 0.05, {
  path: ['roughnessM'],
  message: 'Relative roughness exceeds the supported limit of 0.05',
}).readonly();

const viscosityPointSchema = z.strictObject({
  temperatureK: temperature,
  kinematicM2S: positive,
}).readonly();

export const viscositySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('walther'),
    points: z.tuple([viscosityPointSchema, viscosityPointSchema]).readonly(),
    multiplier: z.number().positive().optional(),
  }),
  z.strictObject({
    kind: z.literal('constant'),
    kinematicM2S: positive,
  }),
]).refine((law) => law.kind === 'constant' || (
  law.points[0].temperatureK < law.points[1].temperatureK
  && law.points[0].kinematicM2S > law.points[1].kinematicM2S
  && law.points[1].kinematicM2S > 0.2e-6
), { message: 'Walther anchors require ordered temperatures and positive nested logarithms' }).readonly();

const publicFluidProfileSchema = z.strictObject({
  rho0KgM3: positive,
  pRefPa: pressure,
  tRefK: temperature,
  bulkModulusPa: positive,
  cpJkgK: positive,
  expansionPerK: positive,
  conductivityWMK: positive,
  viscosity: viscositySchema,
  phaseQualification: z.enum(['stipulated-synthetic', 'unqualified']),
}).readonly();

const limitsSchema = z.strictObject({
  pressureMinPa: z.literal(250_000),
  pressureMaxPa: z.literal(2_000_000),
  temperatureMinK: z.literal(308.15),
  temperatureMaxK: z.literal(338.15),
  externalPressurePa: z.literal(101_325),
  phaseMinPa: z.literal(50_000),
}).readonly();

const initialPublicControlsSchema = z.strictObject({
  inletPressurePa: pressure,
  outletFlowM3s: positive,
  inletTemperatureK: temperature,
  ambientTemperatureK: temperature,
}).readonly();

const thermalSchema = z.strictObject({
  initialOilTemperatureK: temperature,
  initialWallTemperatureK: temperature,
  wallDensityKgM3: positive,
  wallCpJkgK: positive,
  wallConductivityWMK: positive,
  innerConductanceWMK: positive,
  outerConductanceWMK: positive,
  stepUs: z.literal(100_000),
}).readonly();

const gridSchema = z.strictObject({
  segments: z.number().int().min(2).max(400),
  nominalStepUs: z.number().int().positive(),
}).readonly();

const profileFields = z.strictObject({
  schemaVersion: schemaVersionSchema,
  unitsVersion: z.literal(UNITS_VERSION),
  profileId: profileIdSchema,
  modelVersion: modelVersionSchema,
  mode: modeSchema,
  geometry: geometrySchema,
  publicFluidProfile: publicFluidProfileSchema,
  initialPublicControls: initialPublicControlsSchema,
  grid: gridSchema,
  warmupUs: modelTimeSchema,
  horizonUs: modelTimeSchema,
  sensorProfileId: sensorProfileIdSchema,
  startupQualification: z.enum(['known-healthy', 'unknown']),
  limits: limitsSchema,
  thermal: thermalSchema,
});

function hasValidMode(profile: z.infer<typeof profileFields>): boolean {
  const { mode, profileId, grid, warmupUs, horizonUs, sensorProfileId, publicFluidProfile } = profile;
  if (profileId !== `synthetic-oil-${mode}-v1`) return false;
  switch (mode) {
    case 'turbulent':
      return warmupUs === CHALLENGE_WARMUP_US && horizonUs === CHALLENGE_HORIZON_US
        && sensorProfileId !== 'none' && publicFluidProfile.viscosity.kind === 'walther';
    case 'laminar':
      return warmupUs === 0 && horizonUs === LAMINAR_HORIZON_US
        && publicFluidProfile.viscosity.kind === 'constant' && 10_000 % grid.nominalStepUs === 0;
    case 'thermal':
      return warmupUs === 0 && horizonUs === THERMAL_HORIZON_US && sensorProfileId === 'none'
        && publicFluidProfile.viscosity.kind === 'walther' && grid.nominalStepUs === 100_000;
  }
}

function hasValidGeometry(profile: z.infer<typeof profileFields>): boolean {
  const { geometry, grid, initialPublicControls, mode, publicFluidProfile, thermal } = profile;
  const { lengthM, diameterM, wallThicknessM, youngModulusPa, supportFactor } = geometry;
  const { bulkModulusPa, rho0KgM3 } = publicFluidProfile;
  const area = Math.PI * diameterM ** 2 / 4;
  const cellLength = lengthM / grid.segments;
  const waveSpeed = Math.sqrt((bulkModulusPa / rho0KgM3)
    / (1 + supportFactor * bulkModulusPa * diameterM / (youngModulusPa * wallThicknessM)));
  const courant = mode === 'thermal'
    ? initialPublicControls.outletFlowM3s / area * (thermal.stepUs / 1e6) / cellLength
    : waveSpeed * (grid.nominalStepUs / 1e6) / cellLength;
  const courantLimit = mode === 'thermal' ? 0.8 : 1;
  return Number.isFinite(courant) && courant > 0 && courant <= courantLimit + 16 * Number.EPSILON;
}

function hasValidInitialFlow(profile: z.infer<typeof profileFields>): boolean {
  const { geometry, initialPublicControls, mode, publicFluidProfile, thermal } = profile;
  const law = publicFluidProfile.viscosity;
  const area = Math.PI * geometry.diameterM ** 2 / 4;
  const velocity = initialPublicControls.outletFlowM3s / area;
  let viscosityM2S: number;
  if (law.kind === 'constant') {
    viscosityM2S = law.kinematicM2S;
  } else {
    const [low, high] = law.points;
    const yLow = Math.log(Math.log(low.kinematicM2S * 1e6 + 0.8));
    const yHigh = Math.log(Math.log(high.kinematicM2S * 1e6 + 0.8));
    const fraction = Math.log(thermal.initialOilTemperatureK / low.temperatureK)
      / Math.log(high.temperatureK / low.temperatureK);
    viscosityM2S = (Math.exp(Math.exp(yLow + fraction * (yHigh - yLow))) - 0.8) * 1e-6 * (law.multiplier ?? 1);
  }
  const reynolds = velocity * geometry.diameterM / viscosityM2S;
  return Number.isFinite(reynolds) && reynolds > 0
    && (mode === 'laminar' ? reynolds < 2000 : reynolds >= 4000 && reynolds <= 1e8);
}

export const profileSchema = profileFields
  .refine(hasValidMode, { message: 'Profile mode, clocks, viscosity and sensor layout are incompatible' })
  .refine(hasValidGeometry, { message: 'Profile exceeds the supported Courant limit' })
  .refine(hasValidInitialFlow, { message: 'Initial viscosity and flow do not match the profile regime' })
  .readonly();

export type PublicScenario = z.infer<typeof profileSchema>;
export type FluidProfile = PublicScenario;
