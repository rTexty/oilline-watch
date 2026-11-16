import { parseBoundedJson } from '../contracts/scenario'
import { replaySchema } from '../runtime/replay-schema'

export function parseReplay(text: string) {
  return replaySchema.parse(parseBoundedJson(text))
}
