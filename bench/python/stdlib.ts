import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    a: { type: 'string', default: 'python3' },
    b: { type: 'string' },
    n: { type: 'string', default: '30' },
    reps: { type: 'string', default: '3' },
    only: { type: 'string', default: '' },
    json: { type: 'string' },
  },
})

if (!values.b) throw new Error('usage: node bench/python/stdlib.ts --b <python under test> [--a python3] [--n 30] [--reps 3] [--only a,b] [--json out.json]')

const script = join(import.meta.dirname, 'stdlib.py')
const rounds = Number(values.n)
const only = values.only ? values.only.split(',').join(' ') : ''
const commands = { a: values.a, b: values.b }

type Sample = Record<string, readonly [number, number]>

function run(command: string): Sample {
  const result = spawnSync(command + ' ' + script + ' ' + values.reps + ' ' + only, { shell: true, encoding: 'utf8', maxBuffer: 1 << 26 })

  if (result.status !== 0) throw new Error(command + ' exited ' + result.status + ': ' + result.stderr)
  return JSON.parse(result.stdout) as Sample
}

function random(seed: number) {
  let state = seed

  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function median(values: readonly number[]) {
  const sorted = [...values].sort((x, y) => x - y)
  const middle = sorted.length >> 1

  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function bootstrap(ratios: readonly number[], options: { statistic: (values: readonly number[]) => number }) {
  const next = random(1)
  const draws: number[] = []

  for (let i = 0; i < 5000; i++) draws.push(options.statistic(ratios.map(() => ratios[Math.floor(next() * ratios.length)]!)))
  draws.sort((x, y) => x - y)
  return [draws[125]!, draws[4874]!] as const
}

const samples: { a: Sample[]; b: Sample[] } = { a: [], b: [] }
const loads: number[] = []

run(commands.a)
run(commands.b)

for (let round = 0; round < rounds; round++) {
  loads.push(os.loadavg()[0]!)

  const order = round % 2 ? (['b', 'a'] as const) : (['a', 'b'] as const)

  for (const side of order) samples[side].push(run(commands[side]))
  process.stderr.write('round ' + (round + 1) + '/' + rounds + ' load ' + loads.at(-1)!.toFixed(1) + '\n')
}

const names = Object.keys(samples.a[0]!)
const rows = names.map((name) => {
  const a = samples.a.map((sample) => sample[name]![0])
  const b = samples.b.map((sample) => sample[name]![0])
  const ratios = a.map((value, i) => b[i]! / value)
  const ci = bootstrap(ratios, { statistic: median })
  const same = samples.a.every((sample, i) => sample[name]![1] === samples.b[i]![name]![1])

  return { name, aMs: median(a) / 1e6, bMs: median(b) / 1e6, ratio: median(ratios), ci, verdict: ci[0] > 1 ? 'LOSS' : ci[1] < 1 ? 'WIN' : 'TIE', same }
})

const logRatios = samples.a.map((sample, i) => names.reduce((sum, name) => sum + Math.log(samples.b[i]![name]![0] / sample[name]![0]), 0) / names.length)
const geomean = Math.exp(median(logRatios))
const geomeanCi = bootstrap(logRatios, { statistic: median }).map(Math.exp)
const worst = [...rows].sort((x, y) => y.ratio - x.ratio).slice(0, 5).map((row) => row.name)

for (const row of rows) console.log([row.name.padEnd(22), row.aMs.toFixed(3).padStart(10), row.bMs.toFixed(3).padStart(10), row.ratio.toFixed(3).padStart(7), ('[' + row.ci[0].toFixed(3) + ', ' + row.ci[1].toFixed(3) + ']').padEnd(17), row.verdict, row.same ? '' : 'OUTPUT DIFFERS'].join(' '))
console.log('geomean b/a ' + geomean.toFixed(3) + ' [' + geomeanCi.map((value) => value.toFixed(3)).join(', ') + '], wins ' + rows.filter((row) => row.verdict === 'WIN').length + ', ties ' + rows.filter((row) => row.verdict === 'TIE').length + ', losses ' + rows.filter((row) => row.verdict === 'LOSS').length + ', worst ' + worst.join(' '))
console.log('load ' + Math.min(...loads).toFixed(1) + '-' + Math.max(...loads).toFixed(1) + ', ' + os.cpus().length + ' cpus')

if (values.json) writeFileSync(values.json, JSON.stringify({ commands, rounds, reps: Number(values.reps), loads, geomean, geomeanCi, worst, rows, samples }, null, 1))
