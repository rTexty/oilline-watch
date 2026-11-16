import type { Measurement, PublicBatch, PublicPrediction, SensorId } from '../contracts/public'

const pressureChannels: readonly SensorId[] = ['P1', 'P2', 'P3']

export function sensorResidual(reading: Measurement, nominal: PublicPrediction, deliveredThroughUs: number): number | null {
  if (reading.sampleTimeUs !== nominal.sampleTimeUs || reading.deliveredTimeUs > deliveredThroughUs
    || reading.quality !== 'valid' || reading.valueSI === null) return null
  const prediction = reading.sensorId === 'Qin'
    ? nominal.inletFlowM3s
    : nominal.pressurePa[pressureChannels.indexOf(reading.sensorId)]!
  return reading.valueSI - prediction
}

export function pressureResiduals(batch: PublicBatch): readonly (number | null)[] {
  const nominal = batch.predictions.find((prediction) => prediction.anchorId === 0)
  return pressureChannels.map((sensorId) => {
    const reading = batch.measurements.find((sample) => sample.sensorId === sensorId
      && sample.sampleTimeUs === batch.sampleTimeUs && sample.deliveredTimeUs <= batch.sampleTimeUs)
    return nominal && reading ? sensorResidual(reading, nominal, batch.sampleTimeUs) : null
  })
}
