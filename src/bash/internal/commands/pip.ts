import { CommandError, type CommandContext } from '../Shell.ts'
import { FsError, type FileSystem } from '../../FileSystem.ts'
import { decode, encode, parentOf } from '../Fs.ts'
import { mkdirs } from './files.ts'
import { contents, readEntries, unsafe } from './zip.ts'

export const sitePackages = '/usr/local/lib/python3.14/site-packages'

const index = 'https://pypi.org/pypi/'

const shipped: Record<string, string> = {
  contourpy: 'contourpy',
  kiwisolver: 'kiwisolver',
  markupsafe: 'markupsafe',
  matplotlib: 'matplotlib',
  msgpack: 'msgpack',
  numpy: 'numpy',
  pillow: 'PIL',
  pyyaml: 'yaml',
  regex: 'regex',
  ujson: 'ujson',
}

export const shippedModules = Object.values(shipped)

const environment: Record<string, string> = {
  implementation_name: 'rustpython',
  implementation_version: '3.14.0',
  os_name: 'posix',
  platform_machine: 'wasm32',
  platform_python_implementation: 'RustPython',
  platform_release: '',
  platform_system: 'Linux',
  platform_version: '',
  python_full_version: '3.14.0',
  python_version: '3.14',
  sys_platform: 'linux',
}

const versionKeys = new Set(['python_version', 'python_full_version', 'implementation_version'])

type Version = {
  epoch: number
  release: number[]
  pre: [number, number] | null
  post: number
  dev: number
}

type Requirement = { name: string; extras: string[]; specs: [string, string][]; marker: string }

type Installed = { name: string; version: string; dir: string; requires: string[] }

type ReleaseFile = {
  filename: string
  url: string
  size: number
  yanked?: boolean
  packagetype: string
  requires_python?: string | null
}

type Project = { info: { name: string }; releases: Record<string, ReleaseFile[]> }

type Flags = { quiet: boolean; upgrade: boolean; deps: boolean; pre: boolean }

function normalize(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

function parseVersion(text: string): Version | undefined {
  const match =
    /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|c|rc|alpha|beta|pre|preview)[-_.]?(\d*))?(?:-(\d+)|[-_.]?(?:post|rev|r)[-_.]?(\d*))?(?:[-_.]?dev[-_.]?(\d*))?(?:\+[a-z0-9.]+)?$/i.exec(
      text.trim(),
    )
  if (!match) return undefined
  const kind = match[3]?.toLowerCase()
  const rank = kind === undefined ? -1 : kind.startsWith('a') ? 0 : kind.startsWith('b') ? 1 : 2
  const post = match[5] ?? match[6]
  return {
    epoch: Number(match[1] ?? 0),
    release: match[2].split('.').map(Number),
    pre: rank < 0 ? null : [rank, Number(match[4] || 0)],
    post: post === undefined ? -1 : Number(post || 0),
    dev: match[7] === undefined ? Infinity : Number(match[7] || 0),
  }
}

function compare(a: Version, b: Version): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch
  for (let i = 0; i < Math.max(a.release.length, b.release.length); i++) {
    const delta = (a.release[i] ?? 0) - (b.release[i] ?? 0)
    if (delta) return delta
  }
  const stage = (v: Version) =>
    v.pre ? v.pre : v.post < 0 && v.dev !== Infinity ? [-1, 0] : [3, 0]
  const [sa, sb] = [stage(a), stage(b)]
  if (sa[0] !== sb[0]) return sa[0] - sb[0]
  if (sa[1] !== sb[1]) return sa[1] - sb[1]
  if (a.post !== b.post) return a.post - b.post
  return a.dev === b.dev ? 0 : a.dev < b.dev ? -1 : 1
}

function prerelease(version: Version): boolean {
  return version.pre !== null || version.dev !== Infinity
}

