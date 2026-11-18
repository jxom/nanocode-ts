import { FsError, type FileStat, type FileSystem, type SyncFileSystem } from '../../FileSystem.ts'
import { decode, encode, parentOf } from '../Fs.ts'
import { CommandError, budget, type CommandContext, type Limits } from '../Shell.ts'

type Exports = {
  memory: WebAssembly.Memory
  python_input(len: number): number
  python_output(): number
  python_reply(len: number): number
  python_run(): number
  python_held?(): number
}

type Instance = {
  call: (() => Promise<unknown>) | undefined
  exports: Exports
  files: SyncFileSystem | undefined
  initial: number
  held: number
  panic: string | undefined
  retry: (() => Promise<boolean>) | undefined
  spare: boolean
  spawn: Spawn | Suspended | undefined
  stopped: () => boolean
  tape: Tape | undefined
}

type Jspi = {
  Suspending: new (body: (...args: never[]) => unknown) => unknown
  promising: (body: unknown) => (...args: unknown[]) => Promise<unknown>
}

const jspi = WebAssembly as unknown as Partial<Jspi>

export const suspends =
  typeof jspi.Suspending === 'function' && typeof jspi.promising === 'function'

export type Changes = { deleted: string[]; dirs: string[]; files: Map<string, Uint8Array> }

export type Child = {
  argv: string[]
  cwd: string
  env: Record<string, string>
  merged: boolean
  stdin: Uint8Array
}

export type Exited = { status: number; stderr: Uint8Array; stdout: Uint8Array }

export type Tape = {
  clock: number[]
  clockAt: number
  random: Uint8Array[]
  randomAt: number
  time: number[]
  timeAt: number
}

export type Spawn = (child: Child) => Exited | FsError['code']

export type Suspended = (
  child: Child,
) => Exited | FsError['code'] | Promise<Exited | FsError['code']>

export type Missing = { module: string; package: boolean; text: string }

export type Ran =
  | { kind: 'exited'; status: number; stderr: Uint8Array; stdout: Uint8Array }
  | { kind: 'needs'; missing: readonly Missing[] }
  | {
      kind: 'refused'
      limit: number
      stderr: Uint8Array
      stdout: Uint8Array
      steps: bigint
      held: bigint
      asked: bigint
    }
  | { kind: 'cancelled'; stderr: Uint8Array; stdout: Uint8Array }

export type Budget = {
  cpuMs: number
  stepsPerMs: number | undefined
}

export type Request = {
  argv: readonly string[]
  cwd: string
  depth: number
  env: Record<string, string>
  file: number
  memory: number
  output: number
  stdin: Uint8Array
  steps: number
  timeMs: number
}

const errno: Record<string, number> = {
  EACCES: 13,
  EAGAIN: 11,
  EEXIST: 17,
  EFBIG: 27,
  EINVAL: 22,
  EINTR: 4,
  EIO: 5,
  EISDIR: 21,
  ENOENT: 2,
  ENOTDIR: 20,
  ENOTEMPTY: 39,
  ENOTSUP: 95,
  EROFS: 30,
}

const instances = new WeakMap<WebAssembly.Module, Instance>()

// python.wasm's warmed memory ships beside it as python.data rather than as data segments, so that hosts
// with a cap on code size (Cloudflare Workers) can fetch it as a static asset. python.data also carries
// the read-only data blob: each frozen module's compressed code and each compressed site data file, which
// the interpreter reads entry by entry through the host_data import when it imports a module or opens a
// file, so the blob stays here, compressed, once per isolate and outside every instance's memory. The
// module's custom section names the python.data it needs: its SHA-256 and layout (scripts/python.mjs).
// A module baked without an image keeps the blob in its own data custom section instead.
export type Image = { base: number; bytes: Uint8Array; data: Uint8Array; length: number }

const imageSection = 'nanocode.python.image'

const dataSection = 'nanocode.python.data'

const imageMagic = 'NCPYDAT2'

const images = new WeakMap<WebAssembly.Module, Image>()

const sectionData = new WeakMap<WebAssembly.Module, Uint8Array>()

function descriptor(module: WebAssembly.Module): Uint8Array | undefined {
  const [section] = WebAssembly.Module.customSections(module, imageSection)
  return section && new Uint8Array(section)
}

