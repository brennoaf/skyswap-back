import { Worker } from 'node:worker_threads'
import { answerPoint, type PointAnswer, type PointQuery } from './index-lookup.js'

type Waiting = { q: PointQuery; resolve: (a: PointAnswer) => void; reject: (e: unknown) => void }

export class IndexService {
  private worker: Worker | null = null
  private readonly waiting = new Map<number, Waiting>()
  private seq = 0
  private inline: boolean

  constructor(useWorker: boolean) {
    this.inline = !useWorker
  }

  get threaded(): boolean {
    return !this.inline
  }

  ask(q: PointQuery): Promise<PointAnswer> {
    const w = this.start()
    if (!w) return answerPoint(q)
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      this.waiting.set(id, { q, resolve, reject })
      w.postMessage({ id, q })
    })
  }

  async close(): Promise<void> {
    const w = this.worker
    this.fallBack()
    await w?.terminate()
  }

  private start(): Worker | null {
    if (this.inline) return null
    if (this.worker) return this.worker
    try {
      const w = new Worker(new URL('./index-worker-boot.mjs', import.meta.url))
      w.unref()
      w.on('message', (m: { id: number; answer?: PointAnswer; error?: string }) => {
        const p = this.waiting.get(m.id)
        if (!p) return
        this.waiting.delete(m.id)
        if (m.answer) p.resolve(m.answer)
        else p.reject(new Error(m.error ?? 'index_failed'))
      })
      w.on('error', () => this.fallBack())
      w.on('exit', () => this.fallBack())
      this.worker = w
    } catch {
      this.fallBack()
    }
    return this.worker
  }

  private fallBack(): void {
    this.inline = true
    this.worker = null
    const left = [...this.waiting.values()]
    this.waiting.clear()
    for (const p of left) answerPoint(p.q).then(p.resolve, p.reject)
  }
}
