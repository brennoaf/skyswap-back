import { promisify } from 'node:util'
import { gzip } from 'node:zlib'

const gzipAsync = promisify(gzip)
const FITS_BLOCK = 2880
const CARD = 80

export function shuffle(buf: Buffer, plane: number, word = 4): Buffer {
  const out = Buffer.allocUnsafe(buf.length)
  const count = plane / word
  for (let o = 0; o + plane <= buf.length; o += plane) {
    for (let i = 0; i < count; i++) for (let k = 0; k < word; k++) out[o + k * count + i] = buf[o + i * word + k] as number
  }
  return out
}

export function unshuffle(buf: Uint8Array, plane: number, word = 4): Uint8Array {
  const out = new Uint8Array(buf.length)
  const count = plane / word
  for (let o = 0; o + plane <= buf.length; o += plane) {
    for (let i = 0; i < count; i++) for (let k = 0; k < word; k++) out[o + i * word + k] = buf[o + k * count + i] as number
  }
  return out
}

export function acceptsGzip(header: string | string[] | undefined): boolean {
  const v = Array.isArray(header) ? header.join(',') : (header ?? '')
  return /\bgzip\b/i.test(v) && !/\bgzip\s*;\s*q=0(\.0+)?\b/i.test(v)
}

export function gzipped(buf: Buffer): Promise<Buffer> {
  return gzipAsync(buf, { level: 6 })
}

type Hdu = { name: string; start: number; end: number }

function hdus(buf: Buffer): Hdu[] {
  const out: Hdu[] = []
  let off = 0
  while (off + FITS_BLOCK <= buf.length) {
    const cards = new Map<string, string>()
    let head = 0
    let done = false
    while (!done) {
      if (off + head + FITS_BLOCK > buf.length) throw new Error('fits_truncated')
      const block = buf.subarray(off + head, off + head + FITS_BLOCK).toString('latin1')
      for (let i = 0; i < FITS_BLOCK / CARD; i++) {
        const card = block.slice(i * CARD, (i + 1) * CARD)
        const key = card.slice(0, 8).trim()
        if (key === 'END') {
          done = true
          break
        }
        if (card[8] === '=') cards.set(key, (card.slice(10).split('/')[0] ?? '').trim().replace(/^'|'$/g, '').trim())
      }
      head += FITS_BLOCK
    }
    const naxis = Number(cards.get('NAXIS') ?? 0)
    let n = naxis ? 1 : 0
    for (let i = 1; i <= naxis; i++) n *= Number(cards.get(`NAXIS${i}`) ?? 0)
    const bytes = (n * Math.abs(Number(cards.get('BITPIX') ?? 8))) / 8 + Number(cards.get('PCOUNT') ?? 0)
    const end = off + head + Math.ceil(bytes / FITS_BLOCK) * FITS_BLOCK
    if (end > buf.length) throw new Error('fits_truncated')
    out.push({ name: off === 0 ? 'PRIMARY' : (cards.get('EXTNAME') ?? ''), start: off, end })
    off = end
  }
  if (off !== buf.length) throw new Error('fits_truncated')
  return out
}

export function slimFits(buf: Buffer, keep: string[]): Buffer {
  const parts = hdus(buf).filter((h) => h.name === 'PRIMARY' || keep.includes(h.name))
  return Buffer.concat(parts.map((h) => buf.subarray(h.start, h.end)))
}
