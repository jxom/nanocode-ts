import * as Fs from 'node:fs'
import * as Path from 'node:path'
import * as Fixtures from './fixtures.ts'

export type Step = { command: string; label: string }

export type Workload = {
  id: string
  name: string
  files: () => Map<string, Uint8Array>
  git?: readonly string[] | undefined
  needs?: string | undefined
  probe?: boolean | undefined
  steps: readonly Step[]
}

const here = Path.dirname(new URL(import.meta.url).pathname)

function script(name: string): [string, Uint8Array] {
  return [name, Fs.readFileSync(Path.join(here, 'py', name))]
}

function with_(
  entries: readonly [string, Uint8Array][],
  more: Map<string, Uint8Array> = new Map(),
) {
  return new Map([...entries, ...more])
}

const step = (command: string, label = command) => ({ command, label })

const bigSizes = [5, 10, 20, 35, 50]

export const all: readonly Workload[] = [
  {
    id: 'W1',
    name: 'sine chart',
    files: () => with_([script('w1_sine.py')]),
    steps: [step('python3 w1_sine.py')],
  },
  (() => {
    const tree = Fixtures.repo(3000)
    return {
      id: 'W2',
      name: 'repo files chart',
      files: () => with_([script('w2_repo.py')], tree.files),
      git: tree.git,
      steps: [step('python3 w2_repo.py')],
    }
  })(),
  {
    id: 'W3',
    name: 'csv 10 MB groupby chart',
    files: () => with_([script('w3_csv.py'), ['sales.csv', Fixtures.sales(200000)]]),
    steps: [step('python3 w3_csv.py')],
  },
  {
    id: 'W4',
    name: 'json 10k records table',
    files: () => with_([script('w4_json.py'), ['records.json', Fixtures.records(10000)]]),
    steps: [step('python3 w4_json.py')],
  },
  {
    id: 'W5a',
    name: 'bootstrap 90x4000',
    files: () => with_([script('w5_bootstrap.py'), ['tasks.json', Fixtures.tasks(90)]]),
    steps: [step('python3 w5_bootstrap.py 4000')],
  },
  {
    id: 'W5b',
    name: 'bootstrap 90x100000',
    files: () => with_([script('w5_bootstrap.py'), ['tasks.json', Fixtures.tasks(90)]]),
    steps: [step('python3 w5_bootstrap.py 100000')],
  },
  {
    id: 'W6',
    name: 'time series daily rolling chart',
    files: () => with_([script('w6_timeseries.py'), ['payments.csv', Fixtures.payments(100000)]]),
    steps: [step('python3 w6_timeseries.py')],
  },
  {
    id: 'W7',
    name: 'five python3 calls numpy+mpl',
    files: () => with_([script('w7_chart.py')]),
    steps: [1, 2, 3, 4, 5].map((index) => step('python3 w7_chart.py ' + index)),
  },
  (() => {
    const tree = Fixtures.repo(400, 8)
    return {
      id: 'W8',
      name: 'git subprocess heavy',
      files: () => with_([script('w8_git.py')], tree.files),
      git: tree.git,
      steps: [step('python3 w8_git.py')],
    }
  })(),
  {
    id: 'W9',
    name: 'polars csv groupby chart',
    needs: 'polars',
    files: () => with_([script('w9_polars.py'), ['sales.csv', Fixtures.sales(200000)]]),
    steps: [step('python3 w9_polars.py')],
  },
  {
    id: 'W10',
    name: 'big csv probe',
    probe: true,
    files: () =>
      with_(
        [script('w10_big.py')],
        new Map(
          bigSizes.map(
            (size) => ['big' + size + '.csv', Fixtures.salesOfBytes(size * 1e6)] as const,
          ),
        ),
      ),
    steps: bigSizes.map((size) => step('python3 w10_big.py big' + size + '.csv', size + ' MB')),
  },
]
