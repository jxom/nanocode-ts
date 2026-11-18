import * as Child from 'node:child_process'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import { distributionNotices } from './reference-notices.mjs'
import { fingerprint, manifestName, outputs, root } from './wasm.mjs'

const hash = (bytes) => Crypto.createHash('sha256').update(bytes).digest('hex')
const read = (file) => Fs.readFileSync(file)
const require = (condition, message) => { if (!condition) throw new Error(message) }
const invoke = (args, options = {}) => {
  const result = Child.spawnSync(args[0], args.slice(1), { cwd: root, encoding: 'utf8', ...options })
  if (result.error) throw result.error
  return result
}
const command = (args) => {
  const result = invoke(args)
  require(result.status === 0, args[0] + ' failed: ' + result.status + '\n' + result.stderr)
  return result.stdout.trim()
}
const [mode, directory, receiptFile, ...extra] = process.argv.slice(2)
require(['--verify', '--upload'].includes(mode) && directory && receiptFile && extra.length === 0, 'usage: node scripts/reference-publish.mjs --verify|--upload ARTIFACT_DIRECTORY RECEIPT_JSON')
const revision = command(['git', 'rev-parse', 'HEAD'])
const referenceBytes = read(Path.join(root, 'vendor/reference/reference.json'))
const reference = JSON.parse(referenceBytes)
const originalReceipt = JSON.parse(read(Path.resolve(receiptFile)))
const filename = 'nanocode-ts-' + revision.slice(0, 7) + '.tgz'
Fs.mkdirSync(Path.join(root, 'output'), { recursive: true })
const work = Fs.mkdtempSync(Path.join(root, 'output/reference-publish-'))
Fs.chmodSync(work, 0o700)
const staged = Path.join(work, filename)
Fs.copyFileSync(Path.resolve(directory, filename), staged, Fs.constants.COPYFILE_EXCL)
Fs.copyFileSync(Path.resolve(receiptFile), Path.join(work, 'receipt.json'), Fs.constants.COPYFILE_EXCL)
const packedRead = (name) => {
  const file = Path.join(work, 'member-bytes')
  const descriptor = Fs.openSync(file, 'w')
  let result
  try { result = invoke(['tar', '-xOzf', staged, name], { stdio: ['ignore', descriptor, 'pipe'] }) }
  finally { Fs.closeSync(descriptor) }
  require(result.status === 0, 'missing packed member: ' + name)
  return read(file)
}
const receipt = JSON.parse(read(Path.join(work, 'receipt.json')))
require(JSON.stringify(receipt) === JSON.stringify(originalReceipt), 'receipt changed during staging')
require(receipt.revision === revision && receipt.sourceCommit === reference.sourceCommit && receipt.referenceSha256 === hash(referenceBytes), 'receipt/source epoch mismatch')
require(receipt.sha256 === hash(read(staged)) && receipt.bytes === Fs.statSync(staged).size, 'artifact hash mismatch')
require(receipt.node === 'v24.22.3' && receipt.npm === '11.19.1' && receipt.installScripts === false && receipt.cargoExecuted === false && receipt.network === 'Linux user+network namespace, no interfaces except down loopback', 'receipt build conditions')
const expectedChecks = ['all source and archive hashes', 'npm ci --offline --ignore-scripts with empty cache', 'WASM fingerprint and all output hashes', 'npm run build:ts', 'npm run check:types', 'npm pack --offline --ignore-scripts']
require(JSON.stringify(receipt.checks) === JSON.stringify(expectedChecks), 'incomplete build receipt')
const names = command(['git', 'ls-files', '-z', 'src', 'package.json', 'package-lock.json', 'tsconfig*.json', 'LICENSE-*']).split('\0').filter(Boolean).sort()
const inputs = Object.fromEntries(names.map((name) => [name, hash(read(Path.join(root, name)))]))
require(JSON.stringify(inputs) === JSON.stringify(reference.inputs), 'reference source inputs changed; capture and qualify a new epoch')
if (reference.packInputs) require(JSON.stringify({ ...inputs, 'README.md': hash(read(Path.join(root, 'README.md'))) }) === JSON.stringify(reference.packInputs), 'reference package inputs changed')
else require(Buffer.compare(invoke(['git', 'show', reference.sourceCommit + ':README.md'], { encoding: null }).stdout, read(Path.join(root, 'README.md'))) === 0, 'historical reference README changed')
require(fingerprint() === reference.wasm.fingerprint, 'Rust fingerprint changed')
require(invoke(['git', 'diff', '--quiet', 'HEAD', '--', ...names]).status === 0 && !command(['git', 'ls-files', '--others', '--exclude-standard', '--', 'src']), 'uncommitted package inputs')
const members = command(['tar', '-tzf', staged]).split('\n')
require(members.length === new Set(members).size && members.every((name) => name.startsWith('package/') && !name.split('/').includes('..') && !name.includes('\\')), 'unsafe package members')
const bundled = JSON.parse(read(Path.join(root, 'package.json'))).bundleDependencies ?? []
require(Array.isArray(bundled) && bundled.every((name) => typeof name === 'string'), 'bundled package declaration')
require(members.every((name) => bundled.some((dependency) => name.startsWith('package/node_modules/' + dependency + '/')) || name.startsWith('package/dist/') || ['package/package.json', 'package/README.md', 'package/LICENSE-APACHE', 'package/LICENSE-MIT'].includes(name)), 'unexpected package contents')
require(command(['tar', '-tvzf', staged]).split('\n').every((line) => line.startsWith('-')), 'package contains nonregular members')
for (const name of ['package.json', 'README.md', 'LICENSE-APACHE', 'LICENSE-MIT']) {
  require(Buffer.compare(packedRead('package/' + name), read(Path.join(root, name))) === 0, 'package source mismatch: ' + name)
}
const packedManifest = JSON.parse(packedRead('package/dist/' + manifestName))
require(packedManifest.fingerprint === reference.wasm.fingerprint, 'packed WASM fingerprint')
for (const name of outputs) require(hash(packedRead('package/dist/' + name)) === packedManifest.files[name], 'packed WASM output: ' + name)
require(Buffer.compare(packedRead('package/dist/THIRD-PARTY-NOTICES.json'), distributionNotices()) === 0, 'mismatched bundled third-party notices; qualify a new build-release artifact')
const verified = { revision, sha256: hash(read(staged)), bytes: Fs.statSync(staged).size, referenceSha256: hash(referenceBytes), fingerprint: fingerprint(), receipt: 'trusted local offline build attestation, independently checked hash/source bindings; not independent compilation' }
Fs.writeFileSync(Path.join(work, 'verified.json'), JSON.stringify(verified, null, 2) + '\n')
console.log('Verified local artifact: ' + Path.join(work, 'verified.json'))
if (mode === '--upload') {
  const coverage = { bundledNoticeSha256: hash(distributionNotices()), scope: 'included bundled-package notices only; not full vendor-tree redistribution clearance' }
  require(invoke(['git', 'diff', '--quiet', 'HEAD', '--', ...names, 'README.md']).status === 0, 'commit package source inputs before publishing')
  const repository = 'nanocodexyz/nanocode-ts'
  const tag = 'build-' + revision.slice(0, 7)
  const api = (path) => invoke(['gh', 'api', '--hostname', 'github.com', 'repos/' + repository + '/' + path])
  require(JSON.parse(command(['gh', 'api', '--hostname', 'github.com', 'repos/' + repository + '/commits/' + revision])).sha === revision, 'release source not pushed')
  const existing = api('releases/tags/' + tag)
  if (existing.status === 0) {
    const release = JSON.parse(existing.stdout)
    require(release.tag_name === tag && release.draft === false && release.prerelease === false, 'existing release identity')
    require(JSON.parse(command(['gh', 'api', '--hostname', 'github.com', 'repos/' + repository + '/commits/' + tag])).sha === revision, 'existing tag source mismatch')
  } else {
    let error
    try { error = JSON.parse(existing.stdout) } catch { throw new Error('unknown release lookup result; inspect remote before retry') }
    require(existing.status === 1 && error.status === '404', 'release lookup was not an explicit 404; inspect remote before retry')
    command(['gh', 'release', 'create', tag, staged, '--repo', 'https://github.com/' + repository, '--target', revision, '--title', 'nanocode-ts ' + revision.slice(0, 7), '--notes', 'Built from ' + revision + ' with local offline reference ' + verified.referenceSha256 + '.'])
  }
  const downloaded = Path.join(work, 'downloaded.tgz')
  command(['curl', '--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--output', downloaded, 'https://github.com/' + repository + '/releases/download/' + tag + '/' + filename])
  require(hash(read(downloaded)) === verified.sha256 && Fs.statSync(downloaded).size === verified.bytes, 'published bytes differ; stop and inspect release')
  require(hash(read(staged)) === verified.sha256, 'staged bytes changed during publication')
  Fs.writeFileSync(Path.join(work, 'published.json'), JSON.stringify({ ...verified, coverage, tag, exactDownloadMatch: true }, null, 2) + '\n')
  console.log('Published bytes verified: https://github.com/' + repository + '/releases/tag/' + tag)
}
