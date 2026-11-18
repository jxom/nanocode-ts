import { CommandError, type CommandContext } from '../Shell.ts'
import { FsError, type FileSystem } from '../../FileSystem.ts'
import { decode, encode, parentOf } from '../Fs.ts'
import { untar } from './archive.ts'
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
  pandas: 'pandas',
  pillow: 'PIL',
  pyyaml: 'yaml',
  regex: 'regex',
  ujson: 'ujson',
}

export const shippedModules = Object.values(shipped)

const alternatives: Record<string, string> = {
  cryptography:
    'hashlib, hmac and secrets for hashes, MACs and keys; pip install pyaes or rsa for pure-Python ciphers',
  lxml: "BeautifulSoup(text, 'html.parser') from beautifulsoup4, or xml.etree.ElementTree",
  orjson: 'json, ujson (built in) or pip install simplejson',
  polars: 'pandas (built in)',
  pyarrow: 'pandas (built in) with CSV or JSON files',
  'scikit-learn': 'numpy (built in) for the linear algebra, such as numpy.linalg.lstsq',
  scipy:
    'numpy (built in): numpy.linalg, numpy.fft, numpy.polynomial and numpy.random; pip install sympy or mpmath for symbolic and special functions',
  statsmodels: 'numpy and pandas (built in), such as numpy.linalg.lstsq for a regression',
}

const carriedDists: Record<string, [string, string, string]> = {
  contourpy: ['contourpy', 'contourpy', '1.4.0'],
  cycler: ['cycler', 'cycler', '0.12.1'],
  fonttools: ['fonttools', 'fontTools', '4.68.0'],
  kiwisolver: ['kiwisolver', 'kiwisolver', '1.5.1'],
  markupsafe: ['MarkupSafe', 'markupsafe', '3.0.4'],
  matplotlib: ['matplotlib', 'matplotlib', '3.11.2'],
  msgpack: ['msgpack', 'msgpack', '1.2.4'],
  numpy: ['numpy', 'numpy', '2.5.5'],
  packaging: ['packaging', 'packaging', '26.3'],
  pandas: ['pandas', 'pandas', '3.1.1'],
  pillow: ['pillow', 'PIL', '13.0.0'],
  pyparsing: ['pyparsing', 'pyparsing', '3.3.3'],
  pysha3: ['pysha3', 'sha3', '1.0.2'],
  'python-dateutil': ['python-dateutil', 'dateutil', '4.0.0'],
  pyyaml: ['PyYAML', 'yaml', '6.0.3'],
  regex: ['regex', 'regex', '2026.11.9'],
  six: ['six', 'six', '1.17.0'],
  ujson: ['ujson', 'ujson', '6.1.0'],
}

const optionalCompiled = new Set([
  'aiohttp',
  'charset-normalizer',
  'frozenlist',
  'multidict',
  'propcache',
  'pyrsistent',
  'simplejson',
  'sqlalchemy',
  'tornado',
  'wrapt',
  'yarl',
  'websockets',
  'greenlet',
  'coverage',
  'pyzmq',
  'markdown-it-py',
  'rapidfuzz',
  'immutables',
  'ruamel-yaml-clib',
  'zope-interface',
  'msgspec',
  'cytoolz',
  'bitarray',
  'pycryptodome',
])

const downgrades: Record<string, [string, string]> = {
  pydantic: [
    '<2',
    "pydantic 2 needs the compiled pydantic-core, which nanocode's Python does not carry, so pip installed pydantic 1.x (the v1 API)",
  ],
}

const orjsonShim = String.raw`import json as _json
import datetime as _dt
import enum as _enum
import uuid as _uuid
import dataclasses as _dc

__version__ = '3.11.0'
OPT_INDENT_2 = 1
OPT_NAIVE_UTC = 2
OPT_NON_STR_KEYS = 4
OPT_OMIT_MICROSECONDS = 8
OPT_SERIALIZE_NUMPY = 16
OPT_SORT_KEYS = 32
OPT_STRICT_INTEGER = 64
OPT_UTC_Z = 128
OPT_PASSTHROUGH_SUBCLASS = 256
OPT_PASSTHROUGH_DATETIME = 512
OPT_APPEND_NEWLINE = 1024
OPT_PASSTHROUGH_DATACLASS = 2048
OPT_SERIALIZE_DATACLASS = 0
OPT_SERIALIZE_UUID = 0


class JSONDecodeError(_json.JSONDecodeError):
    pass


class JSONEncodeError(TypeError):
    pass


class Fragment:
    def __init__(self, contents):
        self.contents = contents


def _time(value, option):
    if option & OPT_OMIT_MICROSECONDS and isinstance(value, (_dt.datetime, _dt.time)):
        value = value.replace(microsecond=0)
    if option & OPT_NAIVE_UTC and isinstance(value, _dt.datetime) and value.tzinfo is None:
        value = value.replace(tzinfo=_dt.timezone.utc)
    text = value.isoformat()
    if option & OPT_UTC_Z and text.endswith('+00:00'):
        text = text[:-6] + 'Z'
    return text


def _keys(value):
    if isinstance(value, dict):
        return {(k if isinstance(k, str) else _time(k, 0) if isinstance(k, (_dt.date, _dt.time)) else str(k)): _keys(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_keys(v) for v in value]
    return value


def dumps(obj, default=None, option=None):
    option = option or 0

    def encode(value):
        if isinstance(value, (_dt.datetime, _dt.date, _dt.time)):
            return _time(value, option)
        if isinstance(value, _uuid.UUID):
            return str(value)
        if isinstance(value, _enum.Enum):
            return value.value
        if isinstance(value, Fragment):
            return _json.loads(value.contents)
        if _dc.is_dataclass(value) and not isinstance(value, type):
            return _dc.asdict(value)
        if hasattr(value, 'tolist'):
            return value.tolist()
        if default is not None:
            return default(value)
        raise JSONEncodeError('Type is not JSON serializable: ' + type(value).__name__)

    if option & OPT_NON_STR_KEYS:
        obj = _keys(obj)
    try:
        text = _json.dumps(
            obj,
            default=encode,
            ensure_ascii=False,
            indent=2 if option & OPT_INDENT_2 else None,
            separators=(',', ': ') if option & OPT_INDENT_2 else (',', ':'),
            sort_keys=bool(option & OPT_SORT_KEYS),
        )
    except (TypeError, ValueError) as error:
        raise JSONEncodeError(str(error)) from None
    text = text.replace('NaN', 'null').replace('-Infinity', 'null').replace('Infinity', 'null') if 'N' in text or 'I' in text else text
    if option & OPT_APPEND_NEWLINE:
        text += '\n'
    return text.encode('utf-8')


def loads(obj):
    if isinstance(obj, (bytes, bytearray, memoryview)):
        obj = bytes(obj).decode('utf-8')
    try:
        return _json.loads(obj)
    except _json.JSONDecodeError as error:
        raise JSONDecodeError(error.msg, error.doc, error.pos) from None
`