function blob(module: WebAssembly.Module): Uint8Array {
  const image = images.get(module)
  if (image) return image.data
  let data = sectionData.get(module)
  if (!data) {
    const [section] = WebAssembly.Module.customSections(module, dataSection)
    data = section ? new Uint8Array(section) : new Uint8Array(0)
    sectionData.set(module, data)
  }
  return data
}

export function needsImage(module: WebAssembly.Module): boolean {
  return descriptor(module) !== undefined && !images.has(module)
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(bytes as unknown as ArrayBuffer).body!.pipeThrough(
    new DecompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>,
  )
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

export async function provide(
  module: WebAssembly.Module,
  data: Uint8Array | ArrayBuffer,
): Promise<void> {
  const wanted = descriptor(module)
  if (!wanted || images.has(module)) return
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const header = bytes.subarray(0, 8 + wanted.length)
  if (header.length !== 56 || text.decode(header.subarray(0, 8)) !== imageMagic)
    throw new Error('it is not a python.data image of this format')
  if (!header.subarray(8).every((byte, index) => byte === wanted[index]))
    throw new Error('it belongs to another build of python.wasm')
  const view = new DataView(header.buffer, header.byteOffset, header.length)
  const length = view.getUint32(44, true)
  const packed = view.getUint32(48, true)
  const blobLength = view.getUint32(52, true)
  if (bytes.length !== header.length + packed + blobLength) throw new Error('it is truncated')
  const memory = await gunzip(bytes.subarray(header.length, header.length + packed))
  if (memory.length !== length) throw new Error('its memory image is corrupt')
  // The blob is copied out so that the bytes it came in, with the image's gzip, can be collected.
  const start = header.length + packed
  const image = {
    base: view.getUint32(40, true),
    bytes: bytes.slice(header.length, start),
    data: bytes.slice(start, start + blobLength),
    length,
  }
  const instance = await instantiate(module, { image, memory })
  images.set(module, image)
  instances.set(module, instance)
}

const randomBytes = 65536

const text = new TextDecoder()

const limits = ['output', 'sleep', 'steps', 'time', 'memory'] as const

type InstantiateOptions = {
  image?: Image
  memory?: Uint8Array
  running?: Set<Instance>
}

async function instantiate(
  module: WebAssembly.Module,
  options: InstantiateOptions = {},
): Promise<Instance> {
  const state: Instance = {
    call: undefined,
    exports: undefined as unknown as Exports,
    files: undefined,
    initial: 0,
    held: 0,
    panic: undefined,
    retry: undefined,
    spare: false,
    spawn: undefined,
    tape: undefined,
    stopped: () => false,
  }
  const view = (ptr: number, len: number) =>
    new Uint8Array(state.exports.memory.buffer, ptr >>> 0, len >>> 0)
  const reply = (data: Uint8Array) => {
    view(state.exports.python_reply(data.length), data.length).set(data)
    return BigInt(data.length)
  }
  const stat = new Uint8Array(24)
  const stats = new DataView(stat.buffer)
  const found = (files: SyncFileSystem, path: string): FileStat => {
    const entry = files.stat(path)
    if (!entry) throw new FsError('ENOENT', path)
    return entry
  }
  const ops: ((files: SyncFileSystem, path: string, data: Uint8Array, arg: bigint) => bigint)[] = [
    (files, path) => {
      const entry = found(files, path)
      stats.setUint32(0, entry.kind === 'directory' ? 1 : 0, true)
      stats.setUint32(4, entry.mode, true)
      stats.setBigUint64(8, BigInt(entry.size), true)
      stats.setBigInt64(16, BigInt(Math.trunc(entry.mtime)) * 1_000_000n, true)
      return reply(stat)
    },
    (files, path) => reply(files.read(path)),
    (files, path, data, how) => {
      if (how === 2n && files.stat(path)) throw new FsError('EEXIST', path)
      files.write(path, data.slice(), how === 1n)
      return 0n
    },
    (files, path) =>
      reply(
        encode(
          files
            .list(path)
            .map((name) => name + '\0')
            .join(''),
        ),
      ),
    (files, path) => {
      if (files.stat(path)) throw new FsError('EEXIST', path)
      files.mkdir(path)
      return 0n
    },
    (files, path, _data, what) => {
      const entry = found(files, path)
      if (what === 0n && entry.kind === 'directory') throw new FsError('EISDIR', path)
      if (what === 1n && entry.kind !== 'directory') throw new FsError('ENOTDIR', path)
      if (what === 1n && files.list(path).length) throw new FsError('ENOTEMPTY', path)
      files.remove(path)
      return 0n
    },
    (files, path, data) => {
      files.rename(path, decode(data))
      return 0n
    },
    (files, path, data, len) => {
      const all = files.read(path)
      const offset = new DataView(data.buffer, data.byteOffset, 8).getBigUint64(0, true)
      const start = Math.min(all.length, Number(offset))
      return reply(all.subarray(start, Math.min(all.length, start + Number(len))))
    },
  ]
  const imports = {
    python: {
      host_fs(
        op: number,
        path: number,
        pathLen: number,
        data: number,
        dataLen: number,
        arg: bigint,
      ) {
        const handler = ops[op]
        if (!state.files || !handler) return -BigInt(errno['ENOTSUP'] ?? 0)
        const attempt = (): bigint | Promise<bigint> => {
          try {
            return handler(state.files!, decode(view(path, pathLen)), view(data, dataLen), arg)
          } catch (error) {
            const code = error instanceof FsError ? errno[error.code] : undefined
            if (code === undefined) throw error
            const retry = state.retry
            if (!retry) return -BigInt(code)
            return retry().then((again) => (again ? attempt() : -BigInt(code)))
          }
        }
        return attempt()
      },
      host_now() {
        const tape = state.tape
        if (!tape) return performance.now()
        const taped = tape.clock[tape.clockAt]
        if (taped !== undefined) {
          tape.clockAt++
          return taped
        }
        const now = performance.now()
        tape.clock.length = tape.clockAt++
        tape.clock.push(now)
        return now
      },
      host_panic(ptr: number, len: number) {
        state.panic = decode(view(ptr, len))
      },
      host_random(ptr: number, len: number) {
        const tape = state.tape
        const taped = tape?.random[tape.randomAt]
        if (tape && taped?.length === len) {
          tape.randomAt++
          view(ptr, len).set(taped)
          return
        }
        for (let at = 0; at < len; at += randomBytes)
          crypto.getRandomValues(view(ptr + at, Math.min(randomBytes, len - at)))
        if (!tape) return
        tape.random.length = tape.randomAt++
        tape.random.push(view(ptr, len).slice())
      },
      host_spawn(ptr: number, len: number) {
        const spawn = state.spawn
        if (!spawn) return -BigInt(errno['ENOTSUP'] ?? 0)
        const bytes = view(ptr, len).slice()
        const data = new DataView(bytes.buffer)
        let at = 0
        const u32 = () => {
          const value = data.getUint32(at, true)
          at += 4
          return value
        }
        const field = () => {
          const size = u32()
          const value = bytes.subarray(at, at + size)
          at += size
          return value
        }
        const argv = Array.from({ length: u32() }, () => decode(field()))
        const env: Record<string, string> = {}
        for (let count = u32(); count > 0; count--) env[decode(field())] = decode(field())
        const cwd = decode(field())
        const stdin = field()
        const merged = u32() !== 0
        const answer = (exited: Exited | FsError['code']) => {
          if (typeof exited === 'string') return -BigInt(errno[exited] ?? errno['EIO'] ?? 0)
          const out = new Uint8Array(12 + exited.stdout.length + exited.stderr.length)
          const fields = new DataView(out.buffer)
          fields.setInt32(0, exited.status, true)
          fields.setUint32(4, exited.stdout.length, true)
          out.set(exited.stdout, 8)
          fields.setUint32(8 + exited.stdout.length, exited.stderr.length, true)
          out.set(exited.stderr, 12 + exited.stdout.length)
          return reply(out)
        }
        const exited = spawn({ argv, cwd, env, merged, stdin })
        return exited instanceof Promise ? exited.then(answer) : answer(exited)
      },
      host_data(offset: number, ptr: number, len: number) {
        const data = blob(module)
        offset >>>= 0
        len >>>= 0
        if (offset + len > data.length) return 1
        new Uint8Array(state.exports.memory.buffer, ptr >>> 0, len).set(
          data.subarray(offset, offset + len),
        )
        return 0
      },
      host_stopped: () => (state.stopped() ? 1 : 0),
      host_time() {
        const tape = state.tape
        if (!tape) return Date.now()
        const taped = tape.time[tape.timeAt]
        if (taped !== undefined) {
          tape.timeAt++
          return taped
        }
        const now = Date.now()
        tape.time.length = tape.timeAt++
        tape.time.push(now)
        return now
      },
    },
  }
  const image = options.image ?? images.get(module)
  if (!image && descriptor(module))
    throw new Error('python.wasm runs only with its python.data image')
  if (suspends) {
    const python = imports.python as Record<string, unknown>
    python['host_fs'] = new jspi.Suspending!(imports.python.host_fs)
    python['host_spawn'] = new jspi.Suspending!(imports.python.host_spawn)
  }
  state.exports = new WebAssembly.Instance(module, imports).exports as unknown as Exports
  if (suspends) state.call = jspi.promising!(state.exports.python_run) as () => Promise<unknown>
  state.initial = state.exports.memory.buffer.byteLength
  state.spare = (options.running?.size ?? 0) > 0
  options.running?.add(state)
  try {
    if (image) {
      const bytes = options.memory ?? (await gunzip(image.bytes))
      if (bytes.length !== image.length) throw new Error('its memory image is corrupt')
      new Uint8Array(state.exports.memory.buffer, image.base, bytes.length).set(bytes)
    }
    state.held = state.exports.python_held?.() ?? 0
    return state
  } catch (error) {
    options.running?.delete(state)
    throw error
  }
}

export function layered(
  fs: FileSystem,
  options: { limits: Limits },
): {
  changes(): Changes
  fetch(): Promise<void>
  files: SyncFileSystem
  missed(): boolean
  probe(dirs: readonly string[]): Promise<void>
  reset(): void
  settle(): void
} {
  const stats = new Map<string, FileStat | null>()
  const names = new Map<string, string[]>()
  const bytes = new Map<string, Uint8Array>()
  const trees = new Set<string>()
  const asked = new Set<string>()
  const wanted = {
    list: new Set<string>(),
    read: new Set<string>(),
    stat: new Set<string>(),
    tree: new Set<string>(),
  }
  let held = 0
  let missing = false
  let files = new Map<string, Uint8Array>()
  let dirs = new Set<string>()
  let gone = new Set<string>()
  let touched = new Set<string>()
  let made = new Set<string>()
  const miss = (set: Set<string>, path: string) => {
    set.add(path)
    missing = true
    return new FsError('EIO', path)
  }
  const hidden = (path: string) => {
    if (files.has(path) || dirs.has(path)) return false
    for (let at = path; ; at = parentOf(at)) {
      if (gone.has(at)) return true
      if (at === '/') return false
    }
  }
  const kind = (path: string): 'file' | 'directory' | undefined => {
    if (files.has(path)) return 'file'
    if (dirs.has(path)) return 'directory'
    if (hidden(path)) return undefined
    if (!stats.has(path) && !absent(path)) throw miss(wanted.stat, path)
    return stats.get(path)?.kind
  }
  const listing = async (dirs: readonly string[]) => {
    for (const dir of new Set(dirs)) {
      if (!stats.has(dir)) keepStat(dir, await fs.stat(dir))
      if (names.has(dir) || stats.get(dir)?.kind !== 'directory') continue
      const children = await fs.list(dir)
      if (fits(weight(children))) keepNames(dir, children)
    }
  }
  const absent = (path: string): boolean => {
    if (path === '/') return false
    const up = parentOf(path)
    if (files.has(up)) return true
    if (dirs.has(up)) return false
    if (stats.has(up) && stats.get(up)?.kind !== 'directory') return true
    const listed = names.get(up)
    if (listed) return !listed.includes(path.slice(up === '/' ? 1 : up.length + 1))
    return absent(up)
  }
  const read = (path: string) => {
    const own = files.get(path)
    if (own) return own
    const found = kind(path)
    if (found !== 'file') throw new FsError(found ? 'EISDIR' : 'ENOENT', path)
    const data = bytes.get(path)
    if (!data) throw miss(wanted.read, path)
    return data
  }
  const list = (path: string) => {
    const found = kind(path)
    if (found !== 'directory') throw new FsError(found ? 'ENOTDIR' : 'ENOENT', path)
    const listed = new Set<string>()
    if (!made.has(path) && !hidden(path)) {
      const base = names.get(path)
      if (!base) throw miss(wanted.list, path)
      for (const name of base) if (!hidden(join(path, name))) listed.add(name)
    }
    for (const key of [...files.keys(), ...dirs])
      if (key !== '/' && parentOf(key) === path)
        listed.add(key.slice(path === '/' ? 1 : path.length + 1))
    return [...listed].sort()
  }
  const parent = (path: string) => {
    if (kind(parentOf(path)) !== 'directory') throw new FsError('ENOENT', path)
  }
  const remove = (path: string) => {
    files.delete(path)
    dirs.delete(path)
    touched.delete(path)
    made.delete(path)
    gone.add(path)
  }
  const write = (path: string, data: Uint8Array, append?: boolean) => {
    if (kind(path) === 'directory') throw new FsError('EISDIR', path)
    parent(path)
    const before = append && kind(path) === 'file' ? read(path) : undefined
    const joined = before ? new Uint8Array(before.length + data.length) : data
    if (before) {
      joined.set(before)
      joined.set(data, before.length)
    }
    files.set(path, joined)
    touched.add(path)
  }
  const copy = (from: string, to: string) => {
    if (kind(from) === 'file') return write(to, read(from))
    dirs.add(to)
    made.add(to)
    for (const name of list(from)) copy(join(from, name), join(to, name))
  }
  const weight = (paths: readonly string[]) =>
    paths.reduce((total, path) => total + encode(path).length, 0)
  const keepStat = (path: string, stat: FileStat | null) => {
    if (!stats.has(path)) held += encode(path).length
    stats.set(path, stat)
  }
  const keepNames = (path: string, children: string[]) => {
    held += weight(children) - weight(names.get(path) ?? [])
    names.set(path, children)
  }
  const keepBytes = (path: string, data: Uint8Array) => {
    held += data.length - (bytes.get(path)?.length ?? 0)
    bytes.set(path, data)
  }
  const fits = (more: number) => held + more <= options.limits.maxMemoryBytes
  const linked = async (path: string) => (await fs.lstat?.(path))?.kind === 'symlink'
  const prefetch = async (root: string): Promise<void> => {
    trees.add(root)
    let level = [root]
    while (level.length) {
      const fresh = level.filter((path) => !names.has(path))
      const lists = await Promise.all(fresh.map((path) => fs.list(path)))
      const listed = new Map(fresh.map((path, index) => [path, lists[index] ?? []] as const))
      const children = level.flatMap((path) =>
        (listed.get(path) ?? names.get(path) ?? []).map((name) => join(path, name)),
      )
      const unknown = children.filter((path) => !stats.has(path))
      const found = await Promise.all(unknown.map((path) => fs.stat(path)))
      if (!fits(weight(lists.flat()) + weight(unknown))) return
      for (const [path, entries] of listed) keepNames(path, entries)
      unknown.forEach((path, index) => keepStat(path, found[index] ?? null))
      const below = children.filter((path) => stats.get(path)?.kind === 'directory')
      const links = await Promise.all(below.map(linked))
      level = below.filter((_path, index) => !links[index])
    }
  }
  const filesIn = (dir: string) =>
    (names.get(dir) ?? [])
      .map((name) => join(dir, name))
      .filter((path) => stats.get(path)?.kind === 'file')
  const filesUnder = (root: string) =>
    [...stats]
      .filter((entry) => entry[1]?.kind === 'file' && within(entry[0], root))
      .map((entry) => entry[0])
  const sizeOf = (files: readonly string[]) =>
    files.reduce((total, file) => total + (stats.get(file)?.size ?? 0), 0)
  const likely = (root: string, path: string) => {
    const like = filesUnder(root)
      .filter((file) => file !== path && !bytes.has(file) && asked.has(suffixOf(file)))
      .sort()
    const after = like.findIndex((file) => file > path)
    const from = after < 0 ? like.length : after
    const taken: string[] = []
    let total = 0
    for (const file of [path, ...like.slice(from), ...like.slice(0, from)]) {
      const size = stats.get(file)?.size ?? 0
      if (!fits(2 * (total + size))) continue
      taken.push(file)
      total += size
    }
    return taken
  }
  const batch = (path: string): string[] => {
    const dir = parentOf(path)
    const tree = [...trees].find((tree) => within(path, tree))
    const root = tree && [...bytes.keys()].some((file) => within(file, tree)) ? tree : undefined
    const pools = [
      root ? likely(root, path) : [],
      filesIn(dir).some((sibling) => bytes.has(sibling)) ? filesIn(dir) : [],
    ].map((pool) => pool.filter((file) => !bytes.has(file)))
    const pool = pools.find((files) => files.includes(path) && fits(sizeOf(files)))
    return pool ?? [path]
  }
  const fetchTree = async (path: string): Promise<void> => {
    const stat = stats.has(path) ? stats.get(path) : await fs.stat(path)
    keepStat(path, stat ?? null)
    if (stat?.kind === 'file' && !bytes.has(path)) keepBytes(path, await fs.read(path))
    if (stat?.kind !== 'directory') return
    const children = names.get(path) ?? (await fs.list(path))
    keepNames(path, children)
    for (const name of children) await fetchTree(join(path, name))
  }
  const fetchAll = async (paths: readonly string[]) => {
    const data = await Promise.all(paths.map((path) => fs.read(path)))
    paths.forEach((path, index) => keepBytes(path, data[index] ?? new Uint8Array()))
  }
  const checked = () =>
    budget(
      options.limits,
      held,
      'the ' + stats.size + ' paths and ' + bytes.size + ' files this Python run used',
    )
  return {
    changes: () => ({
      deleted: [...gone].filter((path) => kind(path) === undefined),
      dirs: [...made].filter((path) => dirs.has(path)),
      files: new Map(
        [...touched].flatMap((path) => {
          const data = files.get(path)
          return data ? [[path, data] as const] : []
        }),
      ),
    }),
    async fetch() {
      for (const path of wanted.stat) keepStat(path, await fs.stat(path))
      await listing([...wanted.stat].map(parentOf))
      for (const path of wanted.list) {
        const up = parentOf(path)
        const siblings = path === '/' ? undefined : names.get(up)
        if (siblings?.some((name) => join(up, name) !== path && names.has(join(up, name))))
          await prefetch(up)
        else if (siblings) await prefetch(path)
        if (names.has(path)) continue
        const children = await fs.list(path)
        keepNames(path, children)
        for (const name of children) {
          const child = join(path, name)
          if (!stats.has(child)) keepStat(child, await fs.stat(child))
        }
      }
      for (const path of wanted.read) asked.add(suffixOf(path))
      await fetchAll([...new Set([...wanted.read].flatMap(batch))])
      for (const path of wanted.tree) {
        await prefetch(path)
        await fetchAll(filesUnder(path).filter((file) => !bytes.has(file)))
        await fetchTree(path)
      }
      for (const set of Object.values(wanted)) set.clear()
      checked()
    },
    files: {
      list,
      mkdir: (path) => {
        if (kind(path)) throw new FsError('EEXIST', path)
        parent(path)
        dirs.add(path)
        made.add(path)
      },
      read,
      remove: (path) => {
        if (!kind(path)) throw new FsError('ENOENT', path)
        remove(path)
      },
      rename: (from, to) => {
        const found = kind(from)
        if (!found) throw new FsError('ENOENT', from)
        if (found === 'directory' && !bytes.has(from) && !names.has(from) && !made.has(from))
          throw miss(wanted.tree, from)
        parent(to)
        kind(to)
        remove(to)
        try {
          copy(from, to)
        } catch (error) {
          if (missing) wanted.tree.add(from)
          throw error
        }
        remove(from)
      },
      stat: (path) => {
        const found = kind(path)
        if (!found) return null
        if (files.has(path))
          return {
            kind: 'file',
            mode: 0o644,
            mtime: Date.now(),
            size: files.get(path)?.length ?? 0,
          }
        if (dirs.has(path)) return { kind: 'directory', mode: 0o755, mtime: Date.now(), size: 0 }
        return stats.get(path) ?? null
      },
      write,
    },
    missed: () => missing,
    probe: listing,
    settle() {
      missing = false
    },
    reset() {
      missing = false
      files = new Map()
      dirs = new Set()
      gone = new Set()
      touched = new Set()
      made = new Set()
    },
  }
}

function join(base: string, name: string): string {
  return base === '/' ? '/' + name : base + '/' + name
}

function suffixOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot) : ''
}

