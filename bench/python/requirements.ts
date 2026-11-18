import * as Assert from 'node:assert/strict'
import * as Fs from 'node:fs'
import { Bash, MemoryFileSystem } from '../../src/bash/index.ts'

const dist = process.env.NANOCODE_DIST ?? 'dist'
const pythonDist = process.env.NANOCODE_PYTHON_DIST ?? dist
const module = new WebAssembly.Module(Fs.readFileSync(pythonDist + '/python.wasm'))
const data = Fs.readFileSync(pythonDist + '/python.data')
const psh = new WebAssembly.Module(Fs.readFileSync(dist + '/psh.wasm'))
const cases = [
  ['matching builtin', 'pip install numpy==2.5.5', true],
  ['mismatched builtin', 'pip install numpy==0', false],
  ['repeated builtin conflict', 'pip install numpy numpy==0', false],
  ['compatible builtin range', "pip install 'numpy>=2,<3'", true],
  ['unknown stdlib version', 'pip install sys==1', false],
  ['unversioned frozen', 'pip install polars', true],
  ['matching frozen', 'pip install polars==1.33.1', true],
  ['mismatched frozen', 'pip install polars==2.1.0', false],
  ['repeated frozen conflict', 'pip install polars polars==2.1.0', false],
] as const
let failed = 0
for (const [name, command, pass] of cases) {
  let fetches = 0
  const bash = await Bash.create({
    cwd: '/workspace',
    fetch: async () => {
      fetches++
      throw new Error('requirement regression must not fetch')
    },
    fs: MemoryFileSystem.create(),
    limits: { maxMemoryBytes: 512 << 20, timeoutMs: 300000 },
    psh,
    python: { cpuMs: 300000, data, module, stepsPerMs: 42000 },
  })
  const result = await bash.exec(command)
  try {
    Assert.equal(result.exitCode === 0, pass, JSON.stringify(result))
    Assert.equal(result.truncated, false)
    Assert.equal(fetches, 0)
    if (!pass) Assert.match(result.stderr, /cannot satisfy|cannot verify|already chosen/)
    console.log(JSON.stringify({ name, passed: true }))
  } catch (error) {
    failed++
    console.error(name, error)
  }
}
console.log(JSON.stringify({ passed: cases.length - failed, total: cases.length }))
if (failed) process.exitCode = 1
