//
import * as Bash from './Bash.ts'
import type { SyncFileSystem } from './FileSystem.ts'
import * as MemoryFileSystem from './MemoryFileSystem.ts'
import type { Data, Sci, SciRequest, SciResult } from './Python.ts'

type Fetcher = { fetch(input: string, init?: RequestInit): Promise<Response> }

export function pack(
  header: object,
  files: readonly (readonly [string, Uint8Array])[],
): Uint8Array {
  const json = new TextEncoder().encode(
    JSON.stringify({ ...header, files: files.map(([path, bytes]) => [path, bytes.length]) }),
  )
  const out = new Uint8Array(
    4 + json.length + files.reduce((sum, [, bytes]) => sum + bytes.length, 0),
  )
  new DataView(out.buffer).setUint32(0, json.length, true)
  out.set(json, 4)
  let at = 4 + json.length
  for (const [, bytes] of files) {
    out.set(bytes, at)
    at += bytes.length
  }
  return out
}

export function unpack<Header>(raw: Uint8Array): {
  header: Header
  files: [string, Uint8Array][]
} {
  if (raw.length < 4) throw new Error('python-sci: the body is too short')
  const length = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + length))) as Header & {
    files: [string, number][]
  }
  const files: [string, Uint8Array][] = []
  let at = 4 + length
  for (const [path, size] of header.files) {
    files.push([path, raw.subarray(at, at + size)])
    at += size
  }
  return { header, files }
}

function base64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

function unbase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
}

export function remote(target: Fetcher, options: { url?: string } = {}): Sci {
  return {
    async run(request, signal) {
      const { files, stdin, ...rest } = request
      const response = await target.fetch(options.url ?? 'https://python-sci/run', {
        method: 'POST',
        body: pack({ ...rest, stdin: base64(stdin) }, files) as BodyInit,
        headers: { 'content-type': 'application/octet-stream' },
        signal,
      })
      if (!response.ok)
        throw new Error(
          'python-sci answered ' + response.status + ': ' + (await response.text()).slice(0, 200),
        )
      const { header, files: written } = unpack<Omit<SciResult, 'files'>>(
        new Uint8Array(await response.arrayBuffer()),
      )
      return { ...header, files: written }
    },
  }
}

function quote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : "'" + word.replaceAll("'", "'\\''") + "'"
}

function walk(fs: SyncFileSystem, dir: string, into: Map<string, Uint8Array>) {
  for (const name of fs.list(dir)) {
    const path = (dir === '/' ? '' : dir) + '/' + name
    const stat = fs.stat(path)
    if (stat?.kind === 'directory') walk(fs, path, into)
    else if (stat) into.set(path, fs.read(path))
  }
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export async function run(
  request: SciRequest,
  options: { module: WebAssembly.Module | (() => Promise<WebAssembly.Module>); data: Data },
  signal?: AbortSignal,
): Promise<SciResult> {
  const memory = MemoryFileSystem.create()
  const fs = memory.sync!
  const given = new Map(request.files)
  for (const [path, bytes] of request.files) {
    const parts = path.split('/').filter(Boolean)
    for (let i = 1; i < parts.length; i++) {
      const dir = '/' + parts.slice(0, i).join('/')
      if (!fs.stat(dir)) fs.mkdir(dir)
    }
    fs.write(path, bytes)
  }
  const shell = await Bash.create({
    fs: memory,
    cwd: request.cwd,
    env: request.env,
    limits: { timeoutMs: request.timeMs, maxMemoryBytes: request.memory },
    python: { module: options.module, data: options.data },
  })
  const result = await shell.exec(['python3', ...request.argv].map(quote).join(' '), {
    cwd: request.cwd,
    env: request.env,
    stdin: new TextDecoder().decode(request.stdin),
    timeoutMs: request.timeMs,
    ...(signal ? { signal } : {}),
  })
  const after = new Map<string, Uint8Array>()
  walk(fs, '/', after)
  const files: [string, Uint8Array][] = []
  for (const [path, bytes] of after) {
    const before = given.get(path)
    if (!before || !same(before, bytes)) files.push([path, bytes])
  }
  return {
    kind: 'exited',
    status: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    files,
    deleted: [...given.keys()].filter((path) => !after.has(path)),
  }
}

export async function serve(
  request: Request,
  options: { module: WebAssembly.Module | (() => Promise<WebAssembly.Module>); data: Data },
): Promise<Response> {
  if (request.method !== 'POST') return new Response('POST a python-sci request', { status: 405 })
  const { header, files } = unpack<Omit<SciRequest, 'files' | 'stdin'> & { stdin?: string }>(
    new Uint8Array(await request.arrayBuffer()),
  )
  const ran = await run(
    { ...header, stdin: unbase64(header.stdin ?? ''), files },
    options,
    request.signal,
  )
  const { files: written, ...rest } = ran
  return new Response(pack(rest, written) as BodyInit, {
    headers: { 'content-type': 'application/octet-stream' },
  })
}

export function assets(
  binding: Fetcher,
  names: readonly string[] = ['python.data.0', 'python.data.1'],
): () => Promise<Uint8Array> {
  return async () => {
    const parts = await Promise.all(
      names.map(async (name) => {
        const response = await binding.fetch('https://assets.invalid/' + name)
        if (!response.ok) throw new Error('ASSETS answered ' + response.status + ' for ' + name)
        return new Uint8Array(await response.arrayBuffer())
      }),
    )
    const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
    let at = 0
    for (const part of parts) {
      joined.set(part, at)
      at += part.length
    }
    return joined
  }
}

export function local(paths: { module?: string | URL; data?: string | URL } = {}): {
  module: () => Promise<WebAssembly.Module>
  data: () => Promise<Uint8Array>
} {
  const node = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process
  const fs = node?.getBuiltinModule?.('node:fs') as
    { promises: { readFile(path: string | URL): Promise<Uint8Array> } } | undefined
  const meta = import.meta as { resolve?: (specifier: string) => string; url?: string }
  const packaged = (name: string): URL =>
    meta.resolve
      ? new URL(meta.resolve('nanocode-ts-polars/' + name))
      : new URL('../polars/' + name, meta.url ?? 'file:///')
  const read = (path: string | URL) => {
    if (!fs)
      throw new Error('PythonSci.local needs node:fs; pass Python sci module and data instead')
    return fs.promises.readFile(path)
  }
  let module: Promise<WebAssembly.Module> | undefined
  return {
    module: () =>
      (module ??= read(paths.module ?? packaged('python.wasm'))
        .then((bytes) =>
          (
            WebAssembly as unknown as { compile(bytes: Uint8Array): Promise<WebAssembly.Module> }
          ).compile(bytes),
        )
        .catch((error: unknown) => {
          module = undefined
          throw error
        })),
    data: () => read(paths.data ?? packaged('python.data')),
  }
}
