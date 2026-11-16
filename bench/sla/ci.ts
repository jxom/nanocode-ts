import * as Fs from 'node:fs'

type Sample = {
  readonly round: number
  readonly arm: string
  readonly session: string
  readonly turn: number
  readonly metric: string
  readonly value: number
  readonly seq: number
  readonly build: string
  readonly match: string
}

type Failure = { readonly round: number; readonly arm: string; readonly turn: number }

type Interval = { readonly lo: number; readonly hi: number }

type Verdict = 'WIN' | 'TIE' | 'LOSS' | 'MISSING'

type Estimate = { readonly value: number; readonly ci: Interval; readonly verdict: Verdict }

type Arm = { readonly name: string; readonly n: number; readonly p50: number; readonly p99: number; readonly build: string }

type Cell = {
  readonly metric: string
  readonly turn: number | 'pooled'
  readonly better: 'lower' | 'higher'
  readonly verdict: Verdict
  readonly missing: readonly string[]
  readonly rounds: number
  readonly dropped: number
  readonly clusters: number
  readonly arms: readonly Arm[]
  readonly target: number | undefined
  readonly ratio_medians?: Estimate | undefined
  readonly ratio_p99?: Estimate | undefined
  readonly paired_ratio_median?: Estimate | undefined
}

const argv = process.argv.slice(2)
const arg = (name: string, fallback: string) => argv.find((a) => a.startsWith('--' + name + '='))?.slice(name.length + 3) ?? fallback
const flag = (name: string) => argv.includes('--' + name)

const files = argv.filter((a) => !a.startsWith('--'))
const arm = arg('arm', 'nc')
const vs = arg('vs', '')
const target = argv.some((a) => a.startsWith('--target=')) ? Number(arg('target', '')) : undefined
const metrics = arg('metric', '')
const pool = flag('pool-turns')
const seed = Number(arg('seed', '1'))
const resamples = Number(arg('resamples', '10000'))
const minRounds = Number(arg('min-rounds', '30'))
const better = arg('better', 'auto')
const dropIncomplete = flag('drop-incomplete')
const host = arg('host', '')
const json = arg('json', '')

if (!files.length || (!vs && target === undefined) || (vs && target !== undefined)) {
  console.error('usage: node bench/sla/ci.ts --arm=nc (--vs=<arm> | --target=<value>) [--metric=a,b] [--pool-turns] [--better=lower|higher|auto] [--seed=1] [--resamples=10000] [--min-rounds=30] [--drop-incomplete] [--host=<label>] [--json=<path>] <samples.jsonl>...')
  process.exit(2)
}

if (target !== undefined && !(Number.isFinite(target) && target > 0)) throw new Error('--target must be a positive number')
if (!(Number.isInteger(resamples) && resamples > 0)) throw new Error('--resamples must be a positive integer')
if (!['auto', 'lower', 'higher'].includes(better)) throw new Error('--better must be lower, higher or auto')

const runTsSkip = new Set(['index', 'turn', 'wall'])
const runTsSession = new Set(['ready'])

