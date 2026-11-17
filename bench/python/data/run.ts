import * as Child from 'node:child_process'
import * as Fs from 'node:fs'
import * as Net from 'node:net'
import * as Os from 'node:os'
import * as Path from 'node:path'
import * as Measure from './measure.ts'
import * as Workloads from './workloads.ts'

const limits: Record<string, number | undefined> = { '48': 48 << 20, unl: undefined }
const here = Path.dirname(new URL(import.meta.url).pathname)
const expected = JSON.parse(Fs.readFileSync(Path.join(here, 'expected.json'), 'utf8')) as Record<
  string,
  string[]
>

function job(workload: Workloads.Workload, limit: string, warm: number): Measure.Job {
  return {
    id: workload.id,
    limit,
    maxMemoryBytes: limits[limit],
    warm,
    probe: workload.probe === true,
    needs: workload.needs,
    files: [...workload.files()],
    git: workload.git ?? [],
    steps: workload.steps,
    expected: expected[workload.id] ?? [],
  }
}

async function node(
  dist: string,
  id: string,
  limit: string,
  warm: number,
): Promise<Measure.Measured> {
  const workload = Workloads.all.find((entry) => entry.id === id)!
  const start = performance.now()
  const python = new WebAssembly.Module(Fs.readFileSync(Path.join(dist, 'python.wasm')))
  const psh = new WebAssembly.Module(Fs.readFileSync(Path.join(dist, 'psh.wasm')))
  const compileMs = performance.now() - start
  const Bash = await import(Path.join(dist, 'bash', 'index.js'))
  return Measure.measure(
    {
      runtime: 'node',
      python,
      psh,
      data: Fs.readFileSync(Path.join(dist, 'python.data')),
      compileMs,
      create: async (options) => {
        const fs = Bash.MemoryFileSystem.create()
        return {
          bash: await Bash.Bash.create({ ...(options as object), fs }),
          write: (path, data) => fs.write(path, data),
        }
      },
      heap: () => {
        const usage = process.memoryUsage()
        return usage.heapUsed + usage.external
      },
      rss: () => process.resourceUsage().maxRSS * 1024,
    },
    job(workload, limit, warm),
  )
}

function bundle(dist: string, out: string) {
  Fs.rmSync(out, { recursive: true, force: true })
  Fs.mkdirSync(out, { recursive: true })
  for (const name of ['python.wasm', 'psh.wasm', 'python.data'])
    Fs.copyFileSync(Path.join(dist, name), Path.join(out, name))
  const esbuild = Child.spawnSync(
    'npx',
    [
      'esbuild',
      Path.join(here, 'worker.ts'),
      '--bundle',
      '--format=esm',
      '--platform=neutral',
      '--main-fields=module,main',
      '--external:./python.wasm',
      '--external:./psh.wasm',
      '--external:./python.data',
      '--external:node:*',
      '--alias:nanocode-dist=' + Path.join(dist, 'bash', 'index.js'),
      '--outfile=' + Path.join(out, 'worker.js'),
    ],
    { stdio: 'inherit' },
  )
  if (esbuild.status !== 0) throw new Error('esbuild failed')
}

async function port(): Promise<number> {
  return new Promise((resolve) => {
    const server = Net.createServer().listen(0, '127.0.0.1', () => {
      const address = server.address() as Net.AddressInfo
      server.close(() => resolve(address.port))
    })
  })
}

