import { CommandError, type CommandContext, type CommandHandler } from '../Shell.ts'
import { FsError, type FileSystem } from '../../FileSystem.ts'
import { breathe, decode, encode, parentOf } from '../Fs.ts'
import * as Psh from '../Psh.ts'
import { mkdirs } from './files.ts'
import * as Journal from './journal.ts'
import { pip, shippedModules, sitePackages } from './pip.ts'
import * as RustPython from './rustpython.ts'
import type { Options as PythonOptions, Sci } from '../../Python.ts'

type Mode = {
  kind: 'code' | 'stdin' | 'file' | 'module' | 'pip'
  target: string
  argv: string[]
  filename: string
}

export type Host = {
  has(name: string): boolean
  run(request: {
    cwd: string
    env: Record<string, string>
    fs: FileSystem
    script: string
    signal: AbortSignal
    stdin: Uint8Array
  }): Promise<{ status: number; stderr: Uint8Array; stdout: Uint8Array }>
}

const NO_IMAGE =
  "python3 needs nanocode-ts's python.data beside python.wasm: pass it as Python's data option"

const NO_MODULE =
  "python3 needs nanocode-ts's python.wasm: this host can't load it, so pass it as Python's module option"

function join(base: string, name: string): string {
  return base === '/' ? '/' + name : base + '/' + name
}

function usage(name: string): string {
  return 'usage: ' + name + ' [-c CMD | -m MOD | FILE | -] [ARGS...]'
}

function uv(args: string[]): Mode | 'version' {
  const rest = args.filter((arg) => arg !== '--system' && arg !== '--quiet' && arg !== '-q')
  const quiet = args.includes('-q') || args.includes('--quiet') ? ['-q'] : []
  const [command, ...more] = rest
  if (command === '--version' || command === 'version') return 'version'
  if (command === 'pip') return { kind: 'pip', target: '', argv: [...more, ...quiet], filename: '' }
  if (command === 'add')
    return { kind: 'pip', target: '', argv: ['install', ...more, ...quiet], filename: '' }
  if (command === 'remove')
    return { kind: 'pip', target: '', argv: ['uninstall', '-y', ...more], filename: '' }
  throw new CommandError(
    'only uv pip, uv add, uv remove and uv run (python or a .py file) work here; they use pip and python3',
    2,
  )
}

function uvRun(ctx: CommandContext): CommandContext {
  const args = ctx.args.filter((arg) => arg !== '--system')
  if (args[0] !== 'run') return ctx
  const rest = args[1] === '--' ? args.slice(2) : args.slice(1)
  if (rest[0] === 'python' || rest[0] === 'python3')
    return { ...ctx, name: 'python3', args: rest.slice(1) }
  if (rest[0]?.endsWith('.py')) return { ...ctx, name: 'python3', args: rest }
  return ctx
}

function parse(ctx: CommandContext, args: string[]): Mode | 'help' | 'version' {
  if (ctx.name === 'uv') return uv(args)
  if (ctx.name === 'pip' || ctx.name === 'pip3')
    return { kind: 'pip', target: '', argv: args, filename: '' }
  let i = 0
  for (; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      i++
      break
    }
    if (!arg.startsWith('-') || arg === '-') break
    if (/^-[cm]./.test(arg))
      return parse(ctx, [...args.slice(0, i), arg.slice(0, 2), arg.slice(2), ...args.slice(i + 1)])
    if (arg === '-c' || arg === '-m') {
      const value = args[i + 1]
      if (value === undefined)
        throw new CommandError(
          'Argument expected for the ' + arg + ' option\n' + usage(ctx.name),
          2,
        )
      const rest = args.slice(i + 2)
      if (arg === '-c')
        return { kind: 'code', target: value, argv: ['-c', ...rest], filename: '<string>' }
      if (value === 'pip' || value === 'pip3')
        return { kind: 'pip', target: '', argv: rest, filename: '' }
      if (value === 'venv' || value === 'virtualenv')
        throw new CommandError(
          '-m ' +
            value +
            ' is not available: pip install puts packages straight into this interpreter',
          1,
        )
      return { kind: 'module', target: value, argv: [value, ...rest], filename: value }
    }
    if (arg === '-V' || arg === '--version') return 'version'
    if (arg === '-h' || arg === '--help') return 'help'
    if (arg === '-W' || arg === '-X') {
      i++
      continue
    }
    if (/^-[uBEsSIOqbdRPW]+$/.test(arg) || /^-[WX]./.test(arg)) continue
    throw new CommandError('unsupported option ' + arg + '\n' + usage(ctx.name), 2)
  }
  const file = args[i]
  if (file === undefined || file === '-')
    return {
      kind: 'stdin',
      target: '',
      argv: [file ?? '', ...args.slice(i + 1)],
      filename: '<stdin>',
    }
  return { kind: 'file', target: '', argv: args.slice(i), filename: ctx.resolve(file) }
}

