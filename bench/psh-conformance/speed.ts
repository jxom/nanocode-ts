import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as Bash from '../../src/bash/Bash.ts'
import { fixtures } from './bash.ts'

const samples = Number(process.argv[2] ?? 200)
const shell = process.argv[3] ?? '/bin/bash'
const workloads = [
  'echo hi',
  'x=$((3*4)); echo $x',
  'echo hi | tr a-z A-Z',
  'cat a.txt | grep an | wc -l',
  'for i in 1 2 3 4 5 6 7 8 9 10; do echo $i; done | sort -n | tail -1',
  "awk -F, 'NR>1 {s+=$2} END {print s}' data.csv",
  "sed 's/a/A/g' a.txt",
  'jq -r .c.d j.json',
  'find dir -type f | sort',
  'f() { local v=$1; echo ${v^^}; }; f abc',
]

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1))
  return {
    ci95: 1.96 * (sd / Math.sqrt(values.length)),
    mean,
    median: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
  }
}

const root = mkdtempSync(join(tmpdir(), 'pshs-'))
const cwd = join(root, 'w')
const files: Record<string, string> = {}

for (const [path, content] of Object.entries(fixtures)) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true })
  writeFileSync(join(cwd, path), content)
  files['/home/user/w/' + path] = content
}

const startup: number[] = []

for (let i = 0; i < samples; i++) {
  const t0 = performance.now()
  const fresh = await Bash.create({ cwd: '/home/user/w', files })
  await fresh.exec('true')
  startup.push(performance.now() - t0)
}

const bash = await Bash.create({ cwd: '/home/user/w', files })
const rows: Record<string, unknown>[] = []

for (const command of workloads) {
  for (let i = 0; i < 20; i++) await bash.exec(command)

  const pshWall: number[] = []
  const cpu0 = process.cpuUsage()

  for (let i = 0; i < samples; i++) {
    const t0 = performance.now()
    await bash.exec(command)
    pshWall.push(performance.now() - t0)
  }

  const cpu = process.cpuUsage(cpu0)
  const bashWall: number[] = []

  for (let i = 0; i < samples; i++) {
    const t0 = performance.now()
    spawnSync(shell, ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    bashWall.push(performance.now() - t0)
  }

  const p = stats(pshWall)
  const b = stats(bashWall)
  rows.push({
    command,
    bash_ms: b,
    psh_cpu_us: ((cpu.user + cpu.system) / samples).toFixed(1),
    psh_ms: p,
    ratio_median: (b.median / p.median).toFixed(1),
  })
}

const loop = spawnSync(
  shell,
  [
    '-c',
    'TIMEFORMAT=%R; time (for ((i=0;i<' +
      samples * 10 +
      ';i++)); do x=$((3*4)); echo $x >/dev/null; done)',
  ],
  { cwd, encoding: 'utf8' },
)
const loopUs = (Number(loop.stderr.trim()) * 1e6) / (samples * 10)

console.log(
  JSON.stringify(
    {
      bash_builtin_loop_us_per_iter: loopUs.toFixed(2),
      node: process.version,
      rows,
      samples,
      shell,
      startup_ms: stats(startup),
    },
    null,
    1,
  ),
)
