import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Bash, MemoryFileSystem } from '../../src/bash/index.ts'

const root = process.env.CAPI ?? join(process.env.HOME ?? '', 'rpw/capi')
const module = new WebAssembly.Module(readFileSync(process.argv[2] ?? 'dist/python.wasm'))
const psh = new WebAssembly.Module(readFileSync('dist/psh.wasm'))
const kept = new Set(['tokio', 'mio', 'socket2', 'futures-core', 'futures-sink', 'futures-task', 'futures-util', 'futures-channel', 'futures-io', 'futures-macro', 'tracing', 'tracing-core', 'slab', 'pin-project-lite', 'serde', 'serde_core', 'serde_derive', 'syn', 'quote', 'proc-macro2', 'unicode-ident', 'libc', 'wasi', 'windows-sys', 'windows-link', 'bytes', 'rustls-pki-types', 'zeroize'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

const packages = readdirSync(join(root, 'x')).sort()
const rows: { name: string; extensions: number; imported: number }[] = []
for (const name of packages) {
  const base = join(root, 'x', name)
  const files = walk(base).filter((path) => !path.includes('.dist-info') && !path.includes('.libs/'))
  const extensions = files.filter((path) => path.endsWith('.so')).map((path) => relative(base, path).split('.')[0]!.replaceAll('/', '.'))
  const fs = MemoryFileSystem.create()
  const bash = await Bash.create({ fs, cwd: '/workspace', psh, python: { module, stepsPerMs: 42000 }, limits: { timeoutMs: 60000 } })
  await bash.exec('mkdir -p /workspace /site')
  const sources = files.filter((path) => path.endsWith('.py'))
  const dirs = [...new Set(sources.map((path) => ('/site/' + relative(base, path)).replace(/\/[^/]*$/, '')))]
  if (dirs.length) await bash.exec('mkdir -p ' + dirs.join(' '))
  for (const path of sources) await fs.write('/site/' + relative(base, path), readFileSync(path))
  await fs.write('/workspace/probe.py', new TextEncoder().encode('import importlib, sys\nsys.path.insert(0, "/site")\nok = 0\nfor name in sys.argv[1:]:\n    try:\n        ok += not getattr(importlib.import_module(name), "__file__", "").endswith(".py")\n    except BaseException:\n        pass\nprint(ok)\n'))
  const result = await bash.exec('python3 probe.py ' + extensions.join(' '))
  rows.push({ name, extensions: extensions.length, imported: Number(result.stdout.trim()) || 0 })
}

const symbols = readFileSync(join(root, 'freq.txt'), 'utf8').trim().split('\n').map((line) => line.trim().split(/\s+/).pop()!)
const exported = new Set(WebAssembly.Module.exports(module).map((entry) => entry.name))
const lock = readFileSync('python/Cargo.lock', 'utf8')
const external = [...lock.matchAll(/name = "([^"]+)"\nversion = "[^"]+"\nsource = "registry/g)].map((match) => match[1]!).filter((name) => !kept.has(name))
const limits = await (async () => {
  const fs = MemoryFileSystem.create()
  const bash = await Bash.create({ fs, python: { module, stepsPerMs: 42000 }, limits: { maxMemoryBytes: 48 << 20, timeoutMs: 2000 } })
  const checks: [string, number][] = [['python3 -c "print(1)"', 0], ['python3 -c "s=\'a \'*30000000; print(len(s.split()))"', 126], ['python3 -c "while True: pass"', 124], ['python3 -c "import json; json.loads(\'x\')"', 1]]
  let passed = 0
  for (const [script, status] of checks) if ((await bash.exec(script)).exitCode === status) passed++
  return passed + '/' + checks.length
})()
const numpy = await (async () => {
  const fs = MemoryFileSystem.create()
  const bash = await Bash.create({ fs, cwd: '/workspace', psh, python: { module, stepsPerMs: 42000 }, limits: { timeoutMs: 120000 } })
  const checks: [string, string][] = [
    ['np.linspace(0, 1, 5)', '[0.   0.25 0.5  0.75 1.  ]'],
    ['np.sin(np.linspace(0, np.pi, 3)).round(6)', '[0. 1. 0.]'],
    ['np.arange(12).reshape(3, 4).sum(axis=0)', '[12 15 18 21]'],
    ['np.arange(6).reshape(2, 3) + np.array([10, 20, 30])', '[[10 21 32]\n [13 24 35]]'],
    ['np.array([1.5, 2.7]).astype(int)', '[1 2]'],
    ['np.array(["1", "2"]).astype(float)', '[1. 2.]'],
    ['np.linalg.solve(np.array([[3.0, 1.0], [1.0, 2.0]]), [9.0, 8.0])', '[2. 3.]'],
    ['np.linalg.det(np.array([[3.0, 1.0], [1.0, 2.0]])).round(6)', '5.0'],
    ['np.linalg.inv(np.array([[3.0, 1.0], [1.0, 2.0]])).round(4)', '[[ 0.4 -0.2]\n [-0.2  0.6]]'],
    ['np.linalg.eig(np.array([[2.0, 0.0], [0.0, 3.0]]))[0]', '[2.+0.j 3.+0.j]'],
    ['np.random.default_rng(0).normal(size=3)', '[ 0.12573022 -0.13210486  0.64042265]'],
    ['np.fft.fft(np.array([1.0, 2.0, 3.0, 4.0]))', '[10.+0.j -2.+2.j -2.+0.j -2.-2.j]'],
    ['np.unique([3, 1, 3, 2])', '[1 2 3]'],
    ['np.char.upper(np.array(["ab"]))', "['AB']"],
  ]
  const script = 'import numpy as np\n' + checks.map(([expression]) => 'print(str(' + expression + '), end="\\0")').join('\n') + '\n'
  await fs.write('/workspace/numpy_check.py', new TextEncoder().encode(script))
  const outputs = (await bash.exec('python3 numpy_check.py')).stdout.split('\0')
  return checks.filter(([, expected], index) => outputs[index] === expected).length + '/' + checks.length
})()
const imported = rows.reduce((sum, row) => sum + row.imported, 0)
const extensions = rows.reduce((sum, row) => sum + row.extensions, 0)
console.log(JSON.stringify({ imported, extensions, packages: rows.filter((row) => row.extensions && row.imported === row.extensions).length + '/' + rows.length, capi: symbols.filter((symbol) => exported.has(symbol)).length + '/' + symbols.length, bytes: statSync(process.argv[2] ?? 'dist/python.wasm').size, external: external.length, externalCrates: external, limits, numpy, rows }))