function within(path: string, dir: string): boolean {
  return path === dir || path.startsWith(dir === '/' ? '/' : dir + '/')
}

function encodeRequest(request: Request, spawns: boolean): Uint8Array {
  const parts: Uint8Array[] = []
  const u32 = (value: number) => {
    const bytes = new Uint8Array(4)
    new DataView(bytes.buffer).setUint32(0, value, true)
    parts.push(bytes)
  }
  const u64 = (value: bigint) => {
    const bytes = new Uint8Array(8)
    new DataView(bytes.buffer).setBigUint64(0, value, true)
    parts.push(bytes)
  }
  const field = (value: string | Uint8Array) => {
    const bytes = typeof value === 'string' ? encode(value) : value
    u32(bytes.length)
    parts.push(bytes)
  }
  u32(request.argv.length)
  for (const arg of request.argv) field(arg)
  field(request.cwd)
  const env = Object.entries(request.env)
  u32(env.length)
  for (const [name, value] of env) {
    field(name)
    field(value)
  }
  field(request.stdin)
  u64(BigInt(request.output))
  u64(BigInt(request.file))
  u64(BigInt(request.steps))
  u64(BigInt(Math.max(0, Math.ceil(request.timeMs))))
  u64(BigInt(request.depth))
  u64(BigInt(request.memory))
  u32(spawns ? 1 : 0)
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    joined.set(part, at)
    at += part.length
  }
  return joined
}

