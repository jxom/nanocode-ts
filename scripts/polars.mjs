import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { bake, link, source } from './python.mjs'
import { fetchCrates, root } from './wasm.mjs'

// python.wasm with polars: py-polars 1.33.1 (pyo3, abi3) built for wasm32-unknown-unknown and linked against
// nanocode's C API, with polars' Python layer frozen into the module. Writes python.wasm and python.data
// to the directory given (dist/polars by default), to use in place of dist's.
const tag = 'py-1.33.1'
const crates = [
  ['libc', '0.2.174'],
  ['pyo3', '0.25.1'],
]
const here = join(root, 'python-polars')
const out = process.argv[2] ?? join(root, 'dist', 'polars')

function run(command, cwd, env) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function polars() {
  const directory = join(root, 'target', 'polars-' + tag)
  if (!existsSync(join(directory, 'py-polars-nanocode', 'Cargo.toml'))) {
    const partial = directory + '.partial'
    rmSync(partial, { recursive: true, force: true })
    run(
      [
        'git',
        'clone',
        '--quiet',
        '--depth',
        '1',
        '--branch',
        tag,
        'https://github.com/pola-rs/polars.git',
        partial,
      ],
      root,
    )
    run(['git', 'apply', join(here, 'polars.patch')], partial)
    for (const [name, version] of crates) {
      const fetched = spawnSync(
        'curl',
        [
          '-sSfL',
          'https://static.crates.io/crates/' + name + '/' + name + '-' + version + '.crate',
        ],
        { maxBuffer: 1 << 30 },
      )
      if (fetched.status !== 0) process.exit(fetched.status ?? 1)
      mkdirSync(join(partial, 'patches', name), { recursive: true })
      writeFileSync(join(partial, 'patches', name + '.crate'), fetched.stdout)
      run(
        [
          'tar',
          'xzf',
          join('patches', name + '.crate'),
          '--strip-components',
          '1',
          '-C',
          join('patches', name),
        ],
        partial,
      )
      run(
        [
          'git',
          'apply',
          '--unsafe-paths',
          '--directory',
          join('patches', name),
          join(here, name + '.patch'),
        ],
        partial,
      )
    }
    renameSync(partial, directory)
  }
  const path = join(root, 'target', 'polars-source')
  rmSync(path, { recursive: true, force: true })
  symlinkSync(directory, path)
  return directory
}

function site(directory) {
  const target = join(root, 'target', 'polars-site')
  rmSync(target, { recursive: true, force: true })
  cpSync(join(directory, 'py-polars', 'polars'), join(target, 'polars'), {
    recursive: true,
    filter: (path) => !path.endsWith('.pyi') && !path.endsWith('py.typed'),
  })
  writeFileSync(
    join(target, 'polars', '_cpu_check.py'),
    'def get_lts_cpu() -> bool:\n    return False\n\n\ndef check_cpu_flags() -> None:\n    pass\n',
  )
  const now = new Date()
  utimesSync(join(here, 'src', 'lib.rs'), now, now)
}

link(source())
const directory = polars()
site(directory)
const config = join(root, 'target', 'pyo3-wasm.cfg')
writeFileSync(
  config,
  'implementation=CPython\nversion=3.13\nshared=false\nabi3=true\npointer_width=32\nbuild_flags=\nsuppress_build_script_link_lines=true\n',
)
fetchCrates(here)
const cc = process.env.NANOCODE_CC ?? 'clang'
run(
  [
    'cargo',
    'build',
    '--locked',
    '--offline',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
    '--target-dir',
    '../target/python-polars',
  ],
  here,
  {
    PYO3_CONFIG_FILE: config,
    CC_wasm32_unknown_unknown: cc,
    AR_wasm32_unknown_unknown:
      process.env.NANOCODE_AR ?? 'llvm-ar' + (cc.match(/-\d+$/)?.[0] ?? ''),
    CFLAGS_wasm32_unknown_unknown:
      '-ffreestanding -nostdlibinc -I' +
      join(root, 'target', 'python-sdk', 'crates', 'core', 'python-capi', 'include', 'libc'),
    CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS:
      '--cfg getrandom_backend="custom" -A ambiguous_glob_imports',
  },
)
const artifact = join(
  root,
  'target',
  'python-polars',
  'wasm32-unknown-unknown',
  'release',
  'nanocode_python_polars_wasm.wasm',
)
const binaryen = process.env.BINARYEN_PATH ?? join(root, 'target', 'binaryen-version_133')
const optimized = join(root, 'target', 'python-polars', 'python.opt.wasm')
const features = [
  '--enable-bulk-memory',
  '--enable-bulk-memory-opt',
  '--enable-exception-handling',
  '--enable-multivalue',
  '--enable-mutable-globals',
  '--enable-nontrapping-float-to-int',
  '--enable-reference-types',
  '--enable-sign-ext',
  '--enable-simd',
]
run([join(binaryen, 'bin', 'wasm-opt'), '-Oz', ...features, artifact, '-o', optimized], root)
const { module, image } = bake(readFileSync(optimized), { image: true })
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'python.wasm'), module)
writeFileSync(join(out, 'python.data'), image)
// examples/python-sci serves python.data as two static assets, since one can't pass 25 MiB.
mkdirSync(join(out, 'assets'), { recursive: true })
const half = Math.ceil(image.length / 2)
writeFileSync(join(out, 'assets', 'python.data.0'), image.subarray(0, half))
writeFileSync(join(out, 'assets', 'python.data.1'), image.subarray(half))
console.log(
  'python.wasm ' + module.length + ' bytes, python.data ' + image.length + ' bytes in ' + out,
)
