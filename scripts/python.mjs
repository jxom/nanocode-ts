import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { fetchCrates, root } from './wasm.mjs'

export const pin = JSON.parse(readFileSync(join(root, 'python-revision.json'), 'utf8'))

const paths = ['Cargo.toml', 'Cargo.lock', 'crates/core', 'crates/patches']

const maxDataSegments = 100_000
const pageBytes = 65536
const segmentHeader = 1 + 1 + 5 + 1 + 5

// The image holds only the started interpreter: modules load from the data blob when a program imports
// them, so a module the image imported ahead of time would only add its objects to every instance's
// memory (17.4 MB image with the common stdlib modules, 8.0 MB without).
export const warm = 'import sys\n'

function run(command, cwd) {
  const result = spawnSync(command[0], command.slice(1), { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function source() {
  if (process.env.NANOCODE_PYTHON_SOURCE) return process.env.NANOCODE_PYTHON_SOURCE
  const directory = join(root, 'target', 'python-source', pin.revision)
  if (existsSync(join(directory, 'crates', 'core', 'python', 'Cargo.toml'))) return directory
  const sdk = join(root, '..', 'nanocodex')
  const held = spawnSync('git', ['cat-file', '-e', pin.revision + '^{commit}'], { cwd: sdk })
  if (held.status !== 0) run(['git', 'fetch', '--depth', '1', pin.repository, pin.revision], sdk)
  const partial = directory + '.partial'
  rmSync(partial, { recursive: true, force: true })
  mkdirSync(partial, { recursive: true })
  run(['sh', '-c', 'revision=$1; shift; git archive "$revision" "$@" | tar -x -C "$0"', partial, pin.revision, ...paths], sdk)
  renameSync(partial, directory)
  return directory
}

function link(target) {
  const path = join(root, 'target', 'python-sdk')
  const current = (() => {
    try {
      return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined
    } catch (error) {
      if (error.code === 'ENOENT') return undefined
      throw error
    }
  })()
  if (current === target) return
  rmSync(path, { recursive: true, force: true })
  mkdirSync(join(root, 'target'), { recursive: true })
  symlinkSync(target, path)
}

export function build() {
  link(source())
  fetchCrates(join(root, 'python'))
  const result = spawnSync(
    'cargo',
    ['build', '--locked', '--offline', '--release', '--target', 'wasm32-unknown-unknown', '--target-dir', '../target/python'],
    { cwd: join(root, 'python'), stdio: 'inherit' },
  )
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
  return join(root, 'target', 'python', 'wasm32-unknown-unknown', 'release', 'nanocode_python_wasm.wasm')
}

function leb(bytes, at) {
  let value = 0
  let shift = 0
  for (;;) {
    const byte = bytes[at++]
    value += (byte & 0x7f) * 2 ** shift
    shift += 7
    if (byte < 0x80) return [value, at]
  }
}

function uleb(value) {
  const out = []
  do {
    let byte = value % 128
    value = Math.floor(value / 128)
    if (value > 0) byte |= 0x80
    out.push(byte)
  } while (value > 0)
  return out
}

function sleb(value) {
  const out = []
  for (;;) {
    const byte = value & 0x7f
    value >>= 7
    if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) {
      out.push(byte)
      return out
    }
    out.push(byte | 0x80)
  }
}

function expression(bytes, at) {
  for (;;) {
    const op = bytes[at++]
    if (op === 0x0b) return at
    if (op === 0x41 || op === 0x42) while (bytes[at++] >= 0x80);
    else if (op === 0x43) at += 4
    else if (op === 0x44) at += 8
    else if (op === 0x23) at = leb(bytes, at)[1]
    else throw new Error('python.wasm has a constant expression with opcode ' + op)
  }
}

function join8(parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function segments(memory) {
  const runs = []
  let at = 0
  while (at < memory.length) {
    while (at < memory.length && memory[at] === 0) at++
    if (at === memory.length) break
    let end = at
    let zeros = 0
    while (end < memory.length) {
      if (memory[end] !== 0) zeros = 0
      else if (++zeros > segmentHeader) {
        end++
        break
      }
      end++
    }
    runs.push([at, end - zeros])
    at = end
  }
  if (runs.length <= maxDataSegments) return runs
  const gaps = runs.slice(1).map((run, index) => run[0] - runs[index][1]).sort((a, b) => a - b)
  const widest = gaps[runs.length - maxDataSegments - 1]
  const merged = [runs[0]]
  for (const run of runs.slice(1)) {
    const last = merged[merged.length - 1]
    if (run[0] - last[1] <= widest) last[1] = run[1]
    else merged.push(run)
  }
  return merged
}

function warmed(module, data) {
  let exports
  const view = (ptr, len) => new Uint8Array(exports.memory.buffer, ptr >>> 0, len >>> 0)
  const reply = (data) => {
    view(exports.python_reply(data.length), data.length).set(data)
    return BigInt(data.length)
  }
  const root = new Uint8Array(24)
  new DataView(root.buffer).setUint32(0, 1, true)
  new DataView(root.buffer).setUint32(4, 0o755, true)
  const imports = {
    python: {
      host_fs: (op, path, len) => (op === 0 && len === 1 && view(path, 1)[0] === 0x2f ? reply(root) : op === 0 || op === 1 || op === 3 ? -2n : -30n),
      host_data(offset, ptr, len) {
        if (!data || offset + len > data.length) return 1
        view(ptr, len).set(data.subarray(offset, offset + len))
        return 0
      },
      host_now: () => performance.now(),
      host_panic(ptr, len) {
        throw new Error('python.wasm panicked: ' + new TextDecoder().decode(view(ptr, len)))
      },
      host_random(ptr, len) {
        for (let at = 0; at < len; at += 65536) crypto.getRandomValues(view(ptr + at, Math.min(65536, len - at)))
      },
      host_spawn: () => -95n,
      host_stopped: () => 0,
      host_time: () => Date.now(),
    },
  }
  exports = new WebAssembly.Instance(module, imports).exports
  const text = new TextEncoder()
  const field = (bytes) => [...new Uint8Array(new Uint32Array([bytes.length]).buffer), ...bytes]
  const u64 = (value) => [...new Uint8Array(new BigUint64Array([value]).buffer)]
  const request = Uint8Array.from([
    ...new Uint8Array(new Uint32Array([2]).buffer),
    ...field(text.encode('-c')),
    ...field(text.encode(warm)),
    ...field(text.encode('/')),
    ...new Uint8Array(new Uint32Array([0]).buffer),
    ...field([]),
    ...u64(1n << 20n),
    ...u64(0n),
    ...u64(2n ** 64n - 1n),
    ...u64(2n ** 64n - 1n),
    ...u64(1000n),
    ...u64(2n ** 64n - 1n),
    ...new Uint8Array(new Uint32Array([0]).buffer),
  ])
  view(exports.python_input(request.length), request.length).set(request)
  const len = exports.python_run()
  const out = view(exports.python_output(), len).slice()
  const fields = new DataView(out.buffer)
  if (fields.getUint32(0, true) !== 0 || fields.getUint32(4, true) !== 0) {
    const stdout = fields.getUint32(8, true)
    throw new Error('the warm-up run ended with ' + fields.getUint32(0, true) + '/' + fields.getUint32(4, true) + ': ' + new TextDecoder().decode(out.subarray(12 + stdout)))
  }
  return new Uint8Array(exports.memory.buffer)
}

// python.wasm keeps its read-only data (each frozen module's compressed code and each compressed site
// data file) in the dataSection custom section, outside linear memory; the interpreter reads one entry
// through the python.host_data import when it imports the module or opens the file. The bake lifts that
// section out of the module.
//
// With `image: true` the warmed memory and the data leave the module as python.data, which the host loads once
// per isolate (src/bash/internal/commands/rustpython.ts): it writes the memory into each new instance
// before its first call and serves data entries from the blob, so that a host with a cap on code size (a
// Cloudflare Worker) can serve both as a static asset. python.data is imageMagic, then the SHA-256 of the
// memory and the data, the memory's base address, its length, the length of its gzip and the data's length
// (u32 little endian), then the gzip of the memory and then the data, kept as it is: its entries are
// compressed one by one, so the host holds it without decompressing it. The module's imageSection custom
// section holds the same 48 bytes after the magic. Without it the data stays in the module's section
// and the host reads it from there.
export const imageMagic = 'NCPYDAT2'
export const imageSection = 'nanocode.python.image'
export const dataSection = 'nanocode.python.data'

function customSection(bytes, wanted) {
  let at = 8
  while (at < bytes.length) {
    const id = bytes[at]
    const [size, start] = leb(bytes, at + 1)
    at = start + size
    if (id !== 0) continue
    const [length, name] = leb(bytes, start)
    if (new TextDecoder().decode(bytes.subarray(name, name + length)) === wanted) return bytes.subarray(name + length, at)
  }
  return undefined
}

export function bake(bytes, options = {}) {
  const data = customSection(bytes, dataSection)
  const memory = warmed(new WebAssembly.Module(bytes), data)
  const runs = segments(memory)
  const split = options.image === true
  let image
  let section
  if (split) {
    const base = runs[0][0]
    const body = memory.subarray(base, runs[runs.length - 1][1])
    const packed = gzipSync(body, { level: 9 })
    const blob = data ?? new Uint8Array(0)
    const header = new Uint8Array(56)
    header.set(new TextEncoder().encode(imageMagic), 0)
    header.set(createHash('sha256').update(body).update(blob).digest(), 8)
    const fields = new DataView(header.buffer)
    fields.setUint32(40, base, true)
    fields.setUint32(44, body.length, true)
    fields.setUint32(48, packed.length, true)
    fields.setUint32(52, blob.length, true)
    image = join8([header, packed, blob])
    const name = new TextEncoder().encode(imageSection)
    const payload = join8([Uint8Array.from(uleb(name.length)), name, header.subarray(8)])
    section = join8([Uint8Array.from([0, ...uleb(payload.length)]), payload])
  }
  const parts = [bytes.subarray(0, 8)]
  let at = 8
  while (at < bytes.length) {
    const begin = at
    const id = bytes[at]
    const [size, start] = leb(bytes, at + 1)
    const body = bytes.subarray(start, start + size)
    at = start + size
    if (id === 8) throw new Error('python.wasm has a start function')
    if (split && id === 0 && body.length > 0) {
      const [length, name] = leb(body, 0)
      if (new TextDecoder().decode(body.subarray(name, name + length)) === dataSection) continue
    }
    if (id === 5) {
      const [count, limits] = leb(body, 0)
      if (count !== 1 || body[limits] > 1) throw new Error('python.wasm has an unexpected memory section')
      const [, rest] = leb(body, limits + 1)
      const replaced = [1, body[limits], ...uleb(memory.length / pageBytes), ...body.subarray(rest)]
      parts.push(Uint8Array.from([5, ...uleb(replaced.length), ...replaced]))
      continue
    }
    if (id === 6) {
      let [count, cursor] = leb(body, 0)
      let mutable = 0
      for (; count > 0; count--) {
        mutable += body[cursor + 1]
        cursor = expression(body, cursor + 2)
      }
      if (mutable !== 1) throw new Error('python.wasm has ' + mutable + ' mutable globals, and the snapshot restores only the stack pointer')
    }
    if (id === 11) {
      if (split) continue
      const data = join8([Uint8Array.from(uleb(runs.length)), ...runs.flatMap(([from, to]) => [Uint8Array.from([0, 0x41, ...sleb(from), 0x0b, ...uleb(to - from)]), memory.subarray(from, to)])])
      parts.push(Uint8Array.from([11, ...uleb(data.length)]), data)
      continue
    }
    if (id === 12) {
      if (split) continue
      const count = uleb(runs.length)
      parts.push(Uint8Array.from([12, ...uleb(count.length), ...count]))
      continue
    }
    parts.push(bytes.subarray(begin, at))
  }
  if (split) return { module: join8([...parts, section]), image }
  return join8(parts)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) console.log(build())
