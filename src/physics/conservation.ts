export interface EnergyTerms {
  readonly oilChangeJ: number;
  readonly wallChangeJ: number;
  readonly boundaryInJ: number;
  readonly boundaryOutJ: number;
  readonly leakJ: number;
  readonly ambientJ: number;
  readonly compressionApproxJ: number;
}

export interface EnergyLedger extends EnergyTerms {
  readonly residualJ: number;
  readonly normalizedResidual: number;
  readonly scaleJ: number;
}

export function initialEnergyLedger(): EnergyLedger {
  return {
    oilChangeJ: 0,
    wallChangeJ: 0,
    boundaryInJ: 0,
    boundaryOutJ: 0,
    leakJ: 0,
    ambientJ: 0,
    compressionApproxJ: 0,
    residualJ: 0,
    normalizedResidual: 0,
    scaleJ: 0,
  };
}

export function recordEnergy(previous: EnergyLedger, step: EnergyTerms): EnergyLedger {
  const totals = {
    oilChangeJ: previous.oilChangeJ + step.oilChangeJ,
    wallChangeJ: previous.wallChangeJ + step.wallChangeJ,
    boundaryInJ: previous.boundaryInJ + step.boundaryInJ,
    boundaryOutJ: previous.boundaryOutJ + step.boundaryOutJ,
    leakJ: previous.leakJ + step.leakJ,
    ambientJ: previous.ambientJ + step.ambientJ,
    compressionApproxJ: previous.compressionApproxJ + step.compressionApproxJ,
  };
  const appliedJ = step.boundaryInJ - step.boundaryOutJ - step.leakJ - step.ambientJ + step.compressionApproxJ;
  const residualJ = previous.residualJ + (step.oilChangeJ + step.wallChangeJ - appliedJ);
  const scaleJ = previous.scaleJ + Math.abs(step.oilChangeJ) + Math.abs(step.wallChangeJ)
    + Math.abs(step.boundaryInJ) + Math.abs(step.boundaryOutJ)
    + Math.abs(step.leakJ) + Math.abs(step.ambientJ) + Math.abs(step.compressionApproxJ);
  return { ...totals, residualJ, scaleJ, normalizedResidual: Math.abs(residualJ) / Math.max(scaleJ, 1) };
}
