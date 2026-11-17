// python-sci: python3 with polars (scripts/polars.mjs) on a Worker of its own, which a main Worker reaches
// over a service binding when a script imports polars: polars makes python.wasm 61 MiB, too big for the
// main Worker's bundle. It holds no workspace: each request carries the files the run reads, and the
// response carries the files it wrote. Both bodies are a little-endian u32 header length, a JSON header,
// then the files' bytes back to back in the header's order.
// Request header: { argv, cwd, env?, memory?, files: [[path, length], ...] }.
// Response header: { kind, status, stdout, stderr, cold, setupMs, runMs, files: [[path, length], ...] }.
import { provide, runAsync } from '../../dist/bash/internal/commands/rustpython.js'
import { create } from '../../dist/bash/MemoryFileSystem.js'
import python from '../../dist/polars/python.wasm'

let ready

// python.data comes in two static assets because one can't pass 25 MiB.
async function image(env) {
  const parts = await Promise.all(
    ['python.data.0', 'python.data.1'].map(async (name) => {
      const response = await env.ASSETS.fetch('https://assets/' + name)
      if (!response.ok) throw new Error('ASSETS answered ' + response.status + ' for ' + name)
      return new Uint8Array(await response.arrayBuffer())
    }),
  )
  const joined = new Uint8Array(parts[0].length + parts[1].length)
  joined.set(parts[0])
  joined.set(parts[1], parts[0].length)
  return joined
}

function unpack(raw) {
  const length = new DataView(raw.buffer, raw.byteOffset).getUint32(0, true)
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(4, 4 + length)))
  const files = new Map()
  let at = 4 + length
  for (const [path, size] of header.files) {
    files.set(path, raw.subarray(at, at + size))
    at += size
  }
  return { header, files }
}

function pack(header, files) {
  const json = new TextEncoder().encode(
    JSON.stringify({ ...header, files: [...files].map(([path, bytes]) => [path, bytes.length]) }),
  )
  const out = new Uint8Array(
    4 + json.length + [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0),
  )
  new DataView(out.buffer).setUint32(0, json.length, true)
  out.set(json, 4)
  let at = 4 + json.length
  for (const bytes of files.values()) {
    out.set(bytes, at)
    at += bytes.length
  }
  return out
}

export default {
  async fetch(request, env) {
    const started = performance.now()
    const cold = !ready
    ready ??= (async () => provide(python, env.DATA ?? (await image(env))))()
    await ready
    const setupMs = performance.now() - started
    const { header, files: given } = unpack(new Uint8Array(await request.arrayBuffer()))
    const fs = create().sync
    for (const [path, bytes] of given) {
      const parts = path.split('/').filter(Boolean)
      for (let i = 1; i < parts.length; i++) {
        const dir = '/' + parts.slice(0, i).join('/')
        if (!fs.stat(dir)) fs.mkdir(dir)
      }
      fs.write(path, bytes)
    }
    if (!fs.stat(header.cwd)) fs.mkdir(header.cwd)
    const ran = await runAsync(python, {
      files: fs,
      stopped: () => false,
      // Commands a script starts would run on the main Worker; this prototype refuses them.
      spawn: () => 'ENOTSUP',
      request: {
        argv: header.argv,
        cwd: header.cwd,
        depth: 1000,
        env: header.env ?? {},
        file: 64 << 20,
        memory: header.memory ?? 1 << 30,
        output: 1 << 20,
        stdin: new Uint8Array(0),
        steps: Number.MAX_SAFE_INTEGER,
        timeMs: 120000,
      },
    })
    const written = new Map()
    const walk = (dir) => {
      for (const name of fs.list(dir)) {
        const path = (dir === '/' ? '' : dir) + '/' + name
        const stat = fs.stat(path)
        if (stat?.kind === 'directory') walk(path)
        else if (!given.has(path)) written.set(path, fs.read(path))
      }
    }
    walk(header.cwd)
    const text = new TextDecoder()
    const out = {
      kind: ran.kind,
      status: ran.status,
      stdout: ran.stdout ? text.decode(ran.stdout) : '',
      stderr: ran.stderr ? text.decode(ran.stderr) : '',
      cold,
      setupMs: Math.round(setupMs),
      runMs: Math.round(performance.now() - started - setupMs),
    }
    return new Response(pack(out, written), {
      headers: { 'content-type': 'application/octet-stream' },
    })
  },
}
