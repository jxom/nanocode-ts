import * as Child from 'node:child_process'
import * as Crypto from 'node:crypto'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Url from 'node:url'
import { distributionNotices, verifyNotices } from './reference-notices.mjs'
import { current, fingerprint, manifestName, outputs, root } from './wasm.mjs'

const directory = Path.join(root, 'vendor/reference')
const index = Path.join(directory, 'reference.json')
const hash = (bytes) => Crypto.createHash('sha256').update(bytes).digest('hex')
const read = (path) => Fs.readFileSync(path)
const run = (args, options = {}) => {
  const result = Child.spawnSync(args[0], args.slice(1), { cwd: root, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(args[0] + ' failed: ' + result.status)
  return result.stdout
}
const git = (args) => run(['git', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
const verify = (bytes, integrity) => {
  const variants = integrity.split(/\s+/)
  if (!variants.some((part) => {
    const offset = part.indexOf('-')
    return Crypto.createHash(part.slice(0, offset)).update(bytes).digest('base64') === part.slice(offset + 1)
  })) throw new Error('archive integrity mismatch')
}
const pending = new Map()
const download = async (url, path) => {
  Fs.mkdirSync(Path.dirname(path), { recursive: true })
  if (Fs.existsSync(path)) return read(path)
  await new Promise((resolve, reject) => {
    const child = Child.spawn('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--output', path + '.partial', url], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('download failed: ' + url)))
  })
  Fs.renameSync(path + '.partial', path)
  return read(path)
}
const fetchFile = (url, path) => {
  if (!pending.has(path)) pending.set(path, download(url, path))
  return pending.get(path)
}
const inputs = () => Object.fromEntries(git(['ls-files', '-z', 'src', 'package.json', 'package-lock.json', 'tsconfig*.json', 'LICENSE-*']).split('\0').filter(Boolean).sort().map((name) => [name, hash(read(Path.join(root, name)))]))
const command = process.argv[2]
const tracked = ['src', 'package.json', 'package-lock.json', 'tsconfig*.json', 'LICENSE-*']
if (Child.spawnSync('git', ['diff', '--quiet', 'HEAD', '--', ...tracked], { cwd: root }).status !== 0 || git(['ls-files', '--others', '--exclude-standard', '--', 'src'])) throw new Error('reference source inputs must be committed')

if (command === 'verify-redistribution') {
  console.log(JSON.stringify(verifyNotices(), null, 2))
} else if (command === 'capture') {
  const wasm = process.argv[3]
  if (!wasm) throw new Error('capture requires an existing, reviewed WASM archive')
  if (Fs.existsSync(index)) throw new Error('reference.json already exists; review before replacing it')
  const lock = JSON.parse(read(Path.join(root, 'package-lock.json')))
  const entries = Object.entries(lock.packages).filter(([name]) => name !== '')
  const packages = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(16, entries.length) }, async () => {
    while (next < entries.length) {
      const [name, entry] = entries[next++]
      if (!entry.resolved?.startsWith('https://') || !entry.integrity) throw new Error('unsupported lock source: ' + name)
      const file = 'npm/' + hash(Buffer.from(entry.resolved)) + '.tgz'
      const bytes = await fetchFile(entry.resolved, Path.join(directory, file))
      verify(bytes, entry.integrity)
      packages.push({ bytes: bytes.length, file, integrity: entry.integrity, license: entry.license, name, sha256: hash(bytes), url: entry.resolved, version: entry.version })
    }
  }))
  const node = { file: 'node-v24.22.3-linux-x64.tar.xz', sha256: '4f2b175a6d53a5c617a80dba2676238a0688cef28c6da4eba35c7d844e66fcfb', url: 'https://nodejs.org/dist/v24.22.3/node-v24.22.3-linux-x64.tar.xz' }
  const nodeBytes = await fetchFile(node.url, Path.join(directory, node.file))
  if (hash(nodeBytes) !== node.sha256) throw new Error('Node archive SHA-256 mismatch')
  const wasmBytes = read(Path.resolve(wasm))
  const wasmFile = 'nanocode-wasm-' + fingerprint() + '.tgz'
  Fs.copyFileSync(Path.resolve(wasm), Path.join(directory, wasmFile))
  Fs.writeFileSync(index, JSON.stringify({ sourceCommit: git(['rev-parse', 'HEAD']), inputs: inputs(), packInputs: { ...inputs(), 'README.md': hash(read(Path.join(root, 'README.md'))) }, node: { ...node, bytes: nodeBytes.length }, packages: packages.sort((a, b) => a.name.localeCompare(b.name)), wasm: { bytes: wasmBytes.length, file: wasmFile, fingerprint: fingerprint(), sha256: hash(wasmBytes), url: 'https://github.com/nanocodexyz/nanocode-ts/releases/download/wasm-' + fingerprint() + '/' + wasmFile } }, null, 2) + '\n')
  console.log('Captured ' + packages.length + ' locked npm entries, Node and WASM; not an offline build proof')
} else if (command === 'build' || command === 'build-release' || command === 'verify') {
  const reference = JSON.parse(read(index))
  if (JSON.stringify(inputs()) !== JSON.stringify(reference.inputs)) throw new Error('reference source inputs changed; capture and review a new reference')
  if (reference.packInputs && JSON.stringify({ ...inputs(), 'README.md': hash(read(Path.join(root, 'README.md'))) }) !== JSON.stringify(reference.packInputs)) throw new Error('reference package inputs changed; capture and review a new reference')
  const files = [reference.node, reference.wasm, ...reference.packages]
  for (const file of files) {
    const bytes = read(Path.join(directory, file.file))
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw new Error('reference file mismatch: ' + file.file)
  }
  if (command === 'verify') {
    console.log('Reference checksums and source inputs verified; no build executed')
  } else {
    if (process.env.NANOCODE_REFERENCE_NETWORK !== 'denied') throw new Error('use scripts/reference.sh build for the OS network boundary')
    if (process.version !== 'v24.22.3') throw new Error('incorrect reference Node version')
    const revision = git(['rev-parse', 'HEAD'])
    const work = Fs.mkdtempSync(Path.join(root, 'output/reference-'))
    const source = Path.join(work, 'source')
    Fs.mkdirSync(source)
    const archive = Path.join(work, 'source.tar')
    run(['git', 'archive', '--format=tar', '--output=' + archive, 'HEAD'])
    run(['tar', '-xf', archive, '-C', source])
    const original = read(Path.join(source, 'package-lock.json'))
    const originalPackage = read(Path.join(source, 'package.json'))
    const packageJson = JSON.parse(originalPackage)
    const lock = JSON.parse(original)
    for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(packageJson[group] ?? {})) {
        if (!spec.startsWith('https://')) continue
        const entry = reference.packages.find((value) => value.name === 'node_modules/' + name)
        if (!entry) throw new Error('direct archive missing from reference: ' + name)
        const local = Url.pathToFileURL(Path.join(directory, entry.file)).href
        packageJson[group][name] = local
        lock.packages[''][group][name] = local
      }
    }
    Fs.writeFileSync(Path.join(source, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n')
    for (const entry of reference.packages) lock.packages[entry.name].resolved = Url.pathToFileURL(Path.join(directory, entry.file)).href
    Fs.writeFileSync(Path.join(source, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n')
    const npm = [process.execPath, Path.resolve(Path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
    const cache = Path.join(work, 'empty-npm-cache')
    const options = { cwd: source, env: { ...process.env, npm_config_cache: cache, npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', SHIPPY_REMOTE_BUILD: '0' } }
    run([...npm, 'ci', '--ignore-scripts', '--offline', '--no-audit', '--no-fund'], options)
    Fs.writeFileSync(Path.join(source, 'package-lock.json'), original)
    Fs.writeFileSync(Path.join(source, 'package.json'), originalPackage)
    const dist = Path.join(source, 'dist')
    Fs.mkdirSync(dist)
    const members = run(['tar', '-tzf', Path.join(directory, reference.wasm.file)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim().split('\n')
    if (members.length !== outputs.length + 1 || members.some((name) => ![...outputs, manifestName].includes(name))) throw new Error('unexpected WASM archive members')
    run(['tar', '--no-same-owner', '--no-same-permissions', '-xzf', Path.join(directory, reference.wasm.file), '-C', dist])
    if (!current(dist, fingerprint())) throw new Error('WASM archive does not match reference fingerprint')
    run([...npm, 'run', 'build:ts'], options)
    run([...npm, 'run', 'check:types'], options)
    if (command === 'build-release') Fs.writeFileSync(Path.join(dist, 'THIRD-PARTY-NOTICES.json'), distributionNotices())
    const packed = JSON.parse(run([...npm, 'pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', work], { ...options, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))[0]
    const file = Path.join(work, 'nanocode-ts-' + revision.slice(0, 7) + '.tgz')
    Fs.renameSync(Path.join(work, packed.filename), file)
    const receipt = { revision, sourceCommit: reference.sourceCommit, artifact: file, sha256: hash(read(file)), bytes: Fs.statSync(file).size, network: 'Linux user+network namespace, no interfaces except down loopback', node: process.version, npm: run([...npm, '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim(), referenceSha256: hash(read(index)), installScripts: false, cargoExecuted: false, checks: ['all source and archive hashes', 'npm ci --offline --ignore-scripts with empty cache', 'WASM fingerprint and all output hashes', 'npm run build:ts', 'npm run check:types', 'npm pack --offline --ignore-scripts'] }
    Fs.writeFileSync(Path.join(work, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    console.log(JSON.stringify(receipt, null, 2))
  }
} else {
  throw new Error('usage: node scripts/reference.mjs capture <reviewed-wasm.tgz> | verify | verify-redistribution; scripts/reference.sh build')
}
