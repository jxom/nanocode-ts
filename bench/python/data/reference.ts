import * as Child from 'node:child_process'
import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Fixtures from './fixtures.ts'
import * as Workloads from './workloads.ts'

const python = process.argv[2] ?? 'python3'
const root = Path.resolve(process.argv[3] ?? 'output/data-reference')
const expected: Record<string, string[]> = {}

for (const workload of Workloads.all) {
  const dir = Path.join(root, workload.id)
  Fs.rmSync(dir, { recursive: true, force: true })
  Fs.mkdirSync(dir, { recursive: true })
  await Fixtures.place(Fixtures.disk(dir), workload.files())
  for (const command of workload.git ?? [])
    Child.execSync(command.replace('/workspace', dir), { stdio: 'inherit', shell: '/bin/sh' })
  expected[workload.id] = workload.steps.map((step) => {
    const result = Child.spawnSync('sh', ['-c', step.command.replace(/^python3/, python)], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PATH: Path.dirname(python) + ':' + process.env.PATH },
    })
    if (result.status !== 0)
      throw new Error(workload.id + ' ' + step.command + ': ' + result.stderr)
    return result.stdout
      .split('\n')
      .filter((line) => !line.startsWith('mode='))
      .join('\n')
  })
}

Fs.writeFileSync(
  Path.join(Path.dirname(new URL(import.meta.url).pathname), 'expected.json'),
  JSON.stringify(expected, null, 2) + '\n',
)
