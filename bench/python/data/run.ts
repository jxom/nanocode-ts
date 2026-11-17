import * as Child from 'node:child_process'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Workloads from './workloads.ts'

type Snapshot = {
  peakLinear: number
  liveLinear: number
  instances: number
  heap: number
  external: number
  rss: number
}

type StepResult = {
  label: string
  ms: number
  ok: boolean
  exit: number
  error: string
  memory: Snapshot
}

type Measured = {
  id: string
  limit: string
  status: 'pass' | 'fail' | 'skip'
  mode: string
  coldMs: number
  warmMs: number | null
  compileMs: number
  imageLinearMiB: number
  peakLinearMiB: number
  liveLinearMiB: number
  maxRssMiB: number
  heapMiB: number
  largest: string | null
  steps: StepResult[]
  warmSteps: StepResult[]
}

const mib = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10
const limits: Record<string, number | undefined> = { '48': 48 << 20, unl: undefined }
const here = Path.dirname(new URL(import.meta.url).pathname)
const expected = JSON.parse(Fs.readFileSync(Path.join(here, 'expected.json'), 'utf8')) as Record<
  string,
  string[]
>

async function child(dist: string, id: string, limit: string, warm: number): Promise<Measured> {
  const workload = Workloads.all.find((entry) => entry.id === id)!
  const memories: WeakRef<WebAssembly.Memory>[] = []
  let image = 0
  const compileStart = performance.now()
  const module = new WebAssembly.Module(Fs.readFileSync(Path.join(dist, 'python.wasm')))
  const psh = new WebAssembly.Module(Fs.readFileSync(Path.join(dist, 'psh.wasm')))
  const compileMs = performance.now() - compileStart
  const Original = WebAssembly.Instance
  const Patched = function (
    this: unknown,
    target: WebAssembly.Module,
    imports?: WebAssembly.Imports,
  ) {
    const instance = new Original(target, imports)
    const memory = instance.exports.memory
    if (target === module && memory instanceof WebAssembly.Memory) {
      memories.push(new WeakRef(memory))
      image = memory.buffer.byteLength
    }
    return instance
  } as unknown as typeof WebAssembly.Instance
  Patched.prototype = Original.prototype
  WebAssembly.Instance = Patched
  const Bash = await import(Path.join(dist, 'bash', 'index.js'))
  const data = Fs.readFileSync(Path.join(dist, 'python.data'))
  const fs = Bash.MemoryFileSystem.create()
  const maxMemoryBytes = limits[limit]
  const bash = await Bash.Bash.create({
    fs,
    cwd: '/workspace',
    psh,
    python: { module, data, cpuMs: 900000 },
    limits: { ...(maxMemoryBytes ? { maxMemoryBytes } : {}), timeoutMs: 900000 },
  })
  await bash.exec('mkdir -p /workspace')

  const files = workload.files()
  const dirs = [
    ...new Set([...files.keys()].map((path) => '/workspace/' + Path.posix.dirname(path))),
  ]
  for (let at = 0; at < dirs.length; at += 200)
    await bash.exec('mkdir -p ' + dirs.slice(at, at + 200).join(' '))
  for (const [path, bytes] of files) await fs.write('/workspace/' + path, bytes)
  for (const command of workload.git ?? []) {
    const result = await bash.exec(command)
    if (result.exitCode !== 0) throw new Error('setup failed: ' + command + ': ' + result.stderr)
  }

  const gc = (globalThis as { gc?: () => void }).gc
  const linear = () => memories.map((ref) => ref.deref()).filter((memory) => memory !== undefined)
  const snapshot = async (): Promise<Snapshot> => {
    const peakLinear = Math.max(0, ...linear().map((memory) => memory.buffer.byteLength))
    await new Promise((resolve) => setTimeout(resolve, 0))
    gc?.()
    const live = linear()
    const usage = process.memoryUsage()
    return {
      peakLinear,
      liveLinear: live.reduce((sum, memory) => sum + memory.buffer.byteLength, 0),
      instances: live.length,
      heap: usage.heapUsed,
      external: usage.external,
      rss: usage.rss,
    }
  }
  let mode = ''
  const pass = async (stopOnFail: boolean) => {
    const results: StepResult[] = []
    for (const [index, step] of workload.steps.entries()) {
      const start = performance.now()
      const result = await bash.exec(step.command)
      const ms = performance.now() - start
      const lines = result.stdout.split('\n')
      mode = lines.find((line: string) => line.startsWith('mode='))?.slice(5) ?? mode
      const stdout = lines.filter((line: string) => !line.startsWith('mode=')).join('\n')
      const ok = result.exitCode === 0 && stdout === expected[id]![index]
      results.push({
        label: step.label,
        ms: Math.round(ms * 10) / 10,
        ok,
        exit: result.exitCode,
        error: ok ? '' : (result.stderr || result.stdout).slice(-400),
        memory: await snapshot(),
      })
      if (!ok && stopOnFail) break
    }
    return results
  }

  const steps = await pass(true)
  const missing =
    workload.needs !== undefined &&
    steps.some((step) => step.error.includes("No module named '" + workload.needs + "'"))
  const passed = workload.probe ? steps[0]?.ok === true : steps.every((step) => step.ok)
  const warmRuns: StepResult[][] = []
  if (passed && !workload.probe)
    for (let round = 0; round < warm; round++) warmRuns.push(await pass(false))
  const totals = warmRuns
    .map((run) => run.reduce((sum, step) => sum + step.ms, 0))
    .sort((a, b) => a - b)
  const all = [...steps, ...warmRuns.flat()]
  return {
    id,
    limit,
    status: missing
      ? 'skip'
      : passed && warmRuns.every((run) => run.every((step) => step.ok))
        ? 'pass'
        : 'fail',
    mode,
    coldMs: Math.round(steps.reduce((sum, step) => sum + step.ms, 0)),
    warmMs: totals.length ? Math.round(totals[Math.floor(totals.length / 2)]! * 10) / 10 : null,
    compileMs: Math.round(compileMs),
    imageLinearMiB: mib(image),
    peakLinearMiB: mib(Math.max(0, ...all.map((step) => step.memory.peakLinear))),
    liveLinearMiB: mib(Math.max(0, ...all.map((step) => step.memory.liveLinear))),
    maxRssMiB: mib(process.resourceUsage().maxRSS * 1024),
    heapMiB: mib(Math.max(0, ...all.map((step) => step.memory.heap + step.memory.external))),
    largest: workload.probe
      ? ([...steps].reverse().find((step) => step.ok)?.label ?? 'none')
      : null,
    steps,
    warmSteps: warmRuns.at(-1) ?? [],
  }
}

