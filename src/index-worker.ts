import { parentPort } from 'node:worker_threads'
import { answerPoint, type PointQuery } from './index-lookup.js'

parentPort?.on('message', (m: { id: number; q: PointQuery }) => {
  answerPoint(m.q).then(
    (answer) => parentPort?.postMessage({ id: m.id, answer }),
    (err: unknown) => parentPort?.postMessage({ id: m.id, error: String(err) }),
  )
})
