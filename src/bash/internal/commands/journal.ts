import {
  FsError,
  type FileStat,
  type FileSystem,
  type LinkStat,
  type SyncFileSystem,
} from '../../FileSystem.ts'
import { parentOf } from '../Fs.ts'

type Entry =
  | { kind: 'file'; data: Uint8Array; mode: number }
  | { kind: 'directory' }
  | { kind: 'symlink'; target: string }

export type Effects = readonly (readonly [string, Entry | null])[]

export type Journal = {
  capture(paths: readonly string[]): Effects
  clear(): void
  files: SyncFileSystem
  mark(): Mark
  overflowed(): boolean
  replay(effects: Effects): void
  rollback(mark: Mark): void
  touched(mark: Mark): string[]
}

export type Mark = { readonly first: number; readonly changes: number }

export function create(base: SyncFileSystem, options: { bytes: number }): Journal {
  let log: (readonly [string, Effects])[] = []
  let seen = new Set<string>()
  let changed: string[] = []
  let held = 0
  let full = false
  const snapshot = (path: string, into: [string, Entry | null][]) => {
    const found = kindOf(base, path)
    if (!found) return into.push([path, null])
    if (found.kind === 'symlink') {
      into.push([path, { kind: 'symlink', target: base.readlink?.(path) ?? '' }])
      return
    }
    if (found.kind === 'file') {
      const data = base.read(path)
      held += data.length
      into.push([path, { kind: 'file', data, mode: found.mode }])
      return
    }
    into.push([path, { kind: 'directory' }])
    for (const name of base.list(path)) snapshot(join(path, name), into)
  }
  const record = (path: string) => {
    changed.push(path)
    if (full || seen.has(path)) return
    const taken: [string, Entry | null][] = []
    snapshot(path, taken)
    if (held > options.bytes) {
      full = true
      return
    }
    for (const [at] of taken) seen.add(at)
    log.push([path, taken])
  }
  const files: SyncFileSystem = {
    list: (path) => base.list(path),
    mkdir: (path) => {
      record(path)
      base.mkdir(path)
    },
    read: (path) => base.read(path),
    remove: (path) => {
      record(path)
      base.remove(path)
    },
    rename: (from, to) => {
      record(from)
      record(to)
      base.rename(from, to)
    },
    stat: (path) => base.stat(path),
    write: (path, data, append) => {
      record(path)
      base.write(path, data, append)
    },
  }
  if (base.chmod)
    files.chmod = (path, mode) => {
      record(path)
      base.chmod!(path, mode)
    }
  if (base.utimes)
    files.utimes = (path, mtime) => {
      record(path)
      base.utimes!(path, mtime)
    }
  if (base.symlink)
    files.symlink = (target, path) => {
      record(path)
      base.symlink!(target, path)
    }
  if (base.lstat) files.lstat = (path) => base.lstat!(path)
  if (base.readlink) files.readlink = (path) => base.readlink!(path)
  return {
    capture(paths) {
      const into: [string, Entry | null][] = []
      for (const path of [...new Set(paths)].sort((a, b) => depth(a) - depth(b)))
        snapshot(path, into)
      return into
    },
    clear() {
      log = []
      seen = new Set()
      changed = []
      held = 0
      full = false
    },
    files,
    mark: () => ({ first: log.length, changes: changed.length }),
    overflowed: () => full,
    replay: (effects) => restore(files, effects),
    rollback(mark) {
      if (full) throw new FsError('ENOMEM', log[mark.first]?.[0] ?? '/')
      changed.length = Math.min(changed.length, mark.changes)
      for (const [, taken] of log.splice(mark.first).reverse()) {
        restore(base, taken)
        for (const [at] of taken) seen.delete(at)
      }
    },
    touched: (mark) => [...new Set(changed.slice(mark.changes))],
  }
}

function kindOf(fs: SyncFileSystem, path: string): LinkStat | FileStat | null {
  return fs.lstat ? fs.lstat(path) : fs.stat(path)
}

function erase(fs: SyncFileSystem, path: string): void {
  const found = kindOf(fs, path)
  if (!found) return
  if (found.kind === 'directory') for (const name of fs.list(path)) erase(fs, join(path, name))
  fs.remove(path)
}

function ensure(fs: SyncFileSystem, path: string): void {
  if (path === '/' || fs.stat(path)?.kind === 'directory') return
  ensure(fs, parentOf(path))
  if (kindOf(fs, path)) erase(fs, path)
  fs.mkdir(path)
}

function restore(fs: SyncFileSystem, effects: Effects): void {
  for (const [path, entry] of effects) {
    const found = kindOf(fs, path)
    const kept = found?.kind === 'directory' && entry?.kind === 'directory'
    if (found && !kept) erase(fs, path)
    if (!entry || kept) continue
    ensure(fs, parentOf(path))
    if (entry.kind === 'directory') fs.mkdir(path)
    else if (entry.kind === 'symlink') fs.symlink?.(entry.target, path)
    else {
      fs.write(path, entry.data)
      fs.chmod?.(path, entry.mode)
    }
  }
}

export function view(
  files: SyncFileSystem,
  options: { retry: (() => Promise<boolean>) | undefined },
): FileSystem {
  const retry = options.retry
  const run = async <T>(body: () => T): Promise<T> => {
    for (;;) {
      try {
        return body()
      } catch (error) {
        if (!retry || !(await retry())) throw error
      }
    }
  }
  const fs: FileSystem = {
    list: (path) => run(() => files.list(path)),
    mkdir: (path) => run(() => files.mkdir(path)),
    read: (path) => run(() => files.read(path)),
    remove: (path) => run(() => files.remove(path)),
    rename: (from, to) => run(() => files.rename(from, to)),
    stat: (path) => run(() => files.stat(path)),
    write: (path, data, append) => run(() => files.write(path, data, append)),
  }
  if (files.chmod) fs.chmod = (path, mode) => run(() => files.chmod!(path, mode))
  if (files.utimes) fs.utimes = (path, mtime) => run(() => files.utimes!(path, mtime))
  if (files.symlink) fs.symlink = (target, path) => run(() => files.symlink!(target, path))
  if (files.lstat) fs.lstat = (path) => run(() => files.lstat!(path))
  if (files.readlink) fs.readlink = (path) => run(() => files.readlink!(path))
  if (!retry) fs.sync = files
  return fs
}

function depth(path: string): number {
  return path.split('/').length
}

function join(base: string, name: string): string {
  return base === '/' ? '/' + name : base + '/' + name
}
