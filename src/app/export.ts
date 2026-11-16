import type { ReplayRecord } from '../runtime/replay-schema'

export function downloadReplay(record: ReplayRecord): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = 'oilline-watch-run.json'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