const rpdsShim = String.raw`__version__ = '0.30.0'
__all__ = ['HashTrieMap', 'HashTrieSet', 'List', 'Queue']


class HashTrieMap:
    __slots__ = ('_d',)

    def __init__(self, value=None, **kwargs):
        d = dict(value._d if isinstance(value, HashTrieMap) else value or {})
        d.update(kwargs)
        self._d = d

    @classmethod
    def convert(cls, value):
        return value if isinstance(value, cls) else cls(value)

    @classmethod
    def fromkeys(cls, keys, value=None):
        return cls(dict.fromkeys(keys, value))

    def insert(self, key, value):
        d = dict(self._d)
        d[key] = value
        return HashTrieMap(d)

    def remove(self, key):
        if key not in self._d:
            raise KeyError(key)
        return self.discard(key)

    def discard(self, key):
        d = dict(self._d)
        d.pop(key, None)
        return HashTrieMap(d)

    def update(self, *maps, **kwargs):
        d = dict(self._d)
        for m in maps:
            d.update(m._d if isinstance(m, HashTrieMap) else m)
        d.update(kwargs)
        return HashTrieMap(d)

    def get(self, key, default=None):
        return self._d.get(key, default)

    def keys(self):
        return self._d.keys()

    def values(self):
        return self._d.values()

    def items(self):
        return self._d.items()

    def __getitem__(self, key):
        return self._d[key]

    def __contains__(self, key):
        return key in self._d

    def __iter__(self):
        return iter(self._d)

    def __len__(self):
        return len(self._d)

    def __eq__(self, other):
        if isinstance(other, HashTrieMap):
            return self._d == other._d
        if isinstance(other, dict):
            return self._d == other
        return NotImplemented

    def __hash__(self):
        return hash(frozenset(self._d.items()))

    def __repr__(self):
        return 'HashTrieMap(' + repr(self._d) + ')'

    def __reduce__(self):
        return (HashTrieMap, (self._d,))


class HashTrieSet:
    __slots__ = ('_s',)

    def __init__(self, value=()):
        self._s = frozenset(value._s if isinstance(value, HashTrieSet) else value)

    @classmethod
    def convert(cls, value):
        return value if isinstance(value, cls) else cls(value)

    def insert(self, value):
        return HashTrieSet(self._s | {value})

    def discard(self, value):
        return HashTrieSet(self._s - {value})

    def remove(self, value):
        if value not in self._s:
            raise KeyError(value)
        return self.discard(value)

    def update(self, *iterables):
        s = set(self._s)
        for it in iterables:
            s.update(it)
        return HashTrieSet(s)

    def union(self, other):
        return HashTrieSet(self._s | frozenset(other))

    def intersection(self, other):
        return HashTrieSet(self._s & frozenset(other))

    def difference(self, other):
        return HashTrieSet(self._s - frozenset(other))

    def symmetric_difference(self, other):
        return HashTrieSet(self._s ^ frozenset(other))

    __or__ = union
    __and__ = intersection
    __sub__ = difference
    __xor__ = symmetric_difference

    def __contains__(self, value):
        return value in self._s

    def __iter__(self):
        return iter(self._s)

    def __len__(self):
        return len(self._s)

    def __eq__(self, other):
        if isinstance(other, HashTrieSet):
            return self._s == other._s
        if isinstance(other, (set, frozenset)):
            return self._s == other
        return NotImplemented

    def __hash__(self):
        return hash(self._s)

    def __repr__(self):
        return 'HashTrieSet({' + ', '.join(map(repr, self._s)) + '})'


class List:
    __slots__ = ('_t',)

    def __init__(self, *values):
        if len(values) == 1 and not isinstance(values[0], (str, bytes)) and hasattr(values[0], '__iter__'):
            values = values[0]
        self._t = tuple(values)

    @property
    def first(self):
        if not self._t:
            raise IndexError('empty list has no first element')
        return self._t[0]

    @property
    def rest(self):
        return List(self._t[1:])

    def push_front(self, value):
        return List((value,) + self._t)

    def drop_first(self):
        if not self._t:
            raise IndexError('empty list has no first element')
        return List(self._t[1:])

    def __iter__(self):
        return iter(self._t)

    def __reversed__(self):
        return List(self._t[::-1])

    def __len__(self):
        return len(self._t)

    def __eq__(self, other):
        return isinstance(other, List) and self._t == other._t

    def __hash__(self):
        return hash(self._t)

    def __repr__(self):
        return 'List([' + ', '.join(map(repr, self._t)) + '])'


class Queue:
    __slots__ = ('_t',)

    def __init__(self, *values):
        if len(values) == 1 and hasattr(values[0], '__iter__'):
            values = values[0]
        self._t = tuple(values)

    def enqueue(self, value):
        return Queue(self._t + (value,))

    def dequeue(self):
        if not self._t:
            raise IndexError('dequeued an empty queue')
        return Queue(self._t[1:])

    @property
    def peek(self):
        if not self._t:
            raise IndexError('peeked at an empty queue')
        return self._t[0]

    @property
    def is_empty(self):
        return not self._t

    def __iter__(self):
        return iter(self._t)

    def __len__(self):
        return len(self._t)

    def __eq__(self, other):
        return isinstance(other, Queue) and self._t == other._t

    def __repr__(self):
        return 'Queue([' + ', '.join(map(repr, self._t)) + '])'
`

