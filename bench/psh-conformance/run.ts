import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import * as Bash from '../../src/bash/Bash.ts'
import { cases, fixtures } from './bash.ts'

type Outcome = { exitCode: number; stderr: string; stdout: string }

const expectedPath = process.argv[2] ?? new URL('expected.json', import.meta.url).pathname
const outDir = process.argv[3] ?? 'output/psh-conformance'
const only = process.argv[4]
const expected: Record<string, Outcome> = JSON.parse(readFileSync(expectedPath, 'utf8'))
const files: Record<string, string> = {}
const psh =
  process.env.PSH_ENGINE === 'wasm'
    ? WebAssembly.compile(
        readFileSync(fileURLToPath(new URL('../../dist/psh.wasm', import.meta.url))),
      )
    : undefined

for (const [path, content] of Object.entries(fixtures)) files['/home/user/w/' + path] = content

const sections = new Map<string, { failed: number; total: number }>()
const failures: { actual: Outcome; expected: Outcome; name: string; script: string }[] = []

for (const entry of cases) {
  if (only && !entry.name.startsWith(only)) continue
  const want = expected[entry.name]
  if (!want) throw new Error('missing expectation ' + entry.name)

  const bash = await Bash.create({ cwd: '/home/user/w', files, ...(psh ? { psh } : {}) })
  const actual = await (async (): Promise<Outcome> => {
    try {
      const result = await bash.exec(entry.script, { timeoutMs: 5000 })
      return { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout }
    } catch (error) {
      return { exitCode: -2, stderr: String(error), stdout: '' }
    }
  })()

  const stat = sections.get(entry.section) ?? { failed: 0, total: 0 }
  stat.total++
  if (actual.stdout !== want.stdout || actual.exitCode !== want.exitCode) {
    stat.failed++
    failures.push({
      actual,
      expected: { exitCode: want.exitCode, stderr: want.stderr, stdout: want.stdout },
      name: entry.name,
      script: entry.script,
    })
  }
  sections.set(entry.section, stat)
}

let total = 0
let failed = 0
const rows: string[] = []

for (const [section, stat] of sections) {
  total += stat.total
  failed += stat.failed
  rows.push(
    section.padEnd(12) +
      String(stat.total - stat.failed).padStart(4) +
      '/' +
      String(stat.total).padEnd(4) +
      ((100 * (stat.total - stat.failed)) / stat.total).toFixed(1) +
      '%',
  )
}

rows.push(
  'TOTAL'.padEnd(12) +
    String(total - failed).padStart(4) +
    '/' +
    String(total).padEnd(4) +
    ((100 * (total - failed)) / total).toFixed(1) +
    '%',
)
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'failures.json'), JSON.stringify(failures, null, 1) + '\n')
writeFileSync(join(outDir, 'summary.txt'), rows.join('\n') + '\n')
console.log(rows.join('\n'))
