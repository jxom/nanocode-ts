import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs'
import * as Path from 'node:path'

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith('--' + name + '='))?.slice(name.length + 3) ?? fallback

const root = Path.resolve(arg('out', 'output/bench/sla/threeway'))
const lanes = arg('lanes', 'nc-claude,claude,codex').split(',')
const start = Number(arg('start', '0'))
const rounds = Number(arg('rounds', '30'))
const turns = arg('turns', '3')
const ttft = arg('ttft', '300')
const tokens = arg('tokens', '200')
const settle = arg('settle', '1500')
const metrics = ['e2e', 'overhead', 'render', 'request_out', 'ready', 'request_bytes']
const bins: { readonly [kind: string]: string } = { claude: process.env.CLAUDE_BIN ?? 'claude', codex: process.env.CODEX_BIN ?? 'codex', nc: process.env.NC_BIN ?? 'nanocode' }
const kindOf = (lane: string) => (lane.startsWith('nc') ? 'nc' : lane.includes('codex') ? 'codex' : 'claude')
const version = (bin: string) => ChildProcess.execFileSync(bin, ['--version'], { encoding: 'utf8' }).trim().split('\n')[0]!
const builds = Object.fromEntries(lanes.map((lane) => [lane, process.env['BUILD_' + lane.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()] ?? version(bins[kindOf(lane)]!)]))
const match = 'fixture|ttft=' + ttft + '|tokens=' + tokens + '|rate=0|turns=' + turns + '|prompt=SLA|120x40'

Fs.mkdirSync(root, { recursive: true })
Fs.appendFileSync(Path.join(root, 'builds.jsonl'), JSON.stringify({ builds, lanes, match, started: new Date().toISOString() }) + '\n')
for (let round = start; round < start + rounds; round++) {
  const order = [...lanes.slice(round % lanes.length), ...lanes.slice(0, round % lanes.length)]
  const dir = Path.join(root, 'rounds', String(round))
  Fs.rmSync(dir, { force: true, recursive: true })
  const run = ChildProcess.spawnSync(process.execPath, [Path.join(import.meta.dirname, 'run.ts'), '--samples=1', '--turns=' + turns, '--ttft=' + ttft, '--tokens=' + tokens, '--settle=' + settle, '--lanes=' + order.join(','), '--out=' + dir, '--label=round'], { encoding: 'utf8', env: process.env, stdio: ['ignore', 'ignore', 'pipe'] })
  if (run.stderr) Fs.appendFileSync(Path.join(root, 'stderr.log'), 'round ' + round + '\n' + run.stderr)
  const rows = Fs.readFileSync(Path.join(dir, 'round.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const out = rows.flatMap((row) =>
    row.error
      ? [JSON.stringify({ arm: row.lane, error: row.error, round, turn: row.turn })]
      : metrics.filter((metric) => typeof row[metric] === 'number' && (metric !== 'ready' || row.turn === 1)).map((metric) => JSON.stringify({ arm: row.lane, build: builds[row.lane], match, metric, order: order.indexOf(row.lane), round, session: row.lane + '-' + round, t: row.wall, turn: row.turn, value: row[metric] })),
  )
  Fs.appendFileSync(Path.join(root, 'threeway.jsonl'), out.join('\n') + '\n')
  console.log('round ' + round + ' ' + order.join(',') + ' ' + rows.map((row) => row.lane + ':' + row.turn + '=' + (row.error ? 'error' : Number(row.e2e).toFixed(1))).join(' '))
}
