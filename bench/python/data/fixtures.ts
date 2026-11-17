import * as Fs from 'node:fs'
import * as Path from 'node:path'

export type Writer = {
  dirs: (paths: readonly string[]) => Promise<void>
  write: (path: string, data: Uint8Array) => Promise<void>
}

export type Fixture = { files: Map<string, Uint8Array>; git?: readonly string[] }

const encoder = new TextEncoder()

function random(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const regions = [
  'africa',
  'asia-pacific',
  'europe',
  'latam',
  'middle-east',
  'north-america',
  'oceania',
  'south-asia',
]
const day = 86400000
const start = Date.UTC(2026, 0, 1)

export function sales(rows: number, seed = 1): Uint8Array {
  const next = random(seed)
  const base = Array.from({ length: 50 }, () => 200 + Math.floor(next() * 9800))
  const lines = ['date,region,product,units,price_cents,customer']
  for (let row = 0; row < rows; row++) {
    const date = new Date(start + Math.floor(next() * 365) * day).toISOString().slice(0, 10)
    const product = Math.floor(next() ** 1.5 * 50)
    const price = base[product]! + Math.floor((next() - 0.5) * 200)
    const customer = String(Math.floor(next() * 20000)).padStart(5, '0')
    lines.push(
      date +
        ',' +
        regions[Math.floor(next() * regions.length)] +
        ',sku-' +
        String(product).padStart(2, '0') +
        ',' +
        (1 + Math.floor(next() * 20)) +
        ',' +
        price +
        ',cust-' +
        customer,
    )
  }
  return encoder.encode(lines.join('\n') + '\n')
}

export function salesOfBytes(bytes: number): Uint8Array {
  return sales(Math.round((bytes / sales(1000).length) * 1000), 7)
}

export function records(count: number, seed = 2): Uint8Array {
  const next = random(seed)
  const countries = ['AR', 'BR', 'DE', 'GB', 'IN', 'KE', 'MX', 'NG', 'PH', 'SG', 'US', 'VN']
  const statuses = ['settled', 'settled', 'settled', 'pending', 'failed', 'refunded']
  const tags = ['payout', 'payroll', 'remittance', 'invoice', 'card', 'fx', 'refund', 'treasury']
  const out = Array.from({ length: count }, (_, id) => ({
    id,
    user: {
      name: 'user-' + Math.floor(next() * 5000),
      country: countries[Math.floor(next() * countries.length)]!,
    },
    amount: Math.round(next() ** 3 * 500000) / 100,
    status: statuses[Math.floor(next() * statuses.length)]!,
    created_at: new Date(start + Math.floor(next() * 300 * day)).toISOString(),
    tags: tags.filter(() => next() < 0.25),
    memo: 'transfer ' + Math.floor(next() * 1e9).toString(36),
  }))
  return encoder.encode(JSON.stringify(out))
}

export function tasks(count: number, seed = 3): Uint8Array {
  const next = random(seed)
  const out = Array.from({ length: count }, (_, id) => {
    const skill = next()
    const size = 10 + Math.floor(next() * 16)
    return {
      id: 'task-' + id,
      scores: Array.from(
        { length: size },
        () => Math.round(Math.min(1, Math.max(0, skill + (next() - 0.5) * 0.6)) * 1000) / 1000,
      ),
    }
  })
  return encoder.encode(JSON.stringify(out))
}

export function payments(rows: number, seed = 4): Uint8Array {
  const next = random(seed)
  const currencies = ['EUR', 'GBP', 'USD', 'USD', 'USD']
  const stamps = Array.from(
    { length: rows },
    () => start + Math.floor((next() * 180 * day) / 1000) * 1000,
  ).sort((a, b) => a - b)
  const lines = ['ts,amount_cents,currency']
  for (const stamp of stamps)
    lines.push(
      new Date(stamp).toISOString().slice(0, 19) +
        ',' +
        (100 + Math.floor(next() ** 2 * 2000000)) +
        ',' +
        currencies[Math.floor(next() * currencies.length)],
    )
  return encoder.encode(lines.join('\n') + '\n')
}

export function repo(count: number, seed = 5): Fixture {
  const next = random(seed)
  const tops = [
    ['src', 0.6],
    ['test', 0.15],
    ['docs', 0.1],
    ['packages', 0.1],
    ['scripts', 0.05],
  ] as const
  const subs = ['core', 'utils', 'actions', 'chains', 'clients', 'types', 'errors', 'accounts']
  const extensions = ['.ts', '.ts', '.ts', '.tsx', '.md', '.json', '.js', '.css']
  const files = new Map<string, Uint8Array>()
  while (files.size < count) {
    let pick = next()
    const top = tops.find((entry) => (pick -= entry[1]) < 0)?.[0] ?? 'src'
    const depth = Math.floor(next() * 3)
    const dirs = Array.from({ length: depth }, () => subs[Math.floor(next() * subs.length)]!)
    const extension = top === 'docs' ? '.md' : extensions[Math.floor(next() * extensions.length)]!
    const path = ['repo', top, ...dirs, 'file' + files.size + extension].join('/')
    const size = 40 + Math.floor(next() ** 6 * 20000)
    files.set(
      path,
      encoder.encode(
        ('export const value' + files.size + ' = ' + size + '\n')
          .repeat(Math.ceil(size / 30))
          .slice(0, size),
      ),
    )
  }
  files.set('repo/package.json', encoder.encode('{"name":"repo"}\n'))
  return {
    files,
    git: [
      'cd /workspace/repo && git init -q && git add . && git commit -qm init && echo "# repo" > README.md && git add README.md && git commit -qm readme',
    ],
  }
}

export async function place(writer: Writer, files: Map<string, Uint8Array>): Promise<void> {
  await writer.dirs([...new Set([...files.keys()].map((path) => Path.posix.dirname(path)))])
  for (const [path, data] of files) await writer.write(path, data)
}

export function disk(root: string): Writer {
  return {
    dirs: async (paths) => {
      for (const path of paths) Fs.mkdirSync(Path.join(root, path), { recursive: true })
    },
    write: async (path, data) => Fs.writeFileSync(Path.join(root, path), data),
  }
}
