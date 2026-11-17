import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const [, , input, shell, out] = process.argv
const { cases, fixtures } = JSON.parse(readFileSync(input, 'utf8'))
const expected = {}

for (const entry of cases) {
  const root = mkdtempSync(join(tmpdir(), 'pshc-'))
  const cwd = join(root, 'w')
  for (const [path, content] of Object.entries(fixtures)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), content)
  }
  const result = spawnSync(shell, ['-c', entry.script], {
    cwd,
    encoding: 'utf8',
    env: {
      HOME: root,
      LANG: 'C.UTF-8',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      SHELL: '/bin/bash',
      USER: 'user',
    },
    input: '',
    timeout: 5000,
  })
  rmSync(root, { force: true, recursive: true })
  expected[entry.name] = {
    script: entry.script,
    exitCode: result.status ?? -1,
    stderr: result.stderr,
    stdout: result.stdout,
  }
}

writeFileSync(out, JSON.stringify(expected, null, 1) + '\n')
console.log('wrote', Object.keys(expected).length, 'cases')
