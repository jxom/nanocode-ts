import * as ChildProcess from 'node:child_process'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import { Bash, MemoryFileSystem } from '../../src/bash/index.ts'
import { cases } from './probes.ts'

const digest = (bytes: Uint8Array | string) =>
  Crypto.createHash('sha256').update(bytes).digest('hex')

type Entry = {
  bytes: number
  headers: [string, string][]
  sha256: string
  status: number
  url: string
}

function entry(value: unknown): Entry {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('url' in value) ||
    typeof value.url !== 'string' ||
    !('bytes' in value) ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) < 0 ||
    !('sha256' in value) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !('status' in value) ||
    !Number.isInteger(value.status) ||
    !('headers' in value) ||
    !Array.isArray(value.headers) ||
    !value.headers.every(
      (header: unknown) =>
        Array.isArray(header) &&
        header.length === 2 &&
        header.every((part: unknown) => typeof part === 'string'),
    )
  )
    throw new Error('Invalid replay response metadata')

  return value as Entry
}

export function replay(directory: string) {
  const errors: string[] = []
  const requests: { sha256: string; url: string }[] = []
  const fetch: typeof globalThis.fetch = async (input, options) => {
    try {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      )
      const method = options?.method ?? (input instanceof Request ? input.method : 'GET')
      if (
        method !== 'GET' ||
        options?.body != null ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        url.search ||
        url.hash ||
        !(
          (url.hostname === 'pypi.org' &&
            url.pathname.startsWith('/pypi/') &&
            url.pathname.endsWith('/json')) ||
          (url.hostname === 'files.pythonhosted.org' && url.pathname.startsWith('/packages/'))
        )
      )
        throw new Error('Request outside offline PyPI replay scope: ' + url.origin + url.pathname)

      const key = digest(url.href)
      const metadata = entry(
        JSON.parse(Fs.readFileSync(Path.join(directory, key + '.json'), 'utf8')),
      )
      const bytes = Fs.readFileSync(Path.join(directory, key + '.body'))
      if (
        metadata.url !== url.href ||
        metadata.bytes !== bytes.length ||
        metadata.sha256 !== digest(bytes)
      )
        throw new Error('Changed replay response: ' + url.href)

      requests.push({ sha256: metadata.sha256, url: metadata.url })
      return new Response(bytes, { headers: metadata.headers, status: metadata.status })
    } catch (error) {
      errors.push(String(error))
      throw error
    }
  }

  return { errors, fetch, requests }
}

async function run() {
  const [fixtures, output, ...extra] = process.argv.slice(2)
  if (!fixtures || !output || extra.length || fixtures === '--help') {
    console.log(
      'Usage: node bench/python/replay.ts FIXTURE_DIRECTORY NEW_OUTPUT_JSONL\nRequires local SHA256(URL).json metadata (url, status, headers, sha256, bytes) and .body files. No capture or network fallback.\nNANOCODE_DIST selects psh.wasm and the default Python pair (default dist). NANOCODE_PYTHON_DIST optionally selects another matched python.wasm/python.data pair for every probe.\nRun each trial in a new process, for example: unshare -Urn node bench/python/replay.ts /path/to/http output/trial-1.jsonl',
    )
    if (fixtures !== '--help') process.exitCode = 1
    return
  }

  if (!Path.resolve(output).startsWith(Path.resolve('output') + Path.sep))
    throw new Error('Replay logs must be under output/')

  const dist = Path.resolve(process.env.NANOCODE_DIST ?? 'dist')
  const pythonDist = Path.resolve(process.env.NANOCODE_PYTHON_DIST ?? dist)
  const assets = {
    data: Fs.readFileSync(Path.join(pythonDist, 'python.data')),
    module: Fs.readFileSync(Path.join(pythonDist, 'python.wasm')),
    psh: Fs.readFileSync(Path.join(dist, 'psh.wasm')),
  }
  const module = new WebAssembly.Module(assets.module)
  const psh = new WebAssembly.Module(assets.psh)
  const cached = replay(fixtures)
  const fd = Fs.openSync(output, 'wx')
  const write = (value: unknown) => Fs.writeSync(fd, JSON.stringify(value) + '\n')
  const startedAt = new Date().toISOString()
  const revision = ChildProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim()
  let passed = 0

  try {
    write({
      type: 'configuration',
      assets: Object.fromEntries(
        Object.entries(assets).map(([name, bytes]) => [name, digest(bytes)]),
      ),
      dist,
      fixtures: Path.resolve(fixtures),
      matrixSha256: digest(JSON.stringify(cases)),
      node: process.version,
      policies: {
        maxMemoryBytes: 512 << 20,
        pythonCpuMs: 300000,
        stepsPerMs: 42000,
        timeoutMs: 300000,
      },
      pythonDist,
      revision,
      sources: Object.fromEntries(
        ['../../src/bash/internal/commands/pip.ts', './probes.ts', './replay.ts'].map((path) => [
          path,
          digest(Fs.readFileSync(new URL(path, import.meta.url))),
        ]),
      ),
      startedAt,
      total: cases.length,
    })
    for (const [name, code] of cases) {
      const before = cached.requests.length
      const fs = MemoryFileSystem.create()
      const bash = await Bash.create({
        cwd: '/workspace',
        fetch: cached.fetch,
        fs,
        limits: { maxMemoryBytes: 512 << 20, timeoutMs: 300000 },
        psh,
        python: { cpuMs: 300000, data: assets.data, module, stepsPerMs: 42000 },
      })
      const start = performance.now()
      const result = await (async () => {
        try {
          const installed = await bash.exec('pip install -q ' + name)
          await bash.writeFile('/workspace/probe.py', code)
          const ran = installed.exitCode === 0 ? await bash.exec('python3 probe.py') : undefined
          return { installed, pass: ran?.exitCode === 0, ran }
        } catch (error) {
          return { error: String(error), pass: false }
        }
      })()
      if (cached.errors.length) throw new Error(cached.errors.join('\n'))

      const metadata = []
      const site = '/usr/local/lib/python3.14/site-packages'
      for (const name of await fs.list(site).catch(() => [])) {
        if (!name.endsWith('.dist-info')) continue
        const bytes = await fs.read(site + '/' + name + '/METADATA')
        metadata.push({
          directory: name,
          headers: new TextDecoder().decode(bytes).split(/\r?\n\r?\n/)[0],
          sha256: digest(bytes),
        })
      }
      const elapsedMs = Math.round(performance.now() - start)
      write({
        type: 'case',
        ...result,
        elapsedMs,
        metadata,
        name,
        requests: cached.requests.slice(before),
      })
      console.log(JSON.stringify({ name, pass: result.pass, elapsedMs }))
      passed += Number(result.pass)
    }
    const summary = { type: 'summary', passed, total: cases.length }
    write(summary)
    console.log(JSON.stringify(summary))
  } finally {
    Fs.closeSync(fd)
  }
}

if (import.meta.main) await run()
