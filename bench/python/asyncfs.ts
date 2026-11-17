import { readFileSync } from 'node:fs'
import { Bash, MemoryFileSystem } from '../../src/bash/index.ts'

const bytes = readFileSync(process.argv[2] ?? 'dist/python.wasm')
const probes: readonly (readonly [string, string, RegExp])[] = [
  ['implementation', 'import sys; print(sys.implementation.name)', /^rustpython$/],
  [
    'array',
    'import numpy as np; print(np.arange(6).reshape(2, 3) * 1.5)',
    /^\[\[0\. +1\.5 +3\. *\]\n \[4\.5 +6\. +7\.5\]\]$/,
  ],
  [
    'default_rng',
    'import numpy as np; r = np.random.default_rng(0); print(r.integers(0, 10, 5).shape, round(float(r.random()), 3) < 1)',
    /^\(5,\) True$/,
  ],
  [
    'linalg',
    'import numpy as np; print(np.linalg.solve(np.array([[2.0, 1], [1, 3]]), np.array([3.0, 5])).round(3), round(float(np.linalg.det(np.eye(3) * 2)), 3))',
    /^\[0\.8 1\.4\] 8\.0$/,
  ],
  [
    'matplotlib',
    'import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt; plt.plot([1, 2, 3]); plt.savefig("p.png"); import os; print(os.path.getsize("p.png") > 0)',
    /^True$|No module named/,
  ],
  ['scipy', 'import scipy; print(scipy.__name__)', /^scipy$|No module named/],
  ['missing', 'import nosuchmodule_xyz', /No module named 'nosuchmodule_xyz'/],
]

function counted(fs: ReturnType<typeof MemoryFileSystem.create>, calls: Record<string, number>) {
  return new Proxy(fs, {
    get(target, key) {
      if (key === 'sync') return undefined
      const value = (target as unknown as Record<PropertyKey, unknown>)[key]
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        calls[String(key)] = (calls[String(key)] ?? 0) + 1
        return (value as (...args: unknown[]) => unknown).apply(target, args)
      }
    },
  })
}

async function shell(
  kind: 'sync' | 'async',
  calls: Record<string, number>,
  module = new WebAssembly.Module(bytes),
) {
  const memory = MemoryFileSystem.create()
  const fs = kind === 'sync' ? memory : counted(memory, calls)
  const bash = await Bash.create({
    fs,
    cwd: '/home/user',
    python: { module, cpuMs: 20000, stepsPerMs: 42000 },
    limits: { maxMemoryBytes: 256 << 20, timeoutMs: 120000 },
  })
  await bash.exec('mkdir -p /home/user')
  return bash
}

async function probe(bash: Awaited<ReturnType<typeof shell>>, code: string) {
  const started = performance.now()
  const result = await bash.exec("python3 -c '" + code + "'")
  return {
    ms: Math.round(performance.now() - started),
    out: (result.stdout + result.stderr).trim(),
  }
}

let failed = 0
for (const kind of ['async', 'sync'] as const) {
  const together = await shell(kind, {})
  for (const [name, code, expected] of probes) {
    const calls: Record<string, number> = {}
    const cold = await probe(await shell(kind, calls), code)
    const again = await probe(together, code)
    const ok = expected.test(cold.out) && expected.test(again.out)
    if (!ok) failed++
    console.log(
      JSON.stringify({
        kind,
        name,
        ok,
        coldMs: cold.ms,
        warmMs: again.ms,
        calls,
        out: ok ? undefined : [cold.out.slice(-300), again.out.slice(-300)],
      }),
    )
  }
}
process.exit(failed ? 1 : 0)