function decodeRan(bytes: Uint8Array): Ran {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  const u32 = () => {
    const value = data.getUint32(at, true)
    at += 4
    return value
  }
  const field = () => {
    const len = u32()
    const value = bytes.subarray(at, at + len)
    at += len
    return value
  }
  const tag = u32()
  const value = u32()
  const stdout = field()
  const stderr = field()
  const u64 = () => {
    const value = data.getBigUint64(at, true)
    at += 8
    return value
  }
  const steps = u64()
  const held = u64()
  const asked = u64()
  const missing: Missing[] = []
  for (let count = u32(); count > 0; count--) {
    const module = text.decode(field())
    const why = u32()
    missing.push({ module, package: why === 0, text: text.decode(field()) })
  }
  if (tag === 0) return { kind: 'exited', status: value | 0, stderr, stdout }
  if (tag === 1) return { kind: 'needs', missing }
  if (tag === 2) return { kind: 'refused', limit: value, stderr, stdout, steps, held, asked }
  return { kind: 'cancelled', stderr, stdout }
}

type RunOptions = {
  files: SyncFileSystem
  fresh?: boolean
  request: Request
  stopped: () => boolean
  tape?: Tape
}

const busy = new WeakMap<WebAssembly.Module, Set<Instance>>()

export function fits(module: WebAssembly.Module, memory: number): boolean {
  let used = 0
  let image = 0
  for (const instance of busy.get(module) ?? []) {
    used += instance.exports.memory.buffer.byteLength
    image = instance.initial
  }
  return instances.has(module) || used + image <= memory
}