export function pythonCommands(
  options: PythonOptions = {},
  psh?: WebAssembly.Module | Promise<WebAssembly.Module>,
  host?: Host,
): Record<string, CommandHandler> {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024
  const handler: CommandHandler = async (given) => {
    if (options.unavailable) throw new CommandError(options.unavailable, 126)
    const ctx = given.name === 'uv' ? uvRun(given) : given
    const mode = parse(ctx, ctx.args.slice())
    if (mode === 'help') {
      ctx.stdout.write(
        usage(ctx.name) +
          '\nPython on nanocode-python (RustPython with compiled-in extensions); pip installs pure-Python wheels into ' +
          sitePackages +
          '\n',
      )
      return 0
    }
    if (mode === 'version' && ctx.name === 'uv') {
      ctx.stdout.write('uv (nanocode compatibility: uv pip and uv add run pip, uv run runs python3)\n')
      return 0
    }
    if (mode !== 'version' && mode.kind === 'pip') return pip(ctx, mode.argv)
    const stdin = ctx.stdin.read()
    const sci = options.sci
    const modules = sci?.modules ?? sciModules
    const run = {
      engine: psh === undefined ? undefined : await Psh.load(await psh),
      host,
      maxBytes,
      stdin,
      cpuMs: options.cpuMs,
      stepsPerMs: options.stepsPerMs,
    }
    if (sci && mode !== 'version' && (await importsAny(ctx, mode, stdin, modules)))
      return runSci(ctx, sci, run)
    const compiled = await rustModule(options)
    if (!compiled) {
      ctx.stderr.write(NO_MODULE + '\n')
      return 126
    }
    const missing = await rustImage(options, compiled)
    if (missing) {
      ctx.stderr.write(missing + '\n')
      return 126
    }
    const status = await executeRust(ctx, compiled, { ...run, sci: sci && modules })
    return status === 'sci' ? runSci(ctx, sci!, run) : status
  }
  return { pip: handler, pip3: handler, python: handler, python3: handler, uv: handler }
}

async function erase(fs: FileSystem, path: string): Promise<void> {
  const stat = await fs.stat(path)
  if (stat?.kind === 'directory')
    for (const name of await fs.list(path)) await erase(fs, join(path, name))
  await fs.remove(path)
}

async function apply(fs: FileSystem, changes: RustPython.Changes): Promise<void> {
  for (const path of [...changes.deleted].sort((a, b) => b.length - a.length)) {
    await erase(fs, path).catch((error) => {
      if (!(error instanceof FsError)) throw error
    })
  }
  for (const dir of [...changes.dirs].sort()) await mkdirs(fs, dir)
  for (const [path, data] of changes.files) {
    await breathe()
    await mkdirs(fs, parentOf(path))
    await fs.write(path, data)
  }
}

function absent(missing: RustPython.Missing): string {
  const top = missing.module.split('.')[0]
  if (sciModules.includes(top))
    return (
      "python3: No module named '" +
      top +
      "': " +
      top +
      " runs on nanocode-ts's separate polars interpreter (python-polars.wasm), which this host doesn't offer; pass it as Python's sci option"
    )
  if (!missing.package) return missing.text
  const head = 'python3: ' + missing.module + ': '
  const error = missing.text.startsWith(head)
    ? missing.text.slice(head.length).replace(/ \(this simulated shell has no [^)]*\)$/, '')
    : missing.text
  const named = /^No module named '([^']+)'/.exec(error)?.[1]
  if (named === undefined) return 'python3: import ' + missing.module + ' failed: ' + error
  if (named !== top && !missing.module.startsWith(named + '.'))
    return (
      "python3: No module named '" +
      named +
      "', which " +
      missing.module +
      ' imports (pip install ' +
      named.split('.')[0] +
      ' if it is a pure-Python package)'
    )
  return (
    "python3: No module named '" +
    top +
    "' (nanocode's Python ships " +
    shippedModules.join(', ') +
    '; pure-Python packages: pip install ' +
    top +
    ')'
  )
}

