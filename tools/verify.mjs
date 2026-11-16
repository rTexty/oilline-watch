import { spawnSync } from 'node:child_process'

for (const command of ['typecheck', 'lint', 'check:boundaries', 'test:unit', 'build']) {
  const result = spawnSync('npm', ['run', command], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) console.error(result.error.message)
  if (result.status !== 0) process.exit(result.status ?? 1)
}
