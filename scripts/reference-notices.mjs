import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Url from 'node:url'

const root = Url.fileURLToPath(new URL('..', import.meta.url))
const digest = (bytes) => Crypto.createHash('sha256').update(bytes).digest('hex')

export function verifyNotices() {
  const directory = Path.join(root, 'vendor/reference')
  const referenceBytes = Fs.readFileSync(Path.join(directory, 'reference.json'))
  const reference = JSON.parse(referenceBytes)
  const base = Path.join(directory, 'notices')
  const coverage = JSON.parse(Fs.readFileSync(Path.join(base, 'coverage.json')))
  if (coverage.referenceSha256 !== digest(referenceBytes)) throw new Error('notice coverage belongs to another reference epoch')
  if (!Array.isArray(coverage.packages) || coverage.packages.length !== reference.packages.length) throw new Error('incomplete notice coverage set')
  const packages = new Map(coverage.packages.map((entry) => [entry.name, entry]))
  if (packages.size !== reference.packages.length) throw new Error('duplicate notice coverage')
  for (const entry of reference.packages) {
    const covered = packages.get(entry.name)
    if (!covered || covered.version !== entry.version || covered.archiveSha256 !== entry.sha256 || covered.status !== 'covered' || typeof covered.basis !== 'string' || !covered.basis.trim() || !Array.isArray(covered.notices) || !covered.notices.length) throw new Error('missing reviewed notice coverage: ' + entry.name)
    for (const notice of covered.notices) {
      if (typeof notice.file !== 'string' || Path.isAbsolute(notice.file) || notice.file.split(/[\\/]/).some((part) => !part || part === '..' || part === '.')) throw new Error('unsafe notice path')
      let file = base
      for (const part of notice.file.split('/')) {
        file = Path.join(file, part)
        if (Fs.lstatSync(file).isSymbolicLink()) throw new Error('notice symlink')
      }
      const bytes = Fs.readFileSync(file)
      if (!bytes.length || digest(bytes) !== notice.sha256) throw new Error('notice hash mismatch: ' + notice.file)
    }
  }
  return { packages: packages.size, coverageSha256: digest(Fs.readFileSync(Path.join(base, 'coverage.json'))), scope: 'reviewed notice mapping and exact hashes, not a legal opinion' }
}

export function distributionNotices() {
  const directory = Path.join(root, 'vendor/reference')
  const referenceBytes = Fs.readFileSync(Path.join(directory, 'reference.json'))
  const reference = JSON.parse(referenceBytes)
  const base = Path.join(directory, 'notices')
  const coverage = JSON.parse(Fs.readFileSync(Path.join(base, 'coverage.json')))
  if (coverage.referenceSha256 !== digest(referenceBytes)) throw new Error('notice epoch mismatch')
  const bundled = JSON.parse(Fs.readFileSync(Path.join(root, 'package.json'))).bundleDependencies ?? []
  const wanted = reference.packages.filter((entry) => bundled.some((name) => entry.name === 'node_modules/' + name || entry.name.startsWith('node_modules/' + name + '/node_modules/')))
  if (bundled.some((name) => !wanted.some((entry) => entry.name === 'node_modules/' + name))) throw new Error('bundled dependency absent from reference')
  const packages = wanted.map((entry) => {
    const matches = coverage.packages.filter((value) => value.name === entry.name)
    const covered = matches[0]
    if (matches.length !== 1 || covered.version !== entry.version || covered.archiveSha256 !== entry.sha256 || covered.status !== 'covered' || !covered.basis || !covered.notices.length) throw new Error('bundled notice coverage missing: ' + entry.name)
    const notices = covered.notices.map((notice) => {
      if (Path.isAbsolute(notice.file) || notice.file.split(/[\\/]/).some((part) => !part || part === '..' || part === '.')) throw new Error('unsafe notice path')
      let file = base
      for (const part of notice.file.split('/')) {
        file = Path.join(file, part)
        if (Fs.lstatSync(file).isSymbolicLink()) throw new Error('notice symlink')
      }
      const bytes = Fs.readFileSync(file)
      if (!bytes.length || digest(bytes) !== notice.sha256) throw new Error('bundled notice hash mismatch')
      return { sha256: notice.sha256, text: bytes.toString('utf8') }
    })
    return { name: entry.name, version: entry.version, archiveSha256: entry.sha256, notices }
  })
  return Buffer.from(JSON.stringify({ format: 1, packages }, null, 2) + '\n')
}

if (process.argv[1] && Path.resolve(process.argv[1]) === Url.fileURLToPath(import.meta.url)) console.log(JSON.stringify(verifyNotices(), null, 2))