let compiles: boolean | undefined

function canCompile(): boolean {
  if (compiles !== undefined) return compiles
  try {
    new (WebAssembly as unknown as { Module: new (bytes: Uint8Array) => unknown }).Module(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    )
    compiles = true
  } catch {
    compiles = false
  }
  return compiles
}

const packagedRust: { module?: Promise<WebAssembly.Module | undefined> } = {}

const packagedPython = '../../../python.wasm'

const packagedImage = '../../../python.data'

const imageLoads = new WeakMap<WebAssembly.Module, Promise<string | undefined>>()

type Data = Uint8Array | ArrayBuffer

async function packagedData(): Promise<Data | undefined> {
  const process = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } })
    .process
  const fs = process?.getBuiltinModule?.('node:fs') as
    | { promises: { readFile(path: URL): Promise<Uint8Array> } }
    | undefined
  const meta = import.meta as { resolve?: (specifier: string) => string; url?: string }
  const url = meta.resolve
    ? new URL(meta.resolve('nanocode-ts/python.data'))
    : meta.url
      ? new URL(packagedImage, meta.url)
      : undefined
  if (!fs || !url) return undefined
  return fs.promises.readFile(url)
}

// Loads python.data once per module and isolate; a failed load is retried on the next run.
function rustImage(
  options: PythonOptions,
  module: WebAssembly.Module,
): Promise<string | undefined> {
  if (!RustPython.needsImage(module)) return Promise.resolve(undefined)
  let loading = imageLoads.get(module)
  if (!loading) {
    loading = (async () => {
      const data = await (typeof options.data === 'function'
        ? options.data()
        : (options.data ?? packagedData()))
      if (!data) return NO_IMAGE
      await RustPython.provide(module, data)
      return undefined
    })().catch(
      (error: unknown) =>
        NO_IMAGE + ': ' + (error instanceof Error ? error.message : String(error)),
    )
    imageLoads.set(module, loading)
    void loading.then((failed) => {
      if (failed) imageLoads.delete(module)
    })
  }
  return loading
}

const moduleLoads = new WeakMap<() => Promise<WebAssembly.Module>, Promise<WebAssembly.Module>>()

function loadModule(load: () => Promise<WebAssembly.Module>): Promise<WebAssembly.Module> {
  let loading = moduleLoads.get(load)
  if (!loading) {
    loading = load()
    moduleLoads.set(load, loading)
    loading.catch(() => moduleLoads.delete(load))
  }
  return loading
}

function rustModule(options: PythonOptions): Promise<WebAssembly.Module | undefined> {
  if (options.module === false) return Promise.resolve(undefined)
  if (options.module instanceof WebAssembly.Module) return Promise.resolve(options.module)
  if (options.module) return loadModule(options.module)
  packagedRust.module ??= (async () => {
    const process = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } })
      .process
    const fs = process?.getBuiltinModule?.('node:fs') as
      | { promises: { readFile(path: URL): Promise<Uint8Array> } }
      | undefined
    const meta = import.meta as { resolve?: (specifier: string) => string; url?: string }
    const url = meta.resolve
      ? new URL(meta.resolve('nanocode-ts/python.wasm'))
      : meta.url
        ? new URL(packagedPython, meta.url)
        : undefined
    if (!fs || !url || !canCompile()) return undefined
    const bytes = await fs.promises.readFile(url)
    const compile = (
      WebAssembly as unknown as { compile(bytes: Uint8Array): Promise<WebAssembly.Module> }
    ).compile
    return compile(bytes)
  })().catch(() => undefined)
  return packagedRust.module
}

const notFound = 127

type Known = {
  effects: Journal.Effects
  exited: RustPython.Exited
  key: string
  replaced: boolean
}

