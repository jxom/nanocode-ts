import { CommandError, type CommandContext, type CommandHandler } from '../Shell.ts'
import { FsError, type FileSystem } from '../../FileSystem.ts'
import { breathe, encode, parentOf } from '../Fs.ts'
import * as Psh from '../Psh.ts'
import { mkdirs } from './files.ts'
import { pip, shippedModules, sitePackages } from './pip.ts'
import * as RustPython from './rustpython.ts'
import type { Options as PythonOptions } from '../../Python.ts'

type Mode = {
  kind: 'code' | 'stdin' | 'file' | 'module' | 'pip'
  target: string
  argv: string[]
  filename: string
}

const NO_MODULE =
  "python3 needs nanocode-ts's python.wasm: this host can't load it, so pass it as Python's module option"

function join(base: string, name: string): string {
  return base === '/' ? '/' + name : base + '/' + name
}

function usage(name: string): string {
  return 'usage: ' + name + ' [-c CMD | -m MOD | FILE | -] [ARGS...]'
}

function parse(ctx: CommandContext, args: string[]): Mode | 'help' | 'version' {
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
): Record<string, CommandHandler> {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024
  const handler: CommandHandler = async (ctx) => {
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
    if (mode !== 'version' && mode.kind === 'pip') return pip(ctx, mode.argv)
    const compiled = await rustModule(options)
    if (!compiled) {
      ctx.stderr.write(NO_MODULE + '\n')
      return 126
    }
    return executeRust(ctx, compiled, {
      engine: psh === undefined ? undefined : await Psh.load(await psh),
      maxBytes,
      stdin: ctx.stdin.read(),
      cpuMs: options.cpuMs,
      stepsPerMs: options.stepsPerMs,
    })
  }
  return { pip: handler, pip3: handler, python: handler, python3: handler }
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
  if (!missing.package) return missing.text
  const top = missing.module.split('.')[0]
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

function rustModule(options: PythonOptions): Promise<WebAssembly.Module | undefined> {
  if (options.module === false) return Promise.resolve(undefined)
  if (options.module) return Promise.resolve(options.module)
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
    maxBytes: number
    stdin: string
    stepsPerMs: number | undefined
  },
): Promise<number> {
  const limit = Math.min(options.maxBytes, Math.floor(ctx.limits.maxMemoryBytes / 2))
  const cpuMs = Math.min(ctx.limits.timeoutMs, options.cpuMs ?? ctx.limits.timeoutMs)
  const deadline = Date.now() + ctx.limits.timeoutMs
  const cache = ctx.fs.sync ? undefined : RustPython.layered(ctx.fs, { limits: ctx.limits })
  const files = ctx.fs.sync ?? cache!.files
  const engine = options.engine
  const spawn: RustPython.Spawn | undefined =
    engine &&
    ((child) => {
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
      const name = program(child.argv[0] ?? '')
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
        script:
          [name, ...child.argv.slice(1)]
            .map((word) => "'" + word.replaceAll("'", "'\\''") + "'")
            .join(' ') + (child.merged ? ' 2>&1' : ''),
        shellLimits: ctx.limits,
        signal: ctx.signal,
        stdin: child.stdin,
        strict: false,
        without: ['curl', 'wget'],
      })
      if (!ran) return 'EAGAIN'
      if (ran.ended === 'cancelled') return 'EINTR'
      if (ran.ended === 'exited' && ran.status === notFound && ran.missing.includes(name))
        return 'ENOENT'
      if (ran.ended === 'exited')
        return { status: ran.status, stderr: ran.stderr, stdout: ran.stdout }
      return {
        status: refusedStatus,
        stderr: encode(name + ': it ran more than this shell allows\n'),
        stdout: ran.stdout,
      }
    })
  const attempt = () =>
    RustPython.run(module, {
      files,
      request: {
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
      },
      spawn,
      stopped: () => ctx.signal.aborted || (cache?.missed() ?? false),
    })
  await cache?.probe([ctx.cwd, sitePackages])
  let ran = attempt()
  while (cache?.missed()) {
    await cache.fetch()
    cache.reset()
    ran = attempt()
  }
  if (cache) await apply(ctx.fs, cache.changes())
  if (ran.kind !== 'needs')
    return RustPython.report(ctx, ran, { cpuMs, stepsPerMs: options.stepsPerMs })
  for (const missing of ran.missing) ctx.stderr.write(absent(missing) + '\n')
  return 127
}