function matches(text: string, op: string, wanted: string): boolean {
  if (op === '===') return text === wanted
  const version = parseVersion(text)
  if (!version) return false
  if ((op === '==' || op === '!=') && wanted.endsWith('.*')) {
    const prefix = wanted.slice(0, -2).split('.').map(Number)
    const same = prefix.every((part, i) => (version.release[i] ?? 0) === part)
    return op === '==' ? same : !same
  }
  const target = parseVersion(wanted)
  if (!target) return false
  const order = compare(version, target)
  if (op === '==') return order === 0
  if (op === '!=') return order !== 0
  if (op === '>=') return order >= 0
  if (op === '<=') return order <= 0
  if (op === '>') return order > 0
  if (op === '<') return order < 0 && !(prerelease(version) && !prerelease(target))
  if (op === '~=') {
    const fixed = target.release.slice(0, Math.max(1, target.release.length - 1))
    return order >= 0 && fixed.every((part, i) => (version.release[i] ?? 0) === part)
  }
  return false
}

function parseSpecs(text: string): [string, string][] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = /^(===|==|!=|~=|>=|<=|>|<)\s*(\S+)$/.exec(part)
      if (!match) throw new CommandError('invalid version specifier: ' + part, 1)
      return [match[1], match[2]]
    })
}

function satisfies(version: string, specs: [string, string][]): boolean {
  return specs.every(([op, wanted]) => matches(version, op, wanted))
}

function spelled(requirement: Requirement): string {
  return requirement.name + requirement.specs.map((spec) => spec.join('')).join(',')
}

function parseRequirement(text: string): Requirement {
  const cut = text.indexOf(';')
  const body = cut < 0 ? text : text.slice(0, cut)
  const match =
    /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[([^\]]*)\])?\s*\(?([^()@/]*)\)?\s*$/.exec(
      body,
    )
  if (!match)
    throw new CommandError(
      'cannot install ' +
        text.trim() +
        ': only PyPI project names with optional extras and version specifiers are supported',
      1,
    )
  return {
    name: match[1],
    extras: (match[2] ?? '')
      .split(',')
      .map((extra) => normalize(extra.trim()))
      .filter(Boolean),
    specs: parseSpecs(match[3]),
    marker: cut < 0 ? '' : text.slice(cut + 1).trim(),
  }
}

function tokenize(marker: string): string[] {
  const tokens: string[] = []
  const pattern =
    /\s*(\(|\)|===|==|!=|~=|>=|<=|<|>|not\s+in\b|in\b|and\b|or\b|'[^']*'|"[^"]*"|[A-Za-z_][\w.]*)/y
  let at = 0
  while (marker.slice(at).trim()) {
    pattern.lastIndex = at
    const match = pattern.exec(marker)
    if (!match) throw new CommandError('cannot read environment marker: ' + marker, 1)
    tokens.push(match[1].replace(/\s+/g, ' '))
    at = pattern.lastIndex
  }
  return tokens
}