function changing(child: RustPython.Child): RustPython.Exited {
  return {
    status: refusedStatus,
    stderr: encode(
      program(child.argv[0] ?? '') +
        ': python3 runs this command by running the script again up to it, and the script asked for a different command each time; make the command depend only on the files and earlier commands, not on the time or random numbers\n',
    ),
    stdout: new Uint8Array(),
  }
}

function words(argv: readonly string[]): string {
  return [program(argv[0] ?? ''), ...argv.slice(1)]
    .map((word) => "'" + word.replaceAll("'", "'\\''") + "'")
    .join(' ')
}

function shellScript(argv: readonly string[]): string | undefined {
  const name = program(argv[0] ?? '')
  return (name === 'sh' || name === 'bash') && argv[1] === '-c' && argv.length === 3
    ? argv[2]
    : undefined
}

const refusedStatus = 126

const programs = ['/usr/bin/', '/bin/']

function program(path: string): string {
  const directory = programs.find((prefix) => path.startsWith(prefix))
  const name = directory === undefined ? path : path.slice(directory.length)
  return name.includes('/') ? path : name
}

async function executeRust(
  ctx: CommandContext,
  module: WebAssembly.Module,
  options: {
    cpuMs: number | undefined
    engine: Psh.Instance | undefined
    host: Host | undefined
    maxBytes: number
    sci?: readonly string[] | undefined
    stdin: string
    stepsPerMs: number | undefined
  },
): Promise<number | 'sci'> {
  const limit = Math.min(options.maxBytes, Math.floor(ctx.limits.maxMemoryBytes / 2))
  const cpuMs = Math.min(ctx.limits.timeoutMs, options.cpuMs ?? ctx.limits.timeoutMs)
  const deadline = Date.now() + ctx.limits.timeoutMs
  const cache = ctx.fs.sync ? undefined : RustPython.layered(ctx.fs, { limits: ctx.limits })
  const journal = Journal.create(ctx.fs.sync ?? cache!.files, {
    bytes: ctx.limits.maxMemoryBytes,
  })
  const files = journal.files
  const engine = options.engine
  const host = options.host
  const known: Known[] = []
  let spawned = 0
  let replaced = false
  const tape: RustPython.Tape = {
    clock: [],
    clockAt: 0,
    random: [],
    randomAt: 0,
    time: [],
    timeAt: 0,
  }
  let pending:
    | {
        at: number
        child: RustPython.Child
        clock: number
        key: string
        mark: Journal.Mark
        random: number
        time: number
      }
    | undefined
  const now = (child: RustPython.Child): RustPython.Exited | 'host' | FsError['code'] => {
    const name = program(child.argv[0] ?? '')
    if (!engine) return 'host'
    const fs: FileSystem = {
      list: async (path) => files.list(path),
      mkdir: async (path) => files.mkdir(path),
      read: async (path) => files.read(path),
      remove: async (path) => files.remove(path),
      rename: async (from, to) => files.rename(from, to),
      stat: async (path) => files.stat(path),
      sync: files,
      write: async (path, data, append) => files.write(path, data, append),
    }
    const ran = Psh.runNow(engine, {
      commandFs: fs,
      commands: new Map(),
      cwd: child.cwd,
      env: child.env,
      fetch: undefined,
      fs,
      identity: Psh.identity(child.env),
      kept: undefined,
      limits: {
        depth: ctx.limits.maxCallDepth,
        file: ctx.limits.maxMemoryBytes,
        fuel: ctx.limits.maxCommands,
        memory: ctx.limits.maxMemoryBytes,
        operations: ctx.limits.maxFileOperations,
        output: ctx.limits.maxOutputLength,
      },
      machine: undefined,
      script: words(child.argv) + (child.merged ? ' 2>&1' : ''),
      shellLimits: ctx.limits,
      signal: ctx.signal,
      stdin: child.stdin,
      strict: false,
      without: ['curl', 'wget'],
    })
    if (!ran) return host ? 'host' : 'EAGAIN'
    if (ran.ended === 'cancelled') return 'EINTR'
    if (host && ran.missing.some((missing) => host.has(missing))) return 'host'
    if (ran.ended === 'exited' && ran.status === notFound && ran.missing.includes(name))
      return 'ENOENT'
    if (ran.ended === 'exited')
      return { status: ran.status, stderr: ran.stderr, stdout: ran.stdout }
    return {
      status: refusedStatus,
      stderr: encode(name + ': it ran more than this shell allows\n'),
      stdout: ran.stdout,
    }
  }
  const spawn: RustPython.Spawn | undefined =
    (engine || host) &&
    ((child) => {
      if (pending) return 'EAGAIN'
      try {
        return start(child)
      } catch (error) {
        if (error instanceof FsError) return error.code
        throw error
      }
    })
  const start = (child: RustPython.Child): ReturnType<RustPython.Spawn> => {
    const at = spawned++
    const key = JSON.stringify([
      child.argv,
      child.cwd,
      child.env,
      child.merged,
      decode(child.stdin),
    ])
    const before = known[at]
    if (before?.key === key) {
      journal.replay(before.effects)
      return before.exited
    }
    if (before?.replaced) return changing(child)
    if (before) known.length = at
    const mark = journal.mark()
    const ran = now(child)
    if (typeof ran === 'object') {
      if (!cache?.missed())
        known.push({
          effects: journal.capture(journal.touched(mark)),
          exited: ran,
          key,
          replaced: false,
        })
      return ran
    }
    if (ran !== 'host') return ran
    replaced = before !== undefined
    journal.rollback(mark)
    const name = program(child.argv[0] ?? '')
    if (shellScript(child.argv) === undefined && !host!.has(name)) return 'ENOENT'
    if (journal.overflowed()) return 'ENOMEM'
    pending = {
      at,
      child,
      clock: tape.clockAt,
      key,
      mark,
      random: tape.randomAt,
      time: tape.timeAt,
    }
    return 'EAGAIN'
  }
  const request = (): RustPython.Request => ({
    argv: ctx.args,
    cwd: ctx.cwd,
    depth: ctx.limits.maxCallDepth,
    env: { ...ctx.env, PWD: ctx.cwd },
    file: limit,
    memory: ctx.limits.maxMemoryBytes,
    output: ctx.limits.maxOutputLength,
    stdin: encode(options.stdin),
    steps:
      options.stepsPerMs === undefined
        ? Number.MAX_SAFE_INTEGER
        : Math.ceil(cpuMs * options.stepsPerMs),
    timeMs: deadline - Date.now(),
  })
  const stopped = () => ctx.signal.aborted || pending !== undefined || (cache?.missed() ?? false)
  const attempt = (): Promise<RustPython.Ran> =>
    RustPython.suspends
      ? RustPython.runAsync(module, {
          files,
          fresh: known.length > 0,
          request: request(),
          retry,
          spawn: suspended,
          stopped,
          tape,
        })
      : Promise.resolve(
          RustPython.run(module, {
            files,
            fresh: known.length > 0,
            request: request(),
            spawn,
            stopped,
            tape,
          }),
        )
  const retry = cache
    ? async () => {
        if (!cache.missed()) return false
        await cache.fetch()
        cache.settle()
        return true
      }
    : undefined
  const hosted = async (at: number, child: RustPython.Child, key: string) => {
    const started = journal.mark()
    const script = shellScript(child.argv) ?? words(child.argv)
    const exited = await host!.run({
      cwd: child.cwd,
      env: child.env,
      fs: Journal.view(files, { retry }),
      script: child.merged ? '{ ' + script + '\n} 2>&1' : script,
      signal: ctx.signal,
      stdin: child.stdin,
    })
    const touched = journal.touched(started)
    let effects: Journal.Effects | undefined
    while (!effects)
      try {
        effects = journal.capture(touched)
      } catch (error) {
        if (!retry || !(await retry())) throw error
      }
    known.length = at
    known.push({ effects, exited, key, replaced })
    return exited
  }
  const nests = (child: RustPython.Child) =>
    child.argv.some((word) => word.includes('python')) &&
    !RustPython.fits(module, ctx.limits.maxMemoryBytes)
  const resumed = async (
    child: RustPython.Child,
    at: number,
    mark: Journal.Mark,
  ): Promise<RustPython.Exited | FsError['code']> => {
    for (;;) {
      journal.rollback(mark)
      spawned = at
      known.length = at
      pending = undefined
      await retry!()
      const ran = spawn!(child)
      if (!cache!.missed()) return onward(child, at, ran)
    }
  }
  const onward = (
    child: RustPython.Child,
    at: number,
    ran: RustPython.Exited | FsError['code'],
  ): RustPython.Exited | FsError['code'] | Promise<RustPython.Exited | FsError['code']> => {
    if (ran !== 'EAGAIN' || !pending || !host || nests(pending.child)) return ran
    const { key } = pending
    pending = undefined
    return hosted(at, child, key).catch((error: unknown) => {
      if (error instanceof FsError) return error.code
      throw error
    })
  }
  const suspended: RustPython.Suspended | undefined =
    spawn &&
    ((child) => {
      const at = spawned
      const mark = journal.mark()
      const ran = spawn(child)
      return cache?.missed() ? resumed(child, at, mark) : onward(child, at, ran)
    })
  const again = () => {
    if (cache) cache.reset()
    else journal.rollback({ first: 0, changes: 0 })
    journal.clear()
    spawned = 0
    pending = undefined
    tape.clockAt = 0
    tape.randomAt = 0
    tape.timeAt = 0
    return attempt()
  }
  await cache?.probe([ctx.cwd, sitePackages])
  let ran = await attempt()
  for (;;) {
    if (cache?.missed()) {
      await cache.fetch()
      ran = await again()
      continue
    }
    if (!pending || !host || ctx.signal.aborted) break
    const { at, child, key, mark } = pending
    tape.clock.length = pending.clock
    tape.random.length = pending.random
    tape.time.length = pending.time
    journal.rollback(mark)
    await hosted(at, child, key)
    ran = await again()
  }
  const notImported =
    ran.kind === 'needs'
      ? ran.missing.map((missing) => missing.module.split('.')[0]!)
      : ran.kind === 'exited' && ran.status !== 0
        ? uncaughtImport(decode(ran.stderr))
        : []
  if (
    options.sci &&
    !ctx.signal.aborted &&
    notImported.some((name) => options.sci!.includes(name))
  ) {
    if (!cache) journal.rollback({ first: 0, changes: 0 })
    return 'sci'
  }
  if (cache) await apply(ctx.fs, cache.changes())
  if (ran.kind !== 'needs') {
    const status = RustPython.report(ctx, ran, {
      cpuMs,
      stepsPerMs: options.stepsPerMs,
    })
    for (const name of notImported)
      if (sciModules.includes(name))
        ctx.stderr.write(absent({ module: name, package: false, text: '' }) + '\n')
    return status
  }
  for (const missing of ran.missing) ctx.stderr.write(absent(missing) + '\n')
  return 127
}