async function take(module: WebAssembly.Module, fresh: boolean | undefined): Promise<Instance> {
  const idle = instances.get(module)
  if (!fresh) instances.delete(module)
  const running = busy.get(module) ?? new Set<Instance>()
  busy.set(module, running)
  const taken = idle && !fresh ? idle : await instantiate(module, { running })
  running.add(taken)
  return taken
}

function begin(instance: Instance, options: RunOptions & { spawn?: Spawn | Suspended }) {
  instance.files = options.files
  instance.stopped = options.stopped
  instance.spawn = options.spawn
  instance.tape = options.tape
  const input = encodeRequest(options.request, options.spawn !== undefined)
  const ptr = instance.exports.python_input(input.length)
  new Uint8Array(instance.exports.memory.buffer, ptr >>> 0, input.length).set(input)
}

function warmer(instance: Instance, kept: Instance | undefined): boolean {
  if (kept === undefined) return true
  return (instance.exports.python_held?.() ?? 0) > (kept.exports.python_held?.() ?? 0)
}

function keeps(instance: Pick<Instance, 'exports' | 'held' | 'initial'>, memory: number): boolean {
  const grown = instance.exports.memory.buffer.byteLength - instance.initial
  const held = instance.exports.python_held?.()
  if (held === undefined) return grown <= memory / 2
  return held - instance.held <= memory && grown <= memory + memory / 2
}