function evaluate(marker: string, extras: string[]): boolean {
  if (!marker) return true
  const tokens = tokenize(marker)
  let at = 0
  const value = (): { text: string; key?: string } => {
    const token = tokens[at++]
    if (token === undefined) throw new CommandError('cannot read environment marker: ' + marker, 1)
    if (/^['"]/.test(token)) return { text: token.slice(1, -1) }
    if (token === 'extra') return { text: '', key: 'extra' }
    if (!(token in environment))
      throw new CommandError('unknown environment marker ' + token + ' in ' + marker, 1)
    return { text: environment[token], key: token }
  }
  const comparison = (): boolean => {
    if (tokens[at] === '(') {
      at++
      const result = disjunction()
      at++
      return result
    }
    const left = value()
    const op = tokens[at++]
    const right = value()
    if (left.key === 'extra' || right.key === 'extra') {
      const present = extras.includes(normalize(left.key === 'extra' ? right.text : left.text))
      return op === '!=' ? !present : present
    }
    if (op === 'in') return right.text.includes(left.text)
    if (op === 'not in') return !right.text.includes(left.text)
    if ((left.key && versionKeys.has(left.key)) || (right.key && versionKeys.has(right.key)))
      return matches(left.text, op, right.text)
    if (op === '==' || op === '===') return left.text === right.text
    if (op === '!=') return left.text !== right.text
    return matches(left.text, op, right.text)
  }
  const conjunction = (): boolean => {
    let result = comparison()
    while (tokens[at] === 'and') {
      at++
      result = comparison() && result
    }
    return result
  }
  const disjunction = (): boolean => {
    let result = conjunction()
    while (tokens[at] === 'or') {
      at++
      result = conjunction() || result
    }
    return result
  }
  return disjunction()
}

function tags(filename: string): string[] {
  return filename.slice(0, -4).split('-').slice(-3)
}

function pure(filename: string): boolean {
  const [python, abi, platform] = tags(filename)
  return (
    abi === 'none' && platform === 'any' && python.split('.').some((tag) => /^py3\d*$/.test(tag))
  )
}

function platform(filename: string): number {
  const [python, abi, platforms] = tags(filename)
  const version = /^cp3(\d+)$/.exec(python)
  if (!version || Number(version[1]) > 14 || !(abi === python || abi === 'abi3')) return -1
  return platforms.split('.').some((tag) => /^(many|musl)linux.*_x86_64$/.test(tag))
    ? Number(version[1])
    : -1
}

function compiledModule(name: string): string | undefined {
  const match = /^((?:[A-Za-z_]\w*\/)*[A-Za-z_]\w*)\.[^/]*(?:so|pyd)$/.exec(name)
  return match ? match[1].replace(/\//g, '.') : undefined
}

function fits(requires: string | null | undefined): boolean {
  if (!requires) return true
  try {
    return satisfies(environment.python_full_version, parseSpecs(requires))
  } catch {
    return false
  }
}

function fields(metadata: string, key: string): string[] {
  const values: string[] = []
  for (const line of metadata.split(/\r?\n/)) {
    if (!line) break
    const cut = line.indexOf(':')
    if (cut > 0 && line.slice(0, cut).toLowerCase() === key.toLowerCase())
      values.push(line.slice(cut + 1).trim())
  }
  return values
}

async function installed(fs: FileSystem): Promise<Map<string, Installed>> {
  const found = new Map<string, Installed>()
  const names = await fs.list(sitePackages).catch((error: unknown) => {
    if (error instanceof FsError) return [] as string[]
    throw error
  })
  for (const entry of names) {
    if (!entry.endsWith('.dist-info')) continue
    const dir = sitePackages + '/' + entry
    const metadata = await fs.read(dir + '/METADATA').then(decode, () => '')
    const name = fields(metadata, 'Name')[0]
    const version = fields(metadata, 'Version')[0]
    if (name && version)
      found.set(normalize(name), {
        name,
        version,
        dir,
        requires: fields(metadata, 'Requires-Dist'),
      })
  }
  return found
}

async function removeTree(fs: FileSystem, path: string): Promise<void> {
  const stat = await fs.stat(path)
  if (!stat) return
  if (stat.kind === 'directory')
    for (const name of await fs.list(path)) await removeTree(fs, path + '/' + name)
  await fs.remove(path)
}

async function remove(fs: FileSystem, found: Installed): Promise<void> {
  const record = await fs.read(found.dir + '/RECORD').then(decode, () => '')
  const paths = new Set<string>()
  for (const line of record.split(/\r?\n/)) {
    const path = line.startsWith('"') ? line.slice(1, line.indexOf('"', 1)) : line.split(',')[0]
    if (path && !unsafe(path)) paths.add(sitePackages + '/' + path)
  }
  const dirs = new Set<string>()
  for (const path of paths) {
    await fs.remove(path).catch((error: unknown) => {
      if (!(error instanceof FsError)) throw error
    })
    for (let dir = parentOf(path); dir.length > sitePackages.length; dir = parentOf(dir))
      dirs.add(dir)
  }
  for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
    const left = await fs.list(dir).catch(() => undefined)
    if (left && left.every((name) => name === '__pycache__')) await removeTree(fs, dir)
  }
  await removeTree(fs, found.dir)
}

function dependencies(requires: string[], extras: string[]): Requirement[] {
  return requires
    .map(parseRequirement)
    .filter((requirement) => evaluate(requirement.marker, extras))
}

function size(bytes: number): string {
  return bytes >= 1024 * 1024
    ? (bytes / 1024 / 1024).toFixed(1) + ' MB'
    : Math.ceil(bytes / 1024) + ' kB'
}

function binary(name: string): boolean {
  return /\.(so|pyd|dylib)(\.[\w.]+)?$/.test(name)
}

type Carried = { builtin: Set<string>; frozen: Set<string> }

async function carried(ctx: CommandContext): Promise<Carried> {
  const ran = await ctx.exec(
    "python3 -c 'import sys, _imp; print(*sys.builtin_module_names); print(*_imp._frozen_module_names())'",
  )
  const [builtin, frozen] = ran.stdout.split('\n')
  if (ran.status !== 0 || frozen === undefined)
    throw new CommandError("could not list python3's built-in modules", 1)
  return {
    builtin: new Set(builtin.trim().split(/\s+/)),
    frozen: new Set(frozen.trim().split(/\s+/)),
  }
}

async function install(ctx: CommandContext, wanted: Requirement[], flags: Flags): Promise<number> {
  const fetch = ctx.fetch
  if (!fetch) throw new CommandError('network access is not available in this shell', 1)
  const say = (text: string) => {
    if (!flags.quiet) ctx.stdout.write(text + '\n')
  }
  const present = await installed(ctx.fs)
  const queue = wanted.map((requirement) => ({ requirement, top: true }))
  const chosen = new Map<string, string>()
  const done: string[] = []
  const modules = await carried(ctx)
  for (let item = queue.shift(); item; item = queue.shift()) {
    const { requirement, top } = item
    const key = normalize(requirement.name)
    const previous = chosen.get(key)
    if (previous !== undefined) {
      if (previous && !satisfies(previous, requirement.specs))
        throw new CommandError(
          'cannot install ' +
            spelled(requirement) +
            ': ' +
            key +
            ' ' +
            previous +
            ' was already chosen for another requirement',
          1,
        )
      continue
    }
    const module = key.replace(/-/g, '_')
    if (modules.builtin.has(module) || modules.frozen.has(module)) {
      say(
        'Requirement already satisfied: ' +
          requirement.name +
          ' (python.wasm carries the module ' +
          module +
          ')',
      )
      chosen.set(key, '')
      continue
    }
    const have = present.get(key)
    if (have && satisfies(have.version, requirement.specs) && !(top && flags.upgrade)) {
      say(
        'Requirement already satisfied: ' +
          have.name +
          ' in ' +
          sitePackages +
          ' (' +
          have.version +
          ')',
      )
      chosen.set(key, have.version)
      if (flags.deps)
        for (const next of dependencies(have.requires, requirement.extras))
          queue.push({ requirement: next, top: false })
      continue
    }
    say('Collecting ' + spelled(requirement))
    const response = await fetch(index + encodeURIComponent(key) + '/json', { signal: ctx.signal })
    if (response.status === 404)
      throw new CommandError(
        'No matching distribution found for ' + requirement.name + ' (not on PyPI)',
        1,
      )
    if (!response.ok)
      throw new CommandError('could not read ' + index + key + '/json: HTTP ' + response.status, 1)
    const project = (await response.json()) as Project
    const candidates = Object.entries(project.releases)
      .map(([text, files]) => ({
        text,
        version: parseVersion(text),
        files: files.filter((file) => !file.yanked),
      }))
      .filter(
        (entry): entry is { text: string; version: Version; files: ReleaseFile[] } =>
          entry.version !== undefined &&
          entry.files.length > 0 &&
          satisfies(entry.text, requirement.specs),
      )
      .sort((a, b) => compare(b.version, a.version))
    const stable = candidates.filter((entry) => !prerelease(entry.version))
    const pick = (flags.pre || !stable.length ? candidates : stable)[0]
    if (!pick)
      throw new CommandError('No matching distribution found for ' + spelled(requirement), 1)
    const wheels = pick.files.filter(
      (file) => file.packagetype === 'bdist_wheel' && fits(file.requires_python),
    )
    const wheel =
      wheels.find((file) => pure(file.filename)) ??
      wheels
        .filter((file) => platform(file.filename) >= 0)
        .sort((a, b) => platform(b.filename) - platform(a.filename))[0]
    if (!wheel) {
      const kinds = [
        ...new Set(
          pick.files.map((file) =>
            file.packagetype === 'sdist' ? 'a source distribution' : tags(file.filename).join('-'),
          ),
        ),
      ]
      throw new CommandError(
        project.info.name +
          ' ' +
          pick.text +
          ' has no pure-Python (py3-none-any) or CPython 3 x86_64 Linux wheel for Python 3.14, only ' +
          kinds.slice(0, 5).join(', ') +
          (kinds.length > 5 ? ' and ' + (kinds.length - 5) + ' more' : '') +
          ". nanocode's Python cannot build source distributions or load compiled wheels; the compiled modules it ships are " +
          shippedModules.join(', '),
        1,
      )
    }
    chosen.set(key, pick.text)
    say('Downloading ' + wheel.filename + ' (' + size(wheel.size) + ')')
    const download = await fetch(wheel.url, { signal: ctx.signal })
    if (!download.ok)
      throw new CommandError('could not download ' + wheel.url + ': HTTP ' + download.status, 1)
    const data = new Uint8Array(await download.arrayBuffer())
    const { entries } = readEntries(data)
    const absent = entries
      .filter((entry) => binary(entry.name) && !/^[^/]+\.libs\//.test(entry.name))
      .map((entry) => compiledModule(entry.name) ?? entry.name)
      .filter((name) => !modules.builtin.has(name))
    if (absent.length)
      throw new CommandError(
        wheel.filename +
          " has compiled modules nanocode's Python does not carry: " +
          absent.join(', ') +
          '; the compiled modules it carries come from ' +
          shippedModules.join(', '),
        1,
      )
    const info = entries.find((entry) => /^[^/]+\.dist-info\/METADATA$/.test(entry.name))
    if (!info) throw new CommandError(wheel.filename + ' has no .dist-info/METADATA', 1)
    const metadata = decode(await contents(data, info))
    if (have) {
      say('Uninstalling ' + have.name + '-' + have.version)
      await remove(ctx.fs, have)
    }
    const left: string[] = []
    for (const entry of entries) {
      if (entry.directory || unsafe(entry.name) || binary(entry.name)) continue
      const scheme = /^[^/]+\.data\/([^/]+)\/(.+)$/.exec(entry.name)
      if (scheme && scheme[1] !== 'purelib' && scheme[1] !== 'platlib') {
        left.push(entry.name)
        continue
      }
      const path = sitePackages + '/' + (scheme ? scheme[2] : entry.name)
      await mkdirs(ctx.fs, parentOf(path))
      await ctx.fs.write(path, await contents(data, entry))
    }
    const dist = sitePackages + '/' + info.name.slice(0, info.name.indexOf('/'))
    await ctx.fs.write(dist + '/INSTALLER', encode('nanocode\n'))
    if (top) await ctx.fs.write(dist + '/REQUESTED', new Uint8Array())
    if (left.length)
      ctx.stderr.write(
        'pip: ' +
          project.info.name +
          ': did not install ' +
          left.join(', ') +
          ' (only importable files go into site-packages)\n',
      )
    done.push(project.info.name + '-' + pick.text)
    if (flags.deps)
      for (const next of dependencies(fields(metadata, 'Requires-Dist'), requirement.extras))
        queue.push({ requirement: next, top: false })
  }
  if (done.length) say('Successfully installed ' + done.join(' '))
  return 0
}

async function requirementsFile(ctx: CommandContext, path: string | undefined): Promise<string[]> {
  if (path === undefined) throw new CommandError('-r needs a requirements file', 2)
  return decode(await ctx.fs.read(ctx.resolve(path)))
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
    .filter(Boolean)
}

const usage =
  'Usage: pip install [-U] [--no-deps] [--pre] [-q] [-r FILE] PACKAGE...\n       pip uninstall [-y] PACKAGE...\n       pip list | pip freeze | pip show PACKAGE...\n'

export async function pip(ctx: CommandContext, args: string[]): Promise<number> {
  const [command, ...rest] = args
  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    ctx.stdout.write(
      usage +
        'Installs pure-Python (py3-none-any) wheels from PyPI into ' +
        sitePackages +
        "; nanocode's Python ships the compiled modules " +
        shippedModules.join(', ') +
        '\n',
    )
    return 0
  }
  if (command === '-V' || command === '--version') {
    ctx.stdout.write(
      'pip (nanocode, pure-Python wheels only) from ' + sitePackages + ' (python 3.14)\n',
    )
    return 0
  }
  if (command === 'install') {
    const flags: Flags = { quiet: false, upgrade: false, deps: true, pre: false }
    const specs: string[] = []
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]
      if (arg === '-q' || arg === '--quiet') flags.quiet = true
      else if (arg === '-U' || arg === '--upgrade') flags.upgrade = true
      else if (arg === '--no-deps') flags.deps = false
      else if (arg === '--pre') flags.pre = true
      else if (arg === '-r' || arg === '--requirement')
        specs.push(...(await requirementsFile(ctx, rest[++i])))
      else if (
        [
          '--user',
          '--break-system-packages',
          '--no-cache-dir',
          '--disable-pip-version-check',
        ].includes(arg)
      )
        continue
      else if (arg.startsWith('-'))
        throw new CommandError('install: unsupported option ' + arg + '\n' + usage, 2)
      else specs.push(arg)
    }
    if (!specs.length)
      throw new CommandError('You must give at least one requirement to install', 1)
    return install(ctx, specs.map(parseRequirement), flags)
  }
  if (command === 'uninstall') {
    const present = await installed(ctx.fs)
    for (const name of rest.filter((arg) => arg !== '-y' && arg !== '--yes')) {
      const found = present.get(normalize(name))
      if (!found) {
        ctx.stderr.write('WARNING: Skipping ' + name + ' as it is not installed' + '.\n')
        continue
      }
      await remove(ctx.fs, found)
      ctx.stdout.write('Successfully uninstalled ' + found.name + '-' + found.version + '\n')
    }
    return 0
  }
  if (command === 'list' || command === 'freeze') {
    const present = [...(await installed(ctx.fs)).values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    if (command === 'list') ctx.stdout.write('Package Version\n------- -------\n')
    for (const found of present)
      ctx.stdout.write(found.name + (command === 'list' ? ' ' : '==') + found.version + '\n')
    return 0
  }
  if (command === 'show') {
    const present = await installed(ctx.fs)
    let status = 0
    for (const name of rest) {
      const found = present.get(normalize(name))
      if (!found) {
        ctx.stderr.write('WARNING: Package(s) not found: ' + name + '\n')
        status = 1
        continue
      }
      ctx.stdout.write(
        'Name: ' +
          found.name +
          '\nVersion: ' +
          found.version +
          '\nLocation: ' +
          sitePackages +
          '\nRequires: ' +
          found.requires.map((text) => parseRequirement(text).name).join(', ') +
          '\n',
      )
    }
    return status
  }
  throw new CommandError('unknown command "' + command + '"\n' + usage, 1)
}