const sciModules: readonly string[] = ['polars']

function uncaughtImport(stderr: string): string[] {
  const match = /ModuleNotFoundError: No module named '([A-Za-z_]\w*)[.']\S*\s*$/.exec(stderr)
  return match ? [match[1]!] : []
}

const importLines =
  /(?:^|;)[ \t]*(?:from[ \t]+([A-Za-z_]\w*)[\w.]*[ \t]+import\b|import[ \t]+([^\n#;]+))/gm

export function importing(source: string, modules: readonly string[]): boolean {
  for (const match of source.matchAll(importLines)) {
    const names = match[1]
      ? [match[1]]
      : match[2]!.split(',').map((part) => part.trim().split(/[\s.]/)[0]!)
    if (names.some((name) => modules.includes(name))) return true
  }
  return modules.some((name) =>
    new RegExp('(?:__import__|import_module)\\(\\s*[\'"]' + name + '(?:[\'".])').test(source),
  )
}

async function readText(fs: FileSystem, path: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(path)
    if (stat?.kind !== 'file') return undefined
    return decode(await fs.read(path))
  } catch {
    return undefined
  }
}

async function importsAny(
  ctx: CommandContext,
  mode: Mode,
  stdin: string,
  modules: readonly string[],
): Promise<boolean> {
  if (mode.kind === 'code') return importing(mode.target, modules)
  if (mode.kind === 'stdin') return importing(stdin, modules)
  if (mode.kind === 'file') return importing((await readText(ctx.fs, mode.filename)) ?? '', modules)
  if (mode.kind !== 'module') return false
  if (modules.includes(mode.target.split('.')[0]!)) return true
  const base = join(ctx.cwd, mode.target.replaceAll('.', '/'))
  const source =
    (await readText(ctx.fs, base + '.py')) ?? (await readText(ctx.fs, base + '/__main__.py'))
  return importing(source ?? '', modules)
}

const skipped = new Set(['.git', 'node_modules'])

async function gather(
  ctx: CommandContext,
  cap: number,
): Promise<{ files: Map<string, Uint8Array>; left: number }> {
  const files = new Map<string, Uint8Array>()
  const seen = new Set<string>()
  let bytes = 0
  let left = 0
  const visit = async (path: string): Promise<void> => {
    if (seen.has(path)) return
    seen.add(path)
    const stat = await (ctx.fs.lstat ? ctx.fs.lstat(path) : ctx.fs.stat(path)).catch(() => null)
    if (!stat) return
    if (stat.kind === 'directory') {
      const names = await ctx.fs.list(path).catch(() => [] as string[])
      for (const name of names.sort()) if (!skipped.has(name)) await visit(join(path, name))
      return
    }
    if (stat.kind !== 'file') return
    if (bytes + stat.size > cap) {
      left++
      return
    }
    await breathe()
    const data = await ctx.fs.read(path).catch(() => undefined)
    if (!data) return
    files.set(path, data)
    bytes += data.length
  }
  const sources = [...ctx.args]
  for (const arg of ctx.args)
    if (!arg.startsWith('-') && arg !== '/') {
      const path = ctx.resolve(arg)
      const stat = await ctx.fs.stat(path).catch(() => null)
      if (stat?.kind !== 'file') continue
      await visit(path)
      if (path.endsWith('.py')) sources.push((await readText(ctx.fs, path)) ?? '')
    }
  for (const source of sources)
    for (const match of source.matchAll(/["'](\/[^"'\n*?]+)["']/g))
      if (match[1] !== '/' && !match[1]!.startsWith('/dev/') && !match[1]!.startsWith('/proc/'))
        await visit(match[1]!.replace(/\/+$/, ''))
  if (ctx.cwd !== '/') await visit(ctx.cwd)
  await visit(sitePackages)
  return { files, left }
}

async function runSci(
  ctx: CommandContext,
  sci: Sci,
  run: Parameters<typeof executeRust>[2],
): Promise<number> {
  if (sci.module) {
    const compiled =
      sci.module instanceof WebAssembly.Module ? sci.module : await loadModule(sci.module)
    const missing = await rustImage({ data: sci.data }, compiled)
    if (missing) {
      ctx.stderr.write(missing.replace('python.data', 'python-polars.data') + '\n')
      return 126
    }
    const status = await executeRust(ctx, compiled, { ...run, sci: undefined })
    return status === 'sci' ? 127 : status
  }
  const cap = sci.sendBytes ?? ctx.limits.maxMemoryBytes
  const { files, left } = await gather(ctx, cap)
  let result
  try {
    result = await sci.run(
      {
        argv: ctx.args,
        cwd: ctx.cwd,
        env: { ...ctx.env, PWD: ctx.cwd },
        files: [...files],
        memory: ctx.limits.maxMemoryBytes,
        stdin: encode(run.stdin),
        timeMs: ctx.limits.timeoutMs,
      },
      ctx.signal,
    )
  } catch (error) {
    if (ctx.signal.aborted) return 130
    ctx.stderr.write(
      'python3: the polars interpreter failed: ' +
        (error instanceof Error ? error.message : String(error)) +
        '\n',
    )
    return 1
  }
  for (const path of [...(result.deleted ?? [])].sort((a, b) => b.length - a.length))
    await erase(ctx.fs, path).catch((error) => {
      if (!(error instanceof FsError)) throw error
    })
  for (const [path, data] of result.files) {
    await breathe()
    await mkdirs(ctx.fs, parentOf(path))
    await ctx.fs.write(path, data)
  }
  ctx.stdout.write(result.stdout)
  ctx.stderr.write(result.stderr)
  if (left)
    ctx.stderr.write(
      'python3: the polars interpreter ran without ' +
        left +
        ' files past the ' +
        Math.round(cap / 1048576) +
        ' MiB of files it is sent\n',
    )
  return result.status
}