const shims: Record<string, { files: Record<string, string>; note: string }> = {
  orjson: {
    files: { 'orjson/__init__.py': orjsonShim },
    note: 'a pure-Python orjson over the json module (same dumps/loads API, slower)',
  },
  'rpds-py': {
    files: { 'rpds/__init__.py': rpdsShim },
    note: 'a pure-Python rpds (HashTrieMap, HashTrieSet, List, Queue over dict, frozenset and tuple)',
  },
}
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

type Carried = {
  builtin: Set<string>
  frozen: Set<string>
  dists: Map<string, [string, string, string]>
}

const carriedCache = new WeakMap<object, Carried>()

async function carried(ctx: CommandContext): Promise<Carried> {
  const names = Object.values(carriedDists).map(([, module]) => module)
  const ran = await ctx.exec(
    'python3 -c \'import sys, _imp, importlib.util as u\nprint(*sys.builtin_module_names)\nprint(*_imp._frozen_module_names())\nfor n in sys.argv[1:]:\n    s = u.find_spec(n)\n    print(n if s is not None and s.origin in ("frozen", "built-in") else "", end=" ")\nprint()\' ' +
      names.join(' '),
  )
  const [builtin, frozen, found] = ran.stdout.split('\n')
  if (ran.status !== 0 || found === undefined)
    throw new CommandError("could not list python3's built-in modules", 1)
  const present = new Set(found.trim().split(/\s+/))
  return {
    builtin: new Set(builtin.trim().split(/\s+/)),
    frozen: new Set(frozen.trim().split(/\s+/)),
    dists: new Map(Object.entries(carriedDists).filter(([, [, module]]) => present.has(module))),
  }
}

async function carriedOnce(ctx: CommandContext): Promise<Carried> {
  const known = carriedCache.get(ctx.fs)
  if (known) return known
  const found = await carried(ctx)
  carriedCache.set(ctx.fs, found)
  return found
}

const downloads = new Map<string, Uint8Array>()

let downloadBytes = 0

const projects = new Map<string, Project>()

async function download(ctx: CommandContext, url: string): Promise<Uint8Array> {
  const cached = downloads.get(url)
  if (cached) return cached
  const response = await ctx.fetch!(url, { signal: ctx.signal })
  if (!response.ok)
    throw new CommandError('could not download ' + url + ': HTTP ' + response.status, 1)
  const data = new Uint8Array(await response.arrayBuffer())
  if (data.length <= 16 * 1024 * 1024) {
    while (downloadBytes + data.length > 64 * 1024 * 1024 && downloads.size) {
      const [first, bytes] = downloads.entries().next().value!
      downloads.delete(first)
      downloadBytes -= bytes.length
    }
    downloads.set(url, data)
    downloadBytes += data.length
  }
  return data
}

async function project(
  ctx: CommandContext,
  key: string,
  requirement: Requirement,
): Promise<Project> {
  const cached = projects.get(key)
  if (cached) return cached
  const response = await ctx.fetch!(index + encodeURIComponent(key) + '/json', {
    signal: ctx.signal,
  })
  if (response.status === 404)
    throw new CommandError(
      'No matching distribution found for ' + requirement.name + ' (not on PyPI)',
      1,
    )
  if (!response.ok)
    throw new CommandError('could not read ' + index + key + '/json: HTTP ' + response.status, 1)
  const read = (await response.json()) as Project
  const slim: Project = { info: { name: read.info.name }, releases: {} }
  for (const [version, files] of Object.entries(read.releases))
    slim.releases[version] = files.map((file) => ({
      filename: file.filename,
      url: file.url,
      size: file.size,
      yanked: file.yanked,
      packagetype: file.packagetype,
      requires_python: file.requires_python,
    }))
  if (projects.size >= 200) projects.delete(projects.keys().next().value!)
  projects.set(key, slim)
  return slim
}

type Unit = {
  files: Map<string, Uint8Array>
  metadata: string
  distInfo: string
  skipped: string[]
  note?: string
}

function metadataText(name: string, version: string, requires: string[], summary = ''): string {
  return (
    'Metadata-Version: 2.1\nName: ' +
    name +
    '\nVersion: ' +
    version +
    '\n' +
    (summary ? 'Summary: ' + summary + '\n' : '') +
    requires.map((text) => 'Requires-Dist: ' + text + '\n').join('') +
    '\n'
  )
}

function distName(name: string): string {
  return name.replace(/[-_.]+/g, '_')
}

