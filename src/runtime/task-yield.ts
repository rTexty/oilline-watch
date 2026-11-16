export function createTaskYield() {
  const { port1, port2 } = new MessageChannel()
  const pending: Array<() => void> = []
  port1.onmessage = () => pending.shift()?.()
  return {
    yieldTask: () => new Promise<void>((resolve) => {
      pending.push(resolve)
      port2.postMessage(null)
    }),
    close: () => {
      port1.close()
      port2.close()
    },
  }
}