function geomean(values: readonly number[]) {
  return values.length
    ? Math.round(Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length))
    : 0
}

function summarize(label: string, rows: readonly Measured[]) {
  const counted = (limit: string) =>
    rows.filter((row) => row.limit === limit && row.status !== 'skip' && row.largest === null)
  const score = (limit: string) => {
    const set = counted(limit)
    const passing = set.filter((row) => row.status === 'pass')
    const probe = rows.find((row) => row.limit === limit && row.largest !== null)
    return {
      pass: passing.length + '/' + set.length,
      warmMs: geomean(passing.map((row) => row.warmMs ?? row.coldMs)),
      coldMs: geomean(passing.map((row) => row.coldMs)),
      peakLinearMiB: Math.max(0, ...set.map((row) => row.peakLinearMiB)),
      maxRssMiB: Math.max(0, ...set.map((row) => row.maxRssMiB)),
      big: probe?.largest ?? 'n/a',
    }
  }
  const at48 = score('48')
  const unl = score('unl')
  const line =
    'SCORE ' +
    label +
    ' pass48=' +
    at48.pass +
    ' passUnl=' +
    unl.pass +
    ' warm48=' +
    at48.warmMs +
    'ms cold48=' +
    at48.coldMs +
    'ms warmUnl=' +
    unl.warmMs +
    'ms coldUnl=' +
    unl.coldMs +
    'ms peakLin48=' +
    at48.peakLinearMiB +
    'MiB peakLinUnl=' +
    unl.peakLinearMiB +
    'MiB rss48=' +
    at48.maxRssMiB +
    'MiB big48=' +
    at48.big +
    ' bigUnl=' +
    unl.big
  const table = [
    '| id | workload | limit | status | mode | cold ms | warm ms | peak linear MiB | live linear MiB | max RSS MiB | note |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ]
  for (const row of rows) {
    const workload = Workloads.all.find((entry) => entry.id === row.id)!
    const failed = row.steps.find((step) => !step.ok)
    const note =
      row.largest !== null
        ? 'largest ' + row.largest
        : row.status === 'fail'
          ? (failed?.error ?? 'warm run failed')
              .replace(/\s+/g, ' ')
              .replaceAll('|', '/')
              .slice(-120)
          : ''
    table.push(
      '| ' +
        [
          row.id,
          workload.name,
          row.limit,
          row.status,
          row.mode || '-',
          row.coldMs,
          row.warmMs ?? '-',
          row.peakLinearMiB,
          row.liveLinearMiB,
          row.maxRssMiB,
          note,
        ].join(' | ') +
        ' |',
    )
  }
  return { line, table: table.join('\n') }
}

const args = process.argv.slice(2)
if (args[0] === '--child') {
  const result = await child(Path.resolve(args[1]!), args[2]!, args[3]!, Number(args[4]))
  process.stdout.write('\n' + JSON.stringify(result) + '\n')
  process.exit(0)
}

const option = (name: string, fallback: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1]! : fallback
}
const dist = Path.resolve(args[0] ?? 'dist')
const label = option('--label', Path.basename(Path.dirname(dist)))
const only = option('--only', Workloads.all.map((entry) => entry.id).join(',')).split(',')
const chosen = option('--limits', '48,unl').split(',')
const warm = option('--warm', '3')
const out = Path.resolve(option('--out', 'output/data/' + label + '.json'))
const rows: Measured[] = []
for (const workload of Workloads.all.filter((entry) => only.includes(entry.id)))
  for (const limit of chosen) {
    const result = Child.spawnSync(
      process.execPath,
      ['--expose-gc', new URL(import.meta.url).pathname, '--child', dist, workload.id, limit, warm],
      { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 1800000 },
    )
    const last = result.stdout?.trim().split('\n').at(-1) ?? ''
    const row: Measured = last.startsWith('{')
      ? JSON.parse(last)
      : {
          id: workload.id,
          limit,
          status: 'fail',
          mode: '',
          coldMs: 0,
          warmMs: null,
          compileMs: 0,
          imageLinearMiB: 0,
          peakLinearMiB: 0,
          liveLinearMiB: 0,
          maxRssMiB: 0,
          heapMiB: 0,
          largest: null,
          steps: [
            {
              label: 'crash',
              ms: 0,
              ok: false,
              exit: result.status ?? -1,
              error: ((result.stderr ?? '') + String(result.error ?? '')).slice(-400),
              memory: { peakLinear: 0, liveLinear: 0, instances: 0, heap: 0, external: 0, rss: 0 },
            },
          ],
          warmSteps: [],
        }
    rows.push(row)
    console.error(
      row.id,
      row.limit,
      row.status,
      row.coldMs + 'ms',
      (row.warmMs ?? '-') + 'ms',
      row.peakLinearMiB + 'MiB',
      row.largest ?? '',
      row.status === 'fail' ? row.steps.find((step) => !step.ok)?.error.slice(-200) : '',
    )
  }
const summary = summarize(label, rows)
Fs.mkdirSync(Path.dirname(out), { recursive: true })
Fs.writeFileSync(
  out,
  JSON.stringify(
    {
      label,
      dist,
      date: new Date().toISOString(),
      node: process.version,
      score: summary.line,
      rows,
    },
    null,
    2,
  ) + '\n',
)
console.log(summary.table)
console.log(summary.line)
