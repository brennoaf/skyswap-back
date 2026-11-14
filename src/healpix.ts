const D2R = Math.PI / 180
const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]
const JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7]

export function ang2pixNest(order: number, raDeg: number, decDeg: number): number {
  const nside = 2 ** order
  const theta = (90 - decDeg) * D2R
  const phi = (((raDeg % 360) + 360) % 360) * D2R
  const z = Math.cos(theta)
  const za = Math.abs(z)
  const tt = (phi / (Math.PI / 2)) % 4
  let face: number
  let ix: number
  let iy: number
  if (za <= 2 / 3) {
    const t1 = nside * (0.5 + tt)
    const t2 = nside * z * 0.75
    const jp = Math.floor(t1 - t2)
    const jm = Math.floor(t1 + t2)
    const ifp = Math.floor(jp / nside)
    const ifm = Math.floor(jm / nside)
    face = ifp === ifm ? ifp | 4 : ifp < ifm ? ifp : ifm + 8
    ix = jm & (nside - 1)
    iy = nside - (jp & (nside - 1)) - 1
  } else {
    const ntt = Math.min(3, Math.floor(tt))
    const tp = tt - ntt
    const tmp = nside * Math.sqrt(3 * (1 - za))
    const jp = Math.min(Math.floor(tp * tmp), nside - 1)
    const jm = Math.min(Math.floor((1 - tp) * tmp), nside - 1)
    if (z >= 0) {
      face = ntt
      ix = nside - jm - 1
      iy = nside - jp - 1
    } else {
      face = ntt + 8
      ix = jp
      iy = jm
    }
  }
  let pix = 0
  for (let b = 0; b < order; b++) pix += (((ix >> b) & 1) << (2 * b)) + (((iy >> b) & 1) << (2 * b + 1))
  return face * nside * nside + pix
}

export function pix2angNest(order: number, pix: number): [number, number] {
  const nside = 2 ** order
  const npface = nside * nside
  const face = Math.floor(pix / npface)
  const ipf = pix % npface
  let ix = 0
  let iy = 0
  for (let b = 0; b < order; b++) {
    ix |= ((ipf >> (2 * b)) & 1) << b
    iy |= ((ipf >> (2 * b + 1)) & 1) << b
  }
  const jr = (JRLL[face] as number) * nside - ix - iy - 1
  let nr: number
  let z: number
  let kshift: number
  if (jr < nside) {
    nr = jr
    z = 1 - (nr * nr) / (3 * npface)
    kshift = 0
  } else if (jr > 3 * nside) {
    nr = 4 * nside - jr
    z = (nr * nr) / (3 * npface) - 1
    kshift = 0
  } else {
    nr = nside
    z = ((2 * nside - jr) * 2) / (3 * nside)
    kshift = (jr - nside) & 1
  }
  let jp = Math.trunc(((JPLL[face] as number) * nr + ix - iy + 1 + kshift) / 2)
  if (jp > 4 * nside) jp -= 4 * nside
  if (jp < 1) jp += 4 * nside
  const phi = (jp - (kshift + 1) * 0.5) * (Math.PI / 2 / nr)
  return [phi / D2R, 90 - Math.acos(z) / D2R]
}
