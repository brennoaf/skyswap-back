import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { readFile, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface Entry {
  size: number
  used: number
}

export class DiskCache {
  private entries = new Map<string, Entry>()
  private total = 0
  hits = 0
  misses = 0

  constructor(readonly dir: string, readonly maxBytes: number, private readonly now: () => number = Date.now) {
    mkdirSync(dir, { recursive: true })
    const found: [string, Entry][] = []
    for (const name of readdirSync(dir)) {
      if (/^[0-9a-f]{40}\.[0-9a-f]+\.tmp$/.test(name)) rmSync(join(dir, name), { force: true })
      if (!/^[0-9a-f]{40}$/.test(name)) continue
      const st = statSync(join(dir, name))
      found.push([name, { size: st.size, used: st.mtimeMs }])
    }
    found.sort((a, b) => a[1].used - b[1].used)
    for (const [name, e] of found) {
      this.entries.set(name, e)
      this.total += e.size
    }
  }

  static keyOf(...parts: (string | number)[]): string {
    return createHash('sha1').update(parts.join('|')).digest('hex')
  }

  get bytes(): number {
    return this.total
  }

  get count(): number {
    return this.entries.size
  }

  async get(key: string): Promise<Buffer | null> {
    const e = this.entries.get(key)
    if (!e) {
      this.misses++
      return null
    }
    try {
      const buf = await readFile(join(this.dir, key))
      this.entries.delete(key)
      e.used = this.now()
      this.entries.set(key, e)
      const t = new Date(e.used)
      utimes(join(this.dir, key), t, t).catch(() => undefined)
      this.hits++
      return buf
    } catch {
      this.entries.delete(key)
      this.total -= e.size
      this.misses++
      return null
    }
  }

  async put(key: string, buf: Buffer): Promise<void> {
    if (buf.length > this.maxBytes) return
    const tmp = join(this.dir, `${key}.${randomBytes(6).toString('hex')}.tmp`)
    try {
      await writeFile(tmp, buf)
      await rename(tmp, join(this.dir, key))
    } catch {
      await rm(tmp, { force: true })
      return
    }
    const old = this.entries.get(key)
    if (old) {
      this.entries.delete(key)
      this.total -= old.size
    }
    this.entries.set(key, { size: buf.length, used: this.now() })
    this.total += buf.length
    await this.evict()
  }

  private async evict(): Promise<void> {
    for (const [key, e] of this.entries) {
      if (this.total <= this.maxBytes) break
      this.entries.delete(key)
      this.total -= e.size
      await rm(join(this.dir, key), { force: true })
    }
  }
}
