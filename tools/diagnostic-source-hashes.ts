import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha256 = (contents: Buffer | string) => createHash('sha256').update(contents).digest('hex')

export function diagnosticSourceHashes(root: string) {
  const directory = (path: string) => readdirSync(resolve(root, path), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|json|wgsl)$/.test(entry.name))
    .map((entry) => `${path}/${entry.name}`)
  const group = (files: string[]) => sha256(files.sort().map((path) => `${path}\0${sha256(readFileSync(resolve(root, path)))}\n`).join(''))
  return {
    profile: sha256(readFileSync(resolve(root, 'src/scenarios/synthetic-oil-turbulent-v1.json'))),
    model: group([...directory('src/physics'), 'src/contracts/model.ts', 'src/plant/events.ts', 'src/profiles/zielke-coefficients.json']),
    bank: group(directory('src/twin')),
    sensor: group(['src/plant/sensors.ts', 'src/plant/sensor-faults.ts', 'src/plant/random.ts', 'src/plant/telemetry-delivery.ts']),
    policy: group([...directory('src/detection'), ...directory('src/contracts'), ...directory('src/runtime')]),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(diagnosticSourceHashes(process.cwd()), null, 2))
}
