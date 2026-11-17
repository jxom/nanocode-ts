export type Snapshot = { peakLinear: number; liveLinear: number; instances: number; heap: number }

export type StepResult = {
  label: string
  ms: number
  ok: boolean
  exit: number
  error: string
  memory: Snapshot
}

export type Job = {
  id: string
  limit: string
  maxMemoryBytes: number | undefined
  warm: number
  probe: boolean
  needs: string | undefined
  files: readonly (readonly [string, Uint8Array])[]
  git: readonly string[]
  steps: readonly { command: string; label: string }[]
  expected: readonly string[]
}

export type Measured = {
  id: string
  limit: string
  runtime: string
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

type Shell = {
  exec: (command: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>
}

export type Host = {
  runtime: string
  python: WebAssembly.Module
  psh: WebAssembly.Module
  data: Uint8Array | ArrayBuffer
  compileMs: number
  create: (
    options: unknown,
  ) => Promise<{ bash: Shell; write: (path: string, data: Uint8Array) => Promise<void> }>
  heap: () => number
  rss: () => number
}

export const mib = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10

export function watch(module: WebAssembly.Module) {
  const memories: WeakRef<WebAssembly.Memory>[] = []
  const state = { image: 0 }
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
      state.image = memory.buffer.byteLength
    }
    return instance
  } as unknown as typeof WebAssembly.Instance
  Patched.prototype = Original.prototype
  WebAssembly.Instance = Patched
  const live = () => memories.map((ref) => ref.deref()).filter((memory) => memory !== undefined)
  return { live, state }
}

export async function measure(host: Host, job: Job): Promise<Measured> {
  const watched = watch(host.python)
  const created = await host.create({
    cwd: '/workspace',
    psh: host.psh,
    python: { module: host.python, data: host.data, cpuMs: 900000 },
    limits: {
      ...(job.maxMemoryBytes ? { maxMemoryBytes: job.maxMemoryBytes } : {}),
      timeoutMs: 900000,
    },
  })
  const bash = created.bash
  await bash.exec('mkdir -p /workspace')

  const dirs = [
    ...new Set(job.files.map(([path]) => ('/workspace/' + path).replace(/\/[^/]*$/, ''))),
  ]
  for (let at = 0; at < dirs.length; at += 200)
    await bash.exec('mkdir -p ' + dirs.slice(at, at + 200).join(' '))
  for (const [path, bytes] of job.files) await created.write('/workspace/' + path, bytes)
  for (const command of job.git) {
    const result = await bash.exec(command)
    if (result.exitCode !== 0) throw new Error('setup failed: ' + command + ': ' + result.stderr)
  }

  const gc = (globalThis as { gc?: () => void }).gc
  const snapshot = async (): Promise<Snapshot> => {
    const peakLinear = Math.max(0, ...watched.live().map((memory) => memory.buffer.byteLength))
    await new Promise((resolve) => setTimeout(resolve, 0))
    gc?.()
    const live = watched.live()
    return {
      peakLinear,
      liveLinear: live.reduce((sum, memory) => sum + memory.buffer.byteLength, 0),
      instances: live.length,
      heap: host.heap(),
    }
  }
  let mode = ''
  const pass = async (stopOnFail: boolean) => {
    const results: StepResult[] = []
    for (const [index, step] of job.steps.entries()) {
      const start = performance.now()
      const result = await bash.exec(step.command)
      const ms = performance.now() - start
      const lines = result.stdout.split('\n')
      mode = lines.find((line) => line.startsWith('mode='))?.slice(5) ?? mode
      const stdout = lines.filter((line) => !line.startsWith('mode=')).join('\n')
      const ok = result.exitCode === 0 && stdout === job.expected[index]
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
    job.needs !== undefined &&
    steps.some((step) => step.error.includes("No module named '" + job.needs + "'"))
  const passed = job.probe ? steps[0]?.ok === true : steps.every((step) => step.ok)
  const warmRuns: StepResult[][] = []
  if (passed && !job.probe)
    for (let round = 0; round < job.warm; round++) warmRuns.push(await pass(false))
  const totals = warmRuns
    .map((run) => run.reduce((sum, step) => sum + step.ms, 0))
    .sort((a, b) => a - b)
  const all = [...steps, ...warmRuns.flat()]
  return {
    id: job.id,
    limit: job.limit,
    runtime: host.runtime,
    status: missing
      ? 'skip'
      : passed && warmRuns.every((run) => run.every((step) => step.ok))
        ? 'pass'
        : 'fail',
    mode,
    coldMs: Math.round(steps.reduce((sum, step) => sum + step.ms, 0)),
    warmMs: totals.length ? Math.round(totals[Math.floor(totals.length / 2)]! * 10) / 10 : null,
    compileMs: Math.round(host.compileMs),
    imageLinearMiB: mib(watched.state.image),
    peakLinearMiB: mib(Math.max(0, ...all.map((step) => step.memory.peakLinear))),
    liveLinearMiB: mib(Math.max(0, ...all.map((step) => step.memory.liveLinear))),
    maxRssMiB: mib(host.rss()),
    heapMiB: mib(Math.max(0, ...all.map((step) => step.memory.heap))),
    largest: job.probe ? ([...steps].reverse().find((step) => step.ok)?.label ?? 'none') : null,
    steps,
    warmSteps: warmRuns.at(-1) ?? [],
  }
}