async function workerd(
  binary: string,
  out: string,
  workload: Workloads.Workload,
  limit: string,
  warm: number,
): Promise<Measure.Measured> {
  const listen = await port()
  Fs.writeFileSync(
    Path.join(out, 'config.capnp'),
    [
      'using Workerd = import "/workerd/workerd.capnp";',
      'const config :Workerd.Config = (services = [(name = "main", worker = .bench)], sockets = [(name = "http", address = "127.0.0.1:' +
        listen +
        '", http = (), service = "main")]);',
      'const bench :Workerd.Worker = (modules = [(name = "worker.js", esModule = embed "worker.js"), (name = "python.wasm", wasm = embed "python.wasm"), (name = "psh.wasm", wasm = embed "psh.wasm"), (name = "python.data", data = embed "python.data")], compatibilityDate = "2026-10-16", compatibilityFlags = ["nodejs_compat"]);',
      '',
    ].join('\n'),
  )
  const start = performance.now()
  const server = Child.spawn(binary, ['serve', Path.join(out, 'config.capnp'), '--experimental'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  server.stderr.on('data', (chunk) => (stderr += chunk))
  try {
    for (;;) {
      const up = await fetch('http://127.0.0.1:' + listen + '/up').then(
        (response) => response.ok,
        () => false,
      )
      if (up) break
      if (server.exitCode !== null || performance.now() - start > 60000)
        throw new Error('workerd did not start: ' + stderr.slice(-400))
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const startMs = performance.now() - start
    const body = job(workload, limit, warm)
    const response = await fetch('http://127.0.0.1:' + listen + '/run', {
      method: 'POST',
      body: JSON.stringify({
        ...body,
        files: body.files.map(([path, data]) => [path, Buffer.from(data).toString('base64')]),
      }),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(text.slice(-400) + stderr.slice(-400))
    const status = Fs.readFileSync('/proc/' + server.pid + '/status', 'utf8')
    const hwm = Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024
    return {
      ...(JSON.parse(text) as Measure.Measured),
      compileMs: Math.round(startMs),
      maxRssMiB: Measure.mib(hwm),
    }
  } finally {
    server.kill()
  }
}

function failed(id: string, limit: string, runtime: string, error: string): Measure.Measured {
  const memory = { peakLinear: 0, liveLinear: 0, instances: 0, heap: 0 }
  return {
    id,
    limit,
    runtime,
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
    steps: [{ label: 'crash', ms: 0, ok: false, exit: -1, error: error.slice(-400), memory }],
    warmSteps: [],
  }
}

function geomean(values: readonly number[]) {
  return values.length
    ? Math.round(Math.exp(values.reduce((sum, value) => sum + Math.log(value), 0) / values.length))
    : 0
}

function summarize(label: string, rows: readonly Measure.Measured[]) {
  const score = (limit: string) => {
    const set = rows.filter(
      (row) => row.limit === limit && row.status !== 'skip' && row.largest === null,
    )
    const passing = set.filter((row) => row.status === 'pass')
    return {
      pass: passing.length + '/' + set.length,
      warmMs: geomean(passing.map((row) => row.warmMs ?? row.coldMs)),
      coldMs: geomean(passing.map((row) => row.coldMs)),
      peakLinearMiB: Math.max(0, ...set.map((row) => row.peakLinearMiB)),
      maxRssMiB: Math.max(0, ...set.map((row) => row.maxRssMiB)),
      big: (
        rows.find((row) => row.limit === limit && row.largest !== null)?.largest ?? 'n/a'
      ).replace(' ', ''),
    }
  }
  const at48 = score('48')
  const unl = score('unl')
  const line = [
    'SCORE',
    label,
    'pass48=' + at48.pass,
    'passUnl=' + unl.pass,
    'warm48=' + at48.warmMs + 'ms',
    'cold48=' + at48.coldMs + 'ms',
    'warmUnl=' + unl.warmMs + 'ms',
    'coldUnl=' + unl.coldMs + 'ms',
    'peakLin48=' + at48.peakLinearMiB + 'MiB',
    'peakLinUnl=' + unl.peakLinearMiB + 'MiB',
    'rss48=' + at48.maxRssMiB + 'MiB',
    'big48=' + at48.big,
    'bigUnl=' + unl.big,
  ].join(' ')
  const table = [
    '| id | workload | limit | status | mode | cold ms | warm ms | peak linear MiB | live linear MiB | max RSS MiB | note |',
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
  ]
  for (const row of rows) {
    const workload = Workloads.all.find((entry) => entry.id === row.id)!
    const broken = row.steps.find((step) => !step.ok)
    const note =
      row.largest !== null
        ? 'largest ' + row.largest
        : row.status === 'fail'
          ? (broken?.error ?? 'warm run failed')
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
          row.maxRssMiB || '-',
          note,
        ].join(' | ') +
        ' |',
    )
  }
  return { line, table: table.join('\n') }
}

const args = process.argv.slice(2)
if (args[0] === '--child') {
  const result = await node(Path.resolve(args[1]!), args[2]!, args[3]!, Number(args[4]))
  process.stdout.write('\n' + JSON.stringify(result) + '\n')
  process.exit(0)
}

const option = (name: string, fallback: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1]! : fallback
}
const dist = Path.resolve(args[0] ?? 'dist')
const runtime = option('--runtime', 'node')
const label =
  option('--label', Path.basename(Path.dirname(dist))) + (runtime === 'node' ? '' : '-' + runtime)
const only = option('--only', Workloads.all.map((entry) => entry.id).join(',')).split(',')
const chosen = option('--limits', '48,unl').split(',')
const warm = option('--warm', '3')
const out = Path.resolve(option('--out', 'output/data/' + label + '.json'))
const worker = Path.resolve('output/data-worker')
if (runtime === 'workerd') bundle(dist, worker)
const rows: Measure.Measured[] = []
for (const workload of Workloads.all.filter((entry) => only.includes(entry.id)))
  for (const limit of chosen) {
    const row = await (async () => {
      if (runtime === 'workerd')
        return workerd(option('--workerd', 'workerd'), worker, workload, limit, Number(warm)).catch(
          (error: unknown) => failed(workload.id, limit, runtime, String(error)),
        )
      const result = Child.spawnSync(
        process.execPath,
        [
          '--expose-gc',
          new URL(import.meta.url).pathname,
          '--child',
          dist,
          workload.id,
          limit,
          warm,
        ],
        { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 1800000 },
      )
      const last = result.stdout?.trim().split('\n').at(-1) ?? ''
      return last.startsWith('{')
        ? (JSON.parse(last) as Measure.Measured)
        : failed(workload.id, limit, runtime, (result.stderr ?? '') + String(result.error ?? ''))
    })()
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
      runtime,
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
