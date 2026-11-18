import { readFileSync } from 'node:fs'
import { Bash, MemoryFileSystem } from '../../src/bash/index.ts'
import { cases } from './probes.ts'

const dist = process.env.NANOCODE_DIST ?? 'dist'
const pythonDist = process.env.NANOCODE_PYTHON_DIST ?? dist
const module = new WebAssembly.Module(readFileSync(pythonDist + '/python.wasm'))
const data = readFileSync(pythonDist + '/python.data')
const psh = new WebAssembly.Module(readFileSync(dist + '/psh.wasm'))

const only = process.argv.slice(2)
let ok = 0
let total = 0
for (const [name, code] of cases) {
  if (only.length && !only.includes(name)) continue
  total++
  const bash = await Bash.create({
    cwd: '/workspace',
    fetch,
    fs: MemoryFileSystem.create(),
    limits: { maxMemoryBytes: 512 << 20, timeoutMs: 300000 },
    psh,
    python: { cpuMs: 300000, data, module, stepsPerMs: 42000 },
  })
  const started = performance.now()
  const installed = await bash.exec('pip install -q ' + name)
  const installMs = Math.round(performance.now() - started)
  await bash.writeFile('/workspace/probe.py', code)
  const ran = installed.exitCode === 0 ? await bash.exec('python3 probe.py') : undefined
  const pass = ran !== undefined && ran.exitCode === 0
  if (pass) ok++
  const tail = (text: string) => text.trim().split('\n').slice(-2).join(' | ').slice(0, 300)
  console.log(
    JSON.stringify({
      name,
      pass,
      installMs,
      runMs: Math.round(performance.now() - started) - installMs,
      out: pass
        ? tail(ran.stdout)
        : tail(installed.stderr + installed.stdout + (ran ? ran.stderr + ran.stdout : '')),
    }),
  )
}
console.log(JSON.stringify({ ok, total }))
