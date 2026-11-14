const CP1252: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
}

const SUSPECT = /[ÃÂâ][\u0080-ÿŒ-™]/

export function repairText(s: string): string {
  if (!SUSPECT.test(s)) return s
  const bytes: number[] = []
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0
    if (code < 0x100) bytes.push(code)
    else if (CP1252[code] !== undefined) bytes.push(CP1252[code])
    else return s
  }
  const fixed = Buffer.from(bytes).toString('utf8')
  return fixed.includes('�') ? s : fixed
}

export function repairDeep<T>(value: T): T {
  if (typeof value === 'string') return repairText(value) as T
  if (Array.isArray(value)) return value.map((v) => repairDeep(v)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = repairDeep(v)
    return out as T
  }
  return value
}

export function normalizeName(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9+-]/g, '')
}
