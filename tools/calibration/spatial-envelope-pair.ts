import { mkdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { z } from 'zod'
import type { FluidProfile } from '../../src/contracts/model'
import type { responseDictionaryManifestSchema } from '../../src/contracts/response-dictionary'
import { ANCHOR_IDS } from '../../src/detection/optimizer'
import type { HydraulicState } from '../../src/physics/state'

interface SpatialInputs {
  readonly profile: FluidProfile
  readonly initialStates: readonly HydraulicState[]
  readonly manifest: z.infer<typeof responseDictionaryManifestSchema>
}

const layouts = ['synthetic-oil-nominal-v1', 'synthetic-oil-adverse-v1'] as const
const withoutLayout = (profile: FluidProfile) => ({ ...profile, sensorProfileId: undefined })
const numericState = (state: HydraulicState) => ({
  ...state, profile: { ...state.profile, definition: withoutLayout(state.profile.definition) },
})

export function assertPairedSpatialInputs(left: SpatialInputs, right: SpatialInputs): void {
  const pair = [left, right]
  if (!layouts.every((id) => pair.some(({ profile }) => profile.sensorProfileId === id))) {
    throw new Error('Paired spatial fit requires opposite nominal and adverse sensor layouts.')
  }
  if (!isDeepStrictEqual(withoutLayout(left.profile), withoutLayout(right.profile))) {
    throw new Error('Paired spatial fit physical profiles differ.')
  }
  if (!pair.every(({ profile, initialStates }) => initialStates.length === ANCHOR_IDS.length
    && initialStates.every((state) => state.profile.definition.sensorProfileId === profile.sensorProfileId))
    || !isDeepStrictEqual(left.initialStates.map(numericState), right.initialStates.map(numericState))) {
    throw new Error('Paired spatial fit initial hydraulic states differ.')
  }
  if (!isDeepStrictEqual({ ...left.manifest, anchorParameterHashes: undefined },
    { ...right.manifest, anchorParameterHashes: undefined })) {
    throw new Error('Paired spatial fit dictionary data or trace layout differs.')
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const distance = relative(parent, candidate)
  return distance !== '..' && !distance.startsWith(`..${sep}`) && !isAbsolute(distance)
}

function assertDistinctDirectories(left: string, right: string): void {
  if (isWithin(left, right) || isWithin(right, left)) {
    throw new Error('Paired spatial fit output directories must be distinct and disjoint.')
  }
}

export async function preparePairedSpatialOutputs(left: string, right: string): Promise<readonly [string, string]> {
  assertDistinctDirectories(resolve(left), resolve(right))
  await Promise.all([mkdir(left, { recursive: true }), mkdir(right, { recursive: true })])
  const [leftPath, rightPath] = await Promise.all([realpath(left), realpath(right)])
  assertDistinctDirectories(leftPath, rightPath)
  const [leftStat, rightStat] = await Promise.all([stat(leftPath, { bigint: true }), stat(rightPath, { bigint: true })])
  if (leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino) {
    throw new Error('Paired spatial fit output directories refer to the same location.')
  }
  await Promise.all([leftPath, rightPath].map(async (out) => {
    const cells = join(out, 'cells')
    await mkdir(cells, { recursive: true })
    if (await realpath(cells) !== cells) throw new Error('Paired spatial fit cells directory cannot be an alias.')
  }))
  return [leftPath, rightPath]
}