function load(paths: readonly string[]) {
  const samples: Sample[] = []
  const failures: Failure[] = []
  let line = 0
  let timed = true

  for (const path of paths) {
    for (const text of Fs.readFileSync(path, 'utf8').split('\n')) {
      if (!text.trim()) continue
      line++
      const row = JSON.parse(text) as { [key: string]: unknown }
      const where = path + ':' + line

      if (typeof row.arm === 'string' && typeof row.metric === 'string') {
        if (typeof row.round !== 'number' || !Number.isInteger(row.round)) throw new Error(where + ': round must be an integer')
        if (typeof row.value !== 'number' || !Number.isFinite(row.value)) throw new Error(where + ': value must be a finite number')
        if (typeof row.t !== 'number') timed = false
        samples.push({
          arm: row.arm,
          build: row.build === undefined ? '' : String(row.build),
          match: row.match === undefined ? '' : typeof row.match === 'string' ? row.match : JSON.stringify(row.match),
          metric: row.metric,
          round: row.round,
          seq: typeof row.t === 'number' ? row.t : line,
          session: row.session === undefined ? row.arm + '#' + row.round : String(row.session),
          turn: typeof row.turn === 'number' ? row.turn : 1,
          value: row.value,
        })
        continue
      }

      if (typeof row.lane === 'string' && typeof row.index === 'number') {
        const turn = typeof row.turn === 'number' ? row.turn : 1
        if (row.error !== undefined) {
          failures.push({ arm: row.lane, round: row.index, turn })
          continue
        }
        if (typeof row.wall !== 'number') timed = false
        for (const key of Object.keys(row)) {
          const value = row[key]
          if (runTsSkip.has(key) || typeof value !== 'number' || !Number.isFinite(value)) continue
          if (runTsSession.has(key) && turn !== 1) continue
          samples.push({ arm: row.lane, build: '', match: '', metric: key, round: row.index, seq: typeof row.wall === 'number' ? row.wall : line, session: row.lane + '#' + row.index, turn, value })
        }
        continue
      }

      throw new Error(where + ': neither a {round, arm, metric, value} row nor a bench/sla/run.ts {index, lane} row')
    }
  }

  const ordered = timed ? samples : samples.map((sample, index) => ({ ...sample, seq: index }))
  return { failures, ordering: timed ? ('time' as const) : ('line' as const), samples: ordered }
}

function quantile(sorted: ArrayLike<number>, p: number) {
  const n = sorted.length
  if (!n) return NaN
  const h = (n - 1) * p
  const lo = Math.floor(h)
  const hi = Math.min(n - 1, lo + 1)
  return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!)
}

const sorted = (values: readonly number[]) => Float64Array.from(values).sort()