function end(module: WebAssembly.Module, instance: Instance, len: number, request: Request): Ran {
  if (!instance.spare && keeps(instance, request.memory) && warmer(instance, instances.get(module)))
    instances.set(module, instance)
  return decodeRan(
    new Uint8Array(
      instance.exports.memory.buffer,
      instance.exports.python_output() >>> 0,
      len >>> 0,
    ).slice(),
  )
}

function failed(instance: Instance, error: unknown): CommandError {
  return new CommandError(
    'the Python interpreter failed and restarts on the next run: ' +
      (instance.panic ?? (error instanceof Error ? error.message : String(error))),
    1,
  )
}

function release(module: WebAssembly.Module, instance: Instance) {
  busy.get(module)?.delete(instance)
  instance.files = undefined
  instance.retry = undefined
  instance.spawn = undefined
  instance.tape = undefined
  instance.stopped = () => false
}

export async function run(
  module: WebAssembly.Module,
  options: RunOptions & { spawn?: Spawn },
): Promise<Ran> {
  const instance = await take(module, options.fresh)
  try {
    begin(instance, options)
    return end(module, instance, instance.exports.python_run(), options.request)
  } catch (error) {
    throw failed(instance, error)
  } finally {
    release(module, instance)
  }
}

export async function runAsync(
  module: WebAssembly.Module,
  options: RunOptions & { retry?: () => Promise<boolean>; spawn?: Suspended },
): Promise<Ran> {
  const instance = await take(module, options.fresh)
  try {
    begin(instance, options)
    instance.retry = options.retry
    const len = (await instance.call!()) as number
    return end(module, instance, len, options.request)
  } catch (error) {
    throw failed(instance, error)
  } finally {
    release(module, instance)
  }
}

