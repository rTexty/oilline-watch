import { realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

async function destination(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    const parent = dirname(path)
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT' || parent === path) {
      throw error
    }
    return join(await destination(parent), basename(path))
  }
}

function within(root: string, path: string): boolean {
  const offset = relative(root, path)
  return !isAbsolute(offset) && offset !== '..' && !offset.startsWith(`..${sep}`)
}

export async function assertPrivateSplitOutput(out: string, workspaceRoot: string): Promise<void> {
  const output = resolve(out)
  const servingRoots = [resolve(workspaceRoot, 'public'), resolve(workspaceRoot, 'dist')]
  const canonicalOutput = await destination(output)
  const canonicalRoots = await Promise.all(servingRoots.map(destination))
  if (servingRoots.some((root) => within(root, output)) || canonicalRoots.some((root) => within(root, canonicalOutput))) {
    throw new Error('Scenario artifacts cannot be written under a static serving root.')
  }
}