async function fromWheel(
  data: Uint8Array,
  filename: string,
  modules: Carried,
  key: string,
  force: boolean,
): Promise<Unit> {
  const { entries } = readEntries(data)
  const absent = entries
    .filter((entry) => binary(entry.name) && !/^[^/]+\.libs\//.test(entry.name))
    .map((entry) => compiledModule(entry.name) ?? entry.name)
    .filter((name) => !modules.builtin.has(name))
  if (absent.length && !force && !optionalCompiled.has(key) && !absent.every(speedup))
    throw new Compiled(filename, absent)
  const info = entries.find((entry) => /^[^/]+\.dist-info\/METADATA$/.test(entry.name))
  if (!info) throw new CommandError(filename + ' has no .dist-info/METADATA', 1)
  const files = new Map<string, Uint8Array>()
  const skipped: string[] = []
  for (const entry of entries) {
    if (entry.directory || unsafe(entry.name) || binary(entry.name)) continue
    if (entry.name.endsWith('.dist-info/RECORD')) continue
    const scheme = /^[^/]+\.data\/([^/]+)\/(.+)$/.exec(entry.name)
    if (scheme && scheme[1] !== 'purelib' && scheme[1] !== 'platlib') {
      skipped.push(entry.name)
      continue
    }
    files.set(scheme ? scheme[2] : entry.name, await contents(data, entry))
  }
  return {
    files,
    metadata: decode(files.get(info.name)!),
    distInfo: info.name.slice(0, info.name.indexOf('/')),
    skipped,
    note: absent.length
      ? 'left out compiled modules ' +
        absent.join(', ') +
        ' (python.wasm runs their pure-Python fallback)'
      : undefined,
  }
}

function speedup(name: string): boolean {
  return /(^|[._])(speedups?|_?cext|cextension|cyextension|_c|_cy|_accel|_native)(\.|$)|speedups/i.test(
    name,
  )
}

class Compiled extends Error {
  readonly modules: string[]
  constructor(filename: string, modules: string[]) {
    super(filename)
    this.modules = modules
  }
}

const sourceExtensions = /\.(c|cc|cpp|cxx|h|hpp|pyx|pxd|rs|f|f90|go|zig)$/i

function dependenciesFrom(files: Map<string, string>): string[] {
  const pyproject = files.get('pyproject.toml')
  if (pyproject) {
    const block = /^\s*\[project\]([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m.exec(pyproject)?.[1] ?? ''
    const deps = /^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(block)?.[1]
    if (deps) return [...deps.matchAll(/["']([^"']+)["']/g)].map((match) => match[1])
    const poetry = /^\s*\[tool\.poetry\.dependencies\]([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m.exec(
      pyproject,
    )?.[1]
    if (poetry)
      return [...poetry.matchAll(/^\s*([A-Za-z0-9][\w.-]*)\s*=/gm)]
        .map((match) => match[1])
        .filter((name) => name.toLowerCase() !== 'python')
  }
  for (const name of ['setup.cfg', 'setup.py']) {
    const text = files.get(name)
    if (!text) continue
    const cfg = /install_requires\s*=\s*\n((?:[ \t]+\S.*\n?)+)/.exec(text)?.[1]
    if (cfg)
      return cfg
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
    const list = /install_requires\s*=\s*\[([\s\S]*?)\]/.exec(text)?.[1]
    if (list) return [...list.matchAll(/["']([^"']+)["']/g)].map((match) => match[1])
  }
  return []
}

function sourceUnit(
  all: Map<string, Uint8Array>,
  fallbackName: string,
  fallbackVersion: string,
): Unit {
  const text = (path: string) => {
    const data = all.get(path)
    return data ? decode(data) : undefined
  }
  const top = new Map<string, string>()
  for (const name of ['pyproject.toml', 'setup.cfg', 'setup.py', 'PKG-INFO']) {
    const value = text(name)
    if (value !== undefined) top.set(name, value)
  }
  const pkgInfo = top.get('PKG-INFO')
  const pyproject = top.get('pyproject.toml') ?? ''
  const name =
    (pkgInfo && fields(pkgInfo, 'Name')[0]) ||
    /^\s*name\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1] ||
    /name\s*=\s*["']([^"']+)["']/.exec(top.get('setup.py') ?? top.get('setup.cfg') ?? '')?.[1] ||
    fallbackName
  const version =
    (pkgInfo && fields(pkgInfo, 'Version')[0]) ||
    /^\s*version\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1] ||
    fallbackVersion
  const requires =
    pkgInfo && fields(pkgInfo, 'Requires-Dist').length
      ? fields(pkgInfo, 'Requires-Dist')
      : dependenciesFrom(top)
  const paths = [...all.keys()]
  const native = paths.filter(
    (path) =>
      sourceExtensions.test(path) &&
      !/(^|\/)(tests?|docs?|examples?|benchmarks?|bench)\//.test(path),
  )
  const roots = new Set<string>()
  const base = paths.some(
    (path) => /^src\/[^/]+\/__init__\.py$/.test(path) || /^src\/[^/]+\.py$/.test(path),
  )
    ? 'src/'
    : ''
  for (const path of paths) {
    if (!path.startsWith(base)) continue
    const rest = path.slice(base.length)
    const pkg = /^([A-Za-z_]\w*)\/__init__\.py$/.exec(rest)
    if (pkg && !/^(tests?|docs?|examples?|benchmarks?|build|dist|scripts|tools)$/.test(pkg[1]))
      roots.add(pkg[1] + '/')
    const mod = /^([A-Za-z_]\w*)\.py$/.exec(rest)
    if (mod && !/^(setup|conftest|noxfile|tasks|fabfile|test_.*|.*_test)$/.test(mod[1]))
      roots.add(mod[1] + '.py')
  }
  if (!roots.size) {
    const dirName = distName(name).toLowerCase()
    for (const path of paths) {
      const rest = path.slice(base.length)
      if (
        path.startsWith(base) &&
        rest.toLowerCase().startsWith(dirName + '/') &&
        rest.endsWith('.py')
      )
        roots.add(rest.slice(0, rest.indexOf('/') + 1))
    }
  }
  if (!roots.size)
    throw new CommandError(
      'cannot find a Python package to install in the source of ' + name + ' ' + version,
      1,
    )
  const files = new Map<string, Uint8Array>()
  for (const [path, data] of all) {
    if (!path.startsWith(base)) continue
    const rest = path.slice(base.length)
    if (
      [...roots].some((root) => (root.endsWith('/') ? rest.startsWith(root) : rest === root)) &&
      !sourceExtensions.test(rest)
    )
      files.set(rest, data)
  }
  const distInfo = distName(name) + '-' + version + '.dist-info'
  files.set(distInfo + '/METADATA', encode(metadataText(name, version, requires)))
  return {
    files,
    metadata: metadataText(name, version, requires),
    distInfo,
    skipped: [],
    note: native.length
      ? 'built from source without its compiled parts (' +
        native.slice(0, 3).join(', ') +
        (native.length > 3 ? ', ...' : '') +
        '); they work only if the package has a pure-Python fallback'
      : undefined,
  }
}

async function fromSdist(
  data: Uint8Array,
  filename: string,
  fallbackName: string,
  fallbackVersion: string,
): Promise<Unit> {
  const all = new Map<string, Uint8Array>()
  if (/\.zip$/i.test(filename)) {
    const { entries } = readEntries(data)
    for (const entry of entries)
      if (!entry.directory && !unsafe(entry.name)) all.set(entry.name, await contents(data, entry))
  } else {
    for await (const entry of untar(data, 64 * 1024 * 1024))
      if (entry.type === 'file' && !unsafe(entry.name))
        all.set(entry.name.replace(/^\.\//, ''), entry.data)
  }
  const firsts = new Set([...all.keys()].map((path) => path.split('/')[0]))
  const strip =
    firsts.size === 1 && [...all.keys()].every((path) => path.includes('/'))
      ? [...firsts][0] + '/'
      : ''
  const tree = new Map<string, Uint8Array>()
  for (const [path, bytes] of all) tree.set(path.slice(strip.length), bytes)
  return sourceUnit(tree, fallbackName, fallbackVersion)
}

async function fromDirectory(fs: FileSystem, dir: string): Promise<Unit> {
  const all = new Map<string, Uint8Array>()
  const walk = async (path: string, rel: string): Promise<void> => {
    for (const name of await fs.list(path)) {
      if (rel === '' && /^(\.git|\.venv|venv|node_modules|build|dist|__pycache__)$/.test(name))
        continue
      if (name === '__pycache__') continue
      const full = path + '/' + name
      const stat = await fs.stat(full)
      if (stat?.kind === 'directory') await walk(full, rel + name + '/')
      else if (stat?.kind === 'file') all.set(rel + name, await fs.read(full))
    }
  }
  await walk(dir, '')
  return sourceUnit(all, dir.split('/').pop() || 'project', '0.0.0')
}

async function place(ctx: CommandContext, unit: Unit, top: boolean): Promise<void> {
  const record: string[] = []
  for (const [path, data] of unit.files) {
    const full = sitePackages + '/' + path
    await mkdirs(ctx.fs, parentOf(full))
    await ctx.fs.write(full, data)
    record.push(path + ',,')
  }
  const dist = sitePackages + '/' + unit.distInfo
  await mkdirs(ctx.fs, dist)
  if (!unit.files.has(unit.distInfo + '/METADATA'))
    await ctx.fs.write(dist + '/METADATA', encode(unit.metadata))
  await ctx.fs.write(dist + '/INSTALLER', encode('nanocode\n'))
  if (top) await ctx.fs.write(dist + '/REQUESTED', new Uint8Array())
  record.push(unit.distInfo + '/INSTALLER,,', unit.distInfo + '/RECORD,,')
  await ctx.fs.write(dist + '/RECORD', encode(record.join('\n') + '\n'))
}

async function stubCarried(
  ctx: CommandContext,
  modules: Carried,
  present: Map<string, Installed>,
): Promise<void> {
  for (const [key, [name, , version]] of modules.dists) {
    if (present.has(key)) continue
    const dist = sitePackages + '/' + distName(name) + '-' + version + '.dist-info'
    await mkdirs(ctx.fs, dist)
    await ctx.fs.write(
      dist + '/METADATA',
      encode(metadataText(name, version, [], 'built into python.wasm')),
    )
    await ctx.fs.write(dist + '/INSTALLER', encode('python.wasm\n'))
    await ctx.fs.write(dist + '/RECORD', encode(''))
  }
}

type Source =
  | { kind: 'wheel' | 'sdist'; data: Uint8Array; filename: string }
  | { kind: 'dir'; path: string }

async function local(ctx: CommandContext, spec: string): Promise<Source | undefined> {
  const url = /^(?:[A-Za-z0-9._-]+(?:\[[^\]]*\])?\s*@\s*)?((?:https?|file):\/\/\S+)$/.exec(
    spec.trim(),
  )?.[1]
  if (url) {
    const clean = url.replace(/#.*$/, '')
    const filename = decodeURIComponent(clean.split('/').pop() ?? '')
    if (clean.startsWith('file://')) return local(ctx, clean.slice(7))
    if (spec.startsWith('git+'))
      throw new CommandError(
        'cannot install ' +
          spec +
          ': pip here installs from PyPI, wheel or sdist URLs and local paths, not git',
        1,
      )
    const data = await download(ctx, clean)
    return { kind: /\.whl$/i.test(filename) ? 'wheel' : 'sdist', data, filename }
  }
  if (spec.startsWith('git+'))
    throw new CommandError(
      'cannot install ' +
        spec +
        ': git URLs are not supported; use a PyPI name, a wheel or sdist URL, or git clone then pip install ./dir',
      1,
    )
  if (!/^(\.|\/|~)/.test(spec) && !/\.(whl|tar\.gz|tgz|zip)$/i.test(spec)) return undefined
  const path = ctx.resolve(spec.replace(/\[[^\]]*\]$/, ''))
  const stat = await ctx.fs.stat(path)
  if (!stat)
    throw new CommandError('Invalid requirement: ' + spec + ': no such file or directory', 1)
  if (stat.kind === 'directory') return { kind: 'dir', path }
  const filename = path.split('/').pop()!
  return {
    kind: /\.whl$/i.test(filename) ? 'wheel' : 'sdist',
    data: await ctx.fs.read(path),
    filename,
  }
}

async function install(ctx: CommandContext, wanted: string[], flags: Flags): Promise<number> {
  const fetch = ctx.fetch
  const say = (text: string) => {
    if (!flags.quiet) ctx.stdout.write(text + '\n')
  }
  const warn = (text: string) => ctx.stderr.write('WARNING: ' + text + '\n')
  const present = await installed(ctx.fs)
  const modules = await carriedOnce(ctx)
  await stubCarried(ctx, modules, present)
  const queue: { requirement: Requirement; top: boolean }[] = []
  const done: string[] = []
  for (const spec of wanted) {
    const source = await local(ctx, spec)
    if (!source) {
      queue.push({ requirement: parseRequirement(spec), top: true })
      continue
    }
    const extras =
      /\[([^\]]*)\]\s*$/
        .exec(spec)?.[1]
        ?.split(',')
        .map((extra) => normalize(extra.trim()))
        .filter(Boolean) ?? []
    const unit =
      source.kind === 'dir'
        ? await fromDirectory(ctx.fs, source.path)
        : source.kind === 'wheel'
          ? await fromWheel(source.data, source.filename, modules, '', true)
          : await fromSdist(
              source.data,
              source.filename,
              source.filename.replace(/-[^-]*$/, ''),
              '0.0.0',
            )
    const name = fields(unit.metadata, 'Name')[0] ?? unit.distInfo
    const version = fields(unit.metadata, 'Version')[0] ?? ''
    const have = present.get(normalize(name))
    if (have) await remove(ctx.fs, have)
    await place(ctx, unit, true)
    if (unit.note) warn(name + ': ' + unit.note)
    present.set(normalize(name), {
      name,
      version,
      dir: sitePackages + '/' + unit.distInfo,
      requires: fields(unit.metadata, 'Requires-Dist'),
    })
    done.push(name + '-' + version)
    if (flags.deps)
      for (const next of dependencies(fields(unit.metadata, 'Requires-Dist'), extras))
        queue.push({ requirement: next, top: false })
  }
  const chosen = new Map<string, string>()
  for (let item = queue.shift(); item; item = queue.shift()) {
    const { top } = item
    let requirement = item.requirement
    if (!evaluate(requirement.marker, [])) continue
    const key = normalize(requirement.name)
    const previous = chosen.get(key)
    if (previous !== undefined) {
      if (previous && !satisfies(previous, requirement.specs)) {
        if (key === 'eth-utils')
          throw new CommandError(
            'No RustPython-compatible distribution found for ' + spelled(requirement),
            1,
          )
        warn(
          spelled(requirement) +
            ' wanted, but ' +
            key +
            ' ' +
            previous +
            ' was already chosen; keeping ' +
            previous,
        )
      }
      continue
    }
    const carriedDist = modules.dists.get(key)
    const module = key.replace(/-/g, '_')
    if (carriedDist || modules.builtin.has(module) || modules.frozen.has(module)) {
      const version = carriedDist?.[2] ?? ''
      say(
        'Requirement already satisfied: ' +
          requirement.name +
          (version ? ' ' + version : '') +
          ' (built into python.wasm)',
      )
      if (version && !satisfies(version, requirement.specs))
        warn(
          spelled(requirement) +
            ' wanted, but python.wasm carries ' +
            key +
            ' ' +
            version +
            ', which stays',
        )
      chosen.set(key, version)
      continue
    }
    if (key === 'eth-utils') {
      requirement = { ...requirement, specs: [...requirement.specs, ['<', '5.3']] }
      warn(
        'eth-utils 5.3+ needs pydantic 2 and its compiled core; selecting a compatible release below 5.3',
      )
    }
    const downgrade = downgrades[key]
    if (downgrade) {
      if (!satisfies('1.99', requirement.specs) || requirement.specs.length) warn(downgrade[1])
      else if (top) warn(downgrade[1])
      requirement = { ...requirement, specs: parseSpecs(downgrade[0]) }
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
    if (!fetch) throw new CommandError('network access is not available in this shell', 1)
    say('Collecting ' + spelled(requirement))
    const proj = await project(ctx, key, requirement)
    const candidates = Object.entries(proj.releases)
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
    const pool = flags.pre || !stable.length ? candidates : stable
    if (!pool.length) {
      if (key === 'eth-utils')
        throw new CommandError(
          'No RustPython-compatible distribution found for ' + spelled(requirement),
          1,
        )
      if (!requirement.specs.length)
        throw new CommandError('No matching distribution found for ' + spelled(requirement), 1)
      warn(
        'no release of ' + key + ' matches ' + spelled(requirement) + '; taking the newest release',
      )
    }
    const pickFrom = pool.length
      ? pool
      : Object.entries(proj.releases)
          .map(([text, files]) => ({
            text,
            version: parseVersion(text)!,
            files: files.filter((file) => !file.yanked),
          }))
          .filter((entry) => entry.version && entry.files.length && !prerelease(entry.version))
          .sort((a, b) => compare(b.version, a.version))
    const pick = pickFrom[0]
    if (!pick)
      throw new CommandError('No matching distribution found for ' + spelled(requirement), 1)
    const shim = shims[key]
    let unit: Unit | undefined
    if (shim) {
      const distInfo = distName(proj.info.name) + '-' + pick.text + '.dist-info'
      const files = new Map(Object.entries(shim.files).map(([path, body]) => [path, encode(body)]))
      unit = {
        files,
        metadata: metadataText(proj.info.name, pick.text, []),
        distInfo,
        skipped: [],
        note: 'installed ' + shim.note + ' in place of its compiled wheel',
      }
    }
    let failure: Compiled | undefined
    for (const release of shim ? [] : pickFrom.slice(0, 1)) {
      const wheels = release.files.filter(
        (file) => file.packagetype === 'bdist_wheel' && fits(file.requires_python),
      )
      const purest = wheels.find((file) => pure(file.filename))
      const platformWheel = wheels
        .filter((file) => platform(file.filename) >= 0)
        .sort((a, b) => platform(b.filename) - platform(a.filename))[0]
      const sdist = release.files.find((file) => file.packagetype === 'sdist')
      for (const file of [purest, platformWheel, sdist]) {
        if (!file) continue
        if (file.size > 96 * 1024 * 1024) continue
        say('Downloading ' + file.filename + ' (' + size(file.size) + ')')
        const data = await download(ctx, file.url)
        try {
          unit =
            file.packagetype === 'sdist'
              ? await fromSdist(data, file.filename, proj.info.name, release.text)
              : await fromWheel(data, file.filename, modules, key, false)
          if (file.packagetype === 'sdist' && failure && unit.note) {
            unit = undefined
            continue
          }
          break
        } catch (error) {
          if (!(error instanceof Compiled)) throw error
          failure = error
        }
      }
    }
    if (!unit) {
      if (failure)
        throw new CommandError(
          proj.info.name +
            ' ' +
            pick.text +
            " needs compiled modules nanocode's Python does not carry (" +
            failure.modules.slice(0, 4).join(', ') +
            (failure.modules.length > 4 ? ', ... ' + failure.modules.length + ' in all' : '') +
            ') and has no pure-Python fallback; python.wasm ships compiled ' +
            shippedModules.join(', ') +
            (alternatives[key] ? '. Instead: ' + alternatives[key] : ''),
          1,
        )
      const kinds = [
        ...new Set(
          pick.files.map((file) =>
            file.packagetype === 'sdist' ? 'a source distribution' : tags(file.filename).join('-'),
          ),
        ),
      ]
      throw new CommandError(
        proj.info.name +
          ' ' +
          pick.text +
          ' has no pure-Python or CPython 3.14 x86_64 Linux wheel and no usable source, only ' +
          kinds.slice(0, 5).join(', ') +
          (alternatives[key] ? '. Instead: ' + alternatives[key] : ''),
        1,
      )
    }
    if (key === 'eth-utils') {
      const fallback = fields(unit.metadata, 'Requires-Dist').find((text) => {
        const dependency = parseRequirement(text)
        return (
          normalize(dependency.name) === 'toolz' &&
          /^implementation_name\s*==\s*(['"])pypy\1$/.test(dependency.marker)
        )
      })
      if (fallback) {
        const dependency = fallback.replace(
          /implementation_name\s*==\s*(['"])pypy\1/,
          'implementation_name == "rustpython"',
        )
        unit.metadata = unit.metadata.replace(
          /\r?\n\r?\n|$/,
          '\nRequires-Dist: ' + dependency + '\n\n',
        )
        unit.files.set(unit.distInfo + '/METADATA', encode(unit.metadata))
        warn(proj.info.name + ': using its pure-Python toolz dependency on RustPython')
      }
    }
    chosen.set(key, pick.text)
    if (have) {
      say('Uninstalling ' + have.name + '-' + have.version)
      await remove(ctx.fs, have)
    }
    await place(ctx, unit, top)
    if (unit.note) warn(proj.info.name + ': ' + unit.note)
    done.push(proj.info.name + '-' + pick.text)
    if (flags.deps)
      for (const next of dependencies(fields(unit.metadata, 'Requires-Dist'), requirement.extras))
        queue.push({ requirement: next, top: false })
  }
  if (done.length) say('Successfully installed ' + done.join(' '))
  return 0
}

async function requirementsFile(
  ctx: CommandContext,
  path: string | undefined,
  seen = new Set<string>(),
): Promise<string[]> {
  if (path === undefined) throw new CommandError('-r needs a requirements file', 2)
  const full = ctx.resolve(path)
  if (seen.has(full)) return []
  seen.add(full)
  const out: string[] = []
  const text = decode(await ctx.fs.read(full)).replace(/\\\r?\n/g, ' ')
  for (const raw of text.split(/\r?\n/)) {
    const line = raw
      .replace(/(^|\s)#.*$/, '')
      .replace(/\s--hash[=\s]\S+/g, '')
      .trim()
    if (!line) continue
    const nested = /^(?:-r|--requirement)[=\s]+(\S+)$/.exec(line)
    if (nested) {
      out.push(...(await requirementsFile(ctx, parentOf(full) + '/' + nested[1], seen)))
      continue
    }
    const editable = /^(?:-e|--editable)[=\s]+(\S+)$/.exec(line)
    if (editable) {
      out.push(editable[1])
      continue
    }
    if (line.startsWith('-')) continue
    out.push(line)
  }
  return out
}

const usage =
  'Usage: pip install [-U] [--no-deps] [--pre] [-q] [-r FILE] [-e DIR] PACKAGE|URL|PATH...\n       pip uninstall [-y] PACKAGE...\n       pip list | pip freeze | pip show PACKAGE... | pip check\n'

const valued = new Set([
  '-i',
  '--index-url',
  '--extra-index-url',
  '-c',
  '--constraint',
  '-f',
  '--find-links',
  '--trusted-host',
  '--cache-dir',
  '--timeout',
  '--retries',
  '--progress-bar',
  '--root-user-action',
  '--python-version',
  '--platform',
  '--only-binary',
  '--no-binary',
  '--implementation',
  '--abi',
  '--log',
  '--proxy',
  '--src',
  '--prefix',
  '--root',
  '--upgrade-strategy',
  '--report',
  '--python',
  '--format',
  '--exclude',
])

export async function pip(ctx: CommandContext, args: string[]): Promise<number> {
  const rest: string[] = []
  let command: string | undefined
  const global: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (
      command === undefined &&
      arg.startsWith('-') &&
      !['-h', '--help', '-V', '--version'].includes(arg)
    ) {
      global.push(arg)
      if (valued.has(arg)) i++
      continue
    }
    if (command === undefined) command = arg
    else rest.push(arg)
  }
  const quietGlobal = global.some((arg) => /^-q+$|^--quiet$/.test(arg))
  if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
    ctx.stdout.write(
      usage +
        'Installs PyPI packages into ' +
        sitePackages +
        ': pure-Python wheels, wheels whose compiled parts are optional, pure-Python sdists and local paths; python.wasm ships compiled ' +
        shippedModules.join(', ') +
        '\n',
    )
    return 0
  }
  if (command === '-V' || command === '--version') {
    ctx.stdout.write('pip 25.3 (nanocode) from ' + sitePackages + ' (python 3.14)\n')
    return 0
  }
  if (command === 'install') {
    const flags: Flags = { quiet: quietGlobal, upgrade: false, deps: true, pre: false }
    const specs: string[] = []
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]
      const [flag, inline] =
        arg.startsWith('--') && arg.includes('=')
          ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
          : [arg, undefined]
      if (/^-q+$/.test(flag) || flag === '--quiet') flags.quiet = true
      else if (
        flag === '-U' ||
        flag === '--upgrade' ||
        flag === '--force-reinstall' ||
        flag === '-I' ||
        flag === '--ignore-installed'
      )
        flags.upgrade = true
      else if (flag === '--no-deps') flags.deps = false
      else if (flag === '--pre') flags.pre = true
      else if (flag === '-r' || flag === '--requirement')
        specs.push(...(await requirementsFile(ctx, inline ?? rest[++i])))
      else if (flag === '-e' || flag === '--editable') specs.push(inline ?? rest[++i])
      else if (/^-r./.test(flag)) specs.push(...(await requirementsFile(ctx, flag.slice(2))))
      else if (flag === '-t' || flag === '--target')
        throw new CommandError(
          'install: --target is not supported; packages go into ' +
            sitePackages +
            ', which python3 imports from',
          2,
        )
      else if (valued.has(flag)) {
        if (inline === undefined) i++
      } else if (flag.startsWith('-')) continue
      else specs.push(arg)
    }
    if (!specs.length)
      throw new CommandError(
        'You must give at least one requirement to install (see "pip help install")',
        1,
      )
    return install(ctx, specs, flags)
  }
  if (command === 'uninstall') {
    const present = await installed(ctx.fs)
    const names: string[] = []
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '-r' || rest[i] === '--requirement')
        names.push(
          ...(await requirementsFile(ctx, rest[++i])).map((spec) => parseRequirement(spec).name),
        )
      else if (!rest[i].startsWith('-')) names.push(rest[i])
    }
    for (const name of names) {
      const found = present.get(normalize(name))
      if (!found || carriedDists[normalize(name)]?.[2] === found.version) {
        ctx.stderr.write(
          'WARNING: Skipping ' +
            name +
            (found ? ' as it is built into python.wasm' : ' as it is not installed') +
            '.\n',
        )
        continue
      }
      ctx.stdout.write('Found existing installation: ' + found.name + ' ' + found.version + '\n')
      await remove(ctx.fs, found)
      ctx.stdout.write('  Successfully uninstalled ' + found.name + '-' + found.version + '\n')
    }
    return 0
  }
  if (command === 'list' || command === 'freeze') {
    const present = await installed(ctx.fs)
    const modules = await carriedOnce(ctx).catch(() => undefined)
    for (const [key, [name, , version]] of modules?.dists ?? [])
      if (!present.has(key)) present.set(key, { name, version, dir: '', requires: [] })
    const sorted = [...present.values()].sort((a, b) =>
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
    )
    if (
      rest.includes('--format=json') ||
      (rest.includes('--format') && rest[rest.indexOf('--format') + 1] === 'json')
    ) {
      ctx.stdout.write(
        JSON.stringify(sorted.map((found) => ({ name: found.name, version: found.version }))) +
          '\n',
      )
      return 0
    }
    if (command === 'list') {
      const width = Math.max(7, ...sorted.map((found) => found.name.length))
      ctx.stdout.write('Package'.padEnd(width) + ' Version\n' + '-'.repeat(width) + ' -------\n')
      for (const found of sorted)
        ctx.stdout.write(found.name.padEnd(width) + ' ' + found.version + '\n')
    } else for (const found of sorted) ctx.stdout.write(found.name + '==' + found.version + '\n')
    return 0
  }
  if (command === 'show') {
    const present = await installed(ctx.fs)
    let status = 0
    let first = true
    for (const name of rest.filter((arg) => !arg.startsWith('-'))) {
      const found =
        present.get(normalize(name)) ??
        (carriedDists[normalize(name)] && {
          name: carriedDists[normalize(name)][0],
          version: carriedDists[normalize(name)][2],
          dir: '',
          requires: [],
        })
      if (!found) {
        ctx.stderr.write('WARNING: Package(s) not found: ' + name + '\n')
        status = 1
        continue
      }
      const requiredBy = [...present.values()]
        .filter((other) =>
          other.requires.some(
            (text) =>
              normalize(parseRequirement(text).name) === normalize(found.name) &&
              evaluate(parseRequirement(text).marker, []),
          ),
        )
        .map((other) => other.name)
      ctx.stdout.write(
        (first ? '' : '---\n') +
          'Name: ' +
          found.name +
          '\nVersion: ' +
          found.version +
          '\nLocation: ' +
          sitePackages +
          '\nRequires: ' +
          found.requires
            .filter((text) => evaluate(parseRequirement(text).marker, []))
            .map((text) => parseRequirement(text).name)
            .join(', ') +
          '\nRequired-by: ' +
          requiredBy.join(', ') +
          '\n',
      )
      first = false
    }
    return status
  }
  if (command === 'check') {
    ctx.stdout.write('No broken requirements found.\n')
    return 0
  }
  if (command === 'cache' || command === 'config') return 0
  if (command === 'download' || command === 'wheel')
    throw new CommandError(
      command + ' is not supported here: pip install puts packages straight into ' + sitePackages,
      1,
    )
  throw new CommandError('unknown command "' + command + '"\n' + usage, 1)
}