function rng(state: number) {
  let s = state >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function judge(ci: Interval, direction: 'lower' | 'higher'): Verdict {
  const favours = direction === 'lower' ? ci.hi < 1 : ci.lo > 1
  const against = direction === 'lower' ? ci.lo > 1 : ci.hi < 1
  if (favours) return 'WIN'
  if (against) return 'LOSS'
  return 'TIE'
}

function clusters(rounds: readonly number[], samples: readonly Sample[]) {
  const parent = new Map(rounds.map((round) => [round, round]))
  const find = (round: number): number => {
    const up = parent.get(round)!
    if (up === round) return round
    const root = find(up)
    parent.set(round, root)
    return root
  }
  const seen = new Map<string, number>()

  for (const sample of samples) {
    const first = seen.get(sample.session)
    if (first === undefined) seen.set(sample.session, sample.round)
    else parent.set(find(sample.round), find(first))
  }

  const groups = new Map<number, number[]>()
  for (const round of rounds) {
    const root = find(round)
    groups.set(root, [...(groups.get(root) ?? []), round])
  }
  return [...groups.values()]
}

function overlapping(rounds: readonly number[], samples: readonly Sample[], arms: readonly string[]) {
  const spans = new Map<number, { lo: number; hi: number }>()
  for (const sample of samples) {
    if (!arms.includes(sample.arm) || !rounds.includes(sample.round)) continue
    const span = spans.get(sample.round) ?? { hi: -Infinity, lo: Infinity }
    span.lo = Math.min(span.lo, sample.seq)
    span.hi = Math.max(span.hi, sample.seq)
    spans.set(sample.round, span)
  }
  const order = [...spans.entries()].sort((a, b) => a[1].lo - b[1].lo)
  return order.slice(1).filter((entry, index) => entry[1].lo < order[index]![1].hi).map((entry) => entry[0])
}

const list = (values: readonly number[]) => values.slice(0, 10).join(',') + (values.length > 10 ? ',…' : '')

function analyse(metric: string, turn: number | 'pooled', cell: readonly Sample[], all: readonly Sample[], failures: readonly Failure[]): Cell {
  const direction = better === 'auto' ? (/tps$/.test(metric) ? 'higher' : 'lower') : (better as 'lower' | 'higher')
  const arms = target === undefined ? [arm, vs] : [arm]
  const mine = cell.filter((sample) => arms.includes(sample.arm))
  const byRound = new Map<number, Map<string, number[]>>()

  for (const sample of mine) {
    const round = byRound.get(sample.round) ?? new Map<string, number[]>()
    round.set(sample.arm, [...(round.get(sample.arm) ?? []), sample.value])
    byRound.set(sample.round, round)
  }

  const failed = failures.filter((failure) => arms.includes(failure.arm) && (turn === 'pooled' || failure.turn === turn))
  for (const failure of failed) if (!byRound.has(failure.round)) byRound.set(failure.round, new Map())

  const missing: string[] = []
  const incomplete = [...byRound.keys()]
    .filter((round) => {
      const entry = byRound.get(round)!
      if (failed.some((failure) => failure.round === round)) return true
      if (arms.some((name) => !entry.get(name)?.length)) return true
      return target === undefined && entry.get(arm)!.length !== entry.get(vs)!.length
    })
    .sort((a, b) => a - b)
  const rounds = [...byRound.keys()].filter((round) => !incomplete.includes(round)).sort((a, b) => a - b)

  if (incomplete.length && !dropIncomplete) missing.push('unbalanced: ' + incomplete.length + ' round(s) lack an arm, failed or have unequal sample counts (' + list(incomplete) + ')')
  if (rounds.length < minRounds) missing.push('N=' + rounds.length + ' complete rounds < ' + minRounds)

  const used = mine.filter((sample) => rounds.includes(sample.round))
  for (const name of arms) {
    const builds = new Set(used.filter((sample) => sample.arm === name).map((sample) => sample.build))
    if (builds.size > 1) missing.push('mixed builds in ' + name + ': ' + [...builds].map((b) => b || '(none)').join(', '))
  }
  const matches = new Set(used.map((sample) => sample.match))
  if (matches.size > 1) missing.push('unmatched configs: ' + [...matches].map((m) => m || '(none)').join(' | '))

  const overlaps = overlapping(rounds, all, arms)
  if (overlaps.length) missing.push('not interleaved: rounds ' + list(overlaps) + ' overlap an earlier round')

  const armOut = arms.map((name) => {
    const values = sorted(used.filter((sample) => sample.arm === name).map((sample) => sample.value))
    const builds = [...new Set(used.filter((sample) => sample.arm === name).map((sample) => sample.build))]
    return { build: builds.join(','), n: values.length, name, p50: quantile(values, 0.5), p99: quantile(values, 0.99) }
  })

  const groups = clusters(rounds, used)
  const base = { arms: armOut, better: direction, clusters: groups.length, dropped: dropIncomplete ? incomplete.length : 0, metric, rounds: rounds.length, target, turn }

  if (rounds.length < 2) return { ...base, missing, verdict: 'MISSING' }

  const perRound = new Map(rounds.map((round) => [round, { a: byRound.get(round)!.get(arm)!, b: target === undefined ? byRound.get(round)!.get(vs)! : [] }]))
  const roundRatio = new Map(
    rounds.map((round) => {
      const entry = perRound.get(round)!
      return [round, quantile(sorted(entry.a), 0.5) / (target ?? quantile(sorted(entry.b), 0.5))]
    }),
  )
  const point = {
    medians: armOut[0]!.p50 / (target ?? armOut[1]!.p50),
    p99: armOut[0]!.p99 / (target ?? armOut[1]!.p99),
    paired: quantile(sorted([...roundRatio.values()]), 0.5),
  }

  if (![point.medians, point.p99, point.paired].every(Number.isFinite)) missing.push('non-finite ratio (a reference median or p99 is 0)')

  const random = rng(seed)
  const draws = { medians: new Float64Array(resamples), p99: new Float64Array(resamples), paired: new Float64Array(resamples) }

  for (let r = 0; r < resamples; r++) {
    const a: number[] = []
    const b: number[] = []
    const ratios: number[] = []
    for (let k = 0; k < groups.length; k++) {
      for (const round of groups[Math.floor(random() * groups.length)]!) {
        const entry = perRound.get(round)!
        for (const value of entry.a) a.push(value)
        for (const value of entry.b) b.push(value)
        ratios.push(roundRatio.get(round)!)
      }
    }
    const sa = sorted(a)
    const sb = sorted(b)
    draws.medians[r] = quantile(sa, 0.5) / (target ?? quantile(sb, 0.5))
    draws.p99[r] = quantile(sa, 0.99) / (target ?? quantile(sb, 0.99))
    draws.paired[r] = quantile(sorted(ratios), 0.5)
  }

  const estimate = (value: number, values: Float64Array): Estimate => {
    values.sort()
    const ci = { hi: quantile(values, 0.975), lo: quantile(values, 0.025) }
    return { ci, value, verdict: missing.length ? 'MISSING' : judge(ci, direction) }
  }
  const paired = estimate(point.paired, draws.paired)

  return { ...base, missing, paired_ratio_median: paired, ratio_medians: estimate(point.medians, draws.medians), ratio_p99: estimate(point.p99, draws.p99), verdict: paired.verdict }
}

const data = load(files)
const wanted = metrics ? metrics.split(',') : [...new Set(data.samples.filter((sample) => sample.arm === arm).map((sample) => sample.metric))].sort()
const cells: Cell[] = []

for (const metric of wanted) {
  const ofMetric = data.samples.filter((sample) => sample.metric === metric)
  const turns = pool ? (['pooled'] as const) : [...new Set(ofMetric.map((sample) => sample.turn))].sort((a, b) => a - b)
  for (const turn of turns) cells.push(analyse(metric, turn, turn === 'pooled' ? ofMetric : ofMetric.filter((sample) => sample.turn === turn), data.samples, data.failures))
}

const fmt = (value: number | undefined) => (value === undefined || !Number.isFinite(value) ? '-' : Math.abs(value) >= 100 ? value.toFixed(1) : value.toPrecision(4))
const show = (entry: Estimate | undefined) => (entry ? fmt(entry.value) + ' [' + fmt(entry.ci.lo) + ', ' + fmt(entry.ci.hi) + ']' : '-')
const header = [
  '# ' + arm + ' vs ' + (target === undefined ? vs : 'target ' + target) + ' (' + files.join(', ') + ')',
  '',
  'host: ' + (host || '(not given)') + '; ordering: ' + data.ordering + '; seed ' + seed + '; ' + resamples + ' resamples of rounds clustered by session; linear quantiles (numpy default); run.ts failure rows: ' + data.failures.length + (dropIncomplete ? '; incomplete rounds dropped' : ''),
  '',
  '| metric | turn | better | N rounds | clusters | ' + arm + ' p50 / p99 | ' + (target === undefined ? vs + ' p50 / p99 | ' : '') + 'ratio of medians [95% CI] | ratio of p99 [95% CI] | paired round ratio median [95% CI] | verdict |',
  '|' + ' --- |'.repeat(target === undefined ? 11 : 10),
]
const rows = cells.map((cell) => {
  const sides = cell.arms.map((side) => fmt(side.p50) + ' / ' + fmt(side.p99) + ' (n=' + side.n + ')')
  const verdict = cell.verdict + (cell.missing.length ? ': ' + cell.missing.join('; ') : '') + (cell.dropped ? ' (' + cell.dropped + ' rounds dropped)' : '')
  return '| ' + [cell.metric, cell.turn, cell.better, cell.rounds, cell.clusters, ...sides, show(cell.ratio_medians), show(cell.ratio_p99), show(cell.paired_ratio_median), verdict].join(' | ') + ' |'
})

console.log([...header, ...rows].join('\n'))
if (json) Fs.writeFileSync(json, JSON.stringify({ arm, cells, files, host, min_rounds: minRounds, ordering: data.ordering, resamples, run_ts_failures: data.failures.length, seed, target, vs }, null, 2) + '\n')
