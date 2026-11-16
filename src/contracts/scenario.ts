import { MAX_IMPORT_BYTES, profileSchema } from './model';
import type { PublicScenario } from './model';

export const publicScenarioSchema = profileSchema;
const MAX_IMPORT_DEPTH = 32;

function checkNesting(text: string): void {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') inString = !inString;
    else if (inString) {
      if (character === '\\') index++;
    } else if (character === '{' || character === '[') {
      if (++depth > MAX_IMPORT_DEPTH) throw new RangeError('Import exceeds the JSON nesting limit');
    } else if (character === '}' || character === ']') depth--;
  }
}

export function parseBoundedJson(text: string): unknown {
  if (text.length > MAX_IMPORT_BYTES || new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES) {
    throw new RangeError('Import exceeds the 32 MiB UTF-8 limit');
  }
  checkNesting(text);
  return JSON.parse(text) as unknown;
}

export function parsePublicScenario(text: string): PublicScenario {
  return publicScenarioSchema.parse(parseBoundedJson(text));
}