function mib(bytes: bigint | number): string {
  return (Number(bytes) / 1048576).toFixed(1)
}

export function report(
  ctx: CommandContext,
  ran: Exclude<Ran, { kind: 'needs' }>,
  budget: Budget,
): number {
  ctx.stdout.write(decode(ran.stdout))
  ctx.stderr.write(decode(ran.stderr))
  if (ran.kind === 'exited') return ran.status
  if (ran.kind === 'cancelled') throw new CommandError('interrupted', 130)
  const limit = limits[ran.limit]
  if (limit === 'time')
    throw new CommandError('timed out after ' + ctx.limits.timeoutMs + ' ms', 124)
  if (limit === 'output') throw new CommandError('it printed more than this shell keeps', 126)
  if (limit === 'memory')
    throw new CommandError(
      (ran.asked > 0n
        ? 'it asked for ' + mib(ran.asked) + ' MiB at once while holding ' + mib(ran.held) + ' MiB'
        : 'it held ' + mib(ran.held) + ' MiB') +
        ', past the ' +
        mib(ctx.limits.maxMemoryBytes) +
        " MiB this shell gives one Python run (the host's maxMemoryBytes limit); read and process the data in chunks (a file line by line, a batch of rows at a time) and write results out as you go instead of holding it all",
      126,
    )
  if (limit === 'sleep') throw new CommandError('it cannot wait in this shell', 126)
  throw new CommandError(
    'it ran ' +
      ran.steps +
      ' steps, the most one Python run may compute here' +
      (budget.stepsPerMs === undefined
        ? ''
        : ' (' +
          budget.cpuMs +
          ' ms of CPU at ' +
          budget.stepsPerMs +
          " steps per ms; the host raises it with Python's cpuMs option, on Cloudflare with the PYTHON_CPU_MS variable or workspace.pythonCpuMs)") +
      '; split the work into shorter runs that save their progress to a file and continue from it',
    124,
  )
}
