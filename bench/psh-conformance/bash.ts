import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

type Case = { name: string; script: string; section: string }
type Outcome = { exitCode: number; stderr: string; stdout: string }

const here = dirname(new URL(import.meta.url).pathname)

export const fixtures: Record<string, string> = {
  'a.txt': 'apple\nbanana\ncherry\n',
  'data.csv': 'name,age,city\nalice,30,NYC\nbob,25,LA\ncarol,35,NYC\n',
  'dir/sub/y.md': 'y\n',
  'dir/x.txt': 'x\n',
  'dir/z.txt': 'zz\n',
  'dup.txt': 'a\na\nb\nc\nc\nc\n',
  'j.json': '{"a":1,"b":[1,2,3],"c":{"d":"x"},"items":[{"n":"a","v":1},{"n":"b","v":2}]}\n',
  'nums.txt': '3\n1\n2\n10\n',
  'words.txt': 'the quick brown fox\njumps over the lazy dog\nThe end\n',
}

export function parse(text: string): readonly Case[] {
  const cases: Case[] = []
  const lines = text.split('\n')
  let section = 'none'

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line === '') continue
    if (line.startsWith('#')) {
      section = line.slice(1)
      continue
    }
    if (line === '<<<') {
      const body: string[] = []
      for (i++; i < lines.length && lines[i] !== '>>>'; i++) body.push(lines[i] ?? '')
      cases.push({ name: section + ':' + (cases.length + 1), script: body.join('\n'), section })
      continue
    }
    cases.push({ name: section + ':' + (cases.length + 1), script: line, section })
  }

  return cases
}

export const cases = ['cases.sh', 'cases2.sh'].flatMap((file) =>
  parse(readFileSync(join(here, file), 'utf8')),
)

function runBash(entry: Case, shell: string): Outcome {
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
  return { exitCode: result.status ?? -1, stderr: result.stderr, stdout: result.stdout }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const shell = process.argv[2] ?? '/bin/bash'
  const out = process.argv[3] ?? join(here, 'expected.json')
  const expected: Record<string, Outcome & { script: string }> = {}

  for (const entry of cases)
    expected[entry.name] = { script: entry.script, ...runBash(entry, shell) }
  writeFileSync(out, JSON.stringify(expected, null, 1) + '\n')
  console.log('wrote', Object.keys(expected).length, 'cases to', out)
}
