export const DEVICE_SYSTEMS = ['iphone', 'ipad', 'android', 'chromeos', 'windows', 'mac', 'linux', 'other'] as const
export const DEVICE_BROWSERS = ['samsung', 'edge', 'opera', 'firefox', 'chrome', 'safari', 'other'] as const

const SYSTEMS: [RegExp, (typeof DEVICE_SYSTEMS)[number]][] = [
  [/iPhone|iPod/, 'iphone'],
  [/iPad/, 'ipad'],
  [/Android/, 'android'],
  [/CrOS/, 'chromeos'],
  [/Windows/, 'windows'],
  [/Macintosh|Mac OS X/, 'mac'],
  [/Linux/, 'linux'],
]

const BROWSERS: [RegExp, (typeof DEVICE_BROWSERS)[number]][] = [
  [/SamsungBrowser/, 'samsung'],
  [/EdgA?\/|EdgiOS/, 'edge'],
  [/OPR\/|Opera/, 'opera'],
  [/Firefox\/|FxiOS/, 'firefox'],
  [/CriOS|Chrome\//, 'chrome'],
  [/Safari\//, 'safari'],
]

export function deviceOf(userAgent: string | string[] | undefined): string {
  const ua = (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? ''
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1] ?? 'other'
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? 'other'
  return `${system}:${browser}`
}
