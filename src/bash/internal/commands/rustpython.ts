import { FsError, type FileStat, type FileSystem, type SyncFileSystem } from '../../FileSystem.ts'
import { decode, encode, parentOf } from '../Fs.ts'
import { CommandError, budget, type CommandContext, type Limits } from '../Shell.ts'

type Exports = {
  memory: WebAssembly.Memory
  python_input(len: number): number
  python_output(): number
  python_reply(len: number): number
  python_run(): number
}

type Instance = {
  exports: Exports
  files: SyncFileSystem | undefined
  initial: number
  panic: string | undefined
  running: boolean
  spawn: Spawn | undefined
  stopped: () => boolean
}

export type Changes = { deleted: string[]; dirs: string[]; files: Map<string, Uint8Array> }

export type Child = {
  argv: string[]
  cwd: string
  env: Record<string, string>
  merged: boolean
  stdin: Uint8Array
}

export type Spawn = (
  child: Child,
) => { status: number; stderr: Uint8Array; stdout: Uint8Array } | FsError['code']

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

const randomBytes = 65536

const text = new TextDecoder()

const limits = ['output', 'sleep', 'steps', 'time', 'memory'] as const

function instantiate(module: WebAssembly.Module): Instance {
  const state: Instance = {
    exports: undefined as unknown as Exports,
    files: undefined,
    initial: 0,
    panic: undefined,
    running: false,
    spawn: undefined,
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
        const files = state.files
        const handler = ops[op]
        if (!files || !handler) return -BigInt(errno['ENOTSUP'] ?? 0)
        try {
          return handler(files, decode(view(path, pathLen)), view(data, dataLen), arg)
        } catch (error) {
          const code = error instanceof FsError ? errno[error.code] : undefined
          if (code === undefined) throw error
          return -BigInt(code)
        }
      },
      host_now: () => performance.now(),
      host_panic(ptr: number, len: number) {
        state.panic = decode(view(ptr, len))
      },
      host_random(ptr: number, len: number) {
        for (let at = 0; at < len; at += randomBytes)
          crypto.getRandomValues(view(ptr + at, Math.min(randomBytes, len - at)))
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
        const exited = spawn({ argv, cwd, env, merged, stdin })
        if (typeof exited === 'string') return -BigInt(errno[exited] ?? errno['EIO'] ?? 0)
        const out = new Uint8Array(12 + exited.stdout.length + exited.stderr.length)
        const fields = new DataView(out.buffer)
        fields.setInt32(0, exited.status, true)
        fields.setUint32(4, exited.stdout.length, true)
        out.set(exited.stdout, 8)
        fields.setUint32(8 + exited.stdout.length, exited.stderr.length, true)
        out.set(exited.stderr, 12 + exited.stdout.length)
        return reply(out)
      },
      host_stopped: () => (state.stopped() ? 1 : 0),
      host_time: () => Date.now(),
    },
  }
  state.exports = new WebAssembly.Instance(module, imports).exports as unknown as Exports
  state.initial = state.exports.memory.buffer.byteLength
  return state
}

export function layered(
  fs: FileSystem,
  options: { limits: Limits },
): {
  changes(): Changes
  fetch(): Promise<void>
  files: SyncFileSystem
  missed(): boolean
  reset(): void
} {
  const stats = new Map<string, FileStat | null>()
  const names = new Map<string, string[]>()
  const bytes = new Map<string, Uint8Array>()
  const trees = new Set<string>()
  const batched = new Set<string>()
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
    if (!stats.has(path)) throw miss(wanted.stat, path)
    return stats.get(path)?.kind
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
  const batch = (path: string): string[] => {
    const dir = parentOf(path)
    const root = batched.size > 1 ? [...trees].find((tree) => within(path, tree)) : undefined
    const pools = [
      root ? filesUnder(root) : [],
      filesIn(dir).some((sibling) => bytes.has(sibling)) ? filesIn(dir) : [],
    ].map((pool) => pool.filter((file) => !bytes.has(file)))
    const pool = pools.find(
      (files) =>
        files.includes(path) &&
        fits(files.reduce((total, file) => total + (stats.get(file)?.size ?? 0), 0)),
    )
    if (!pool) return [path]
    batched.add(dir)
    return pool
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

export function prepare(module: WebAssembly.Module): void {
  if (!instances.has(module)) instances.set(module, instantiate(module))
}

export function run(
  module: WebAssembly.Module,
  options: { files: SyncFileSystem; request: Request; spawn?: Spawn; stopped: () => boolean },
): Ran {
  if (instances.get(module)?.running) instances.delete(module)
  prepare(module)
  const instance = instances.get(module)!
  instance.files = options.files
  instance.stopped = options.stopped
  instance.spawn = options.spawn
  try {
    const input = encodeRequest(options.request, options.spawn !== undefined)
    const ptr = instance.exports.python_input(input.length)
    new Uint8Array(instance.exports.memory.buffer, ptr, input.length).set(input)
    instance.running = true
    const len = instance.exports.python_run()
    instance.running = false
    if (instance.exports.memory.buffer.byteLength - instance.initial > options.request.memory / 2)
      instances.delete(module)
    return decodeRan(
      new Uint8Array(instance.exports.memory.buffer, instance.exports.python_output(), len).slice(),
    )
  } catch (error) {
    instances.delete(module)
    throw new CommandError(
      'the Python interpreter failed and restarts on the next run: ' +
        (instance.panic ?? (error instanceof Error ? error.message : String(error))),
      1,
    )
  } finally {
    instance.files = undefined
    instance.spawn = undefined
    instance.stopped = () => false
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
