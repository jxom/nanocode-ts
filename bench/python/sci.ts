import { readFileSync } from 'node:fs'
import { Bash, MemoryFileSystem, PythonSci } from '../../src/bash/index.ts'
import type { Sci, SciRequest } from '../../src/bash/Python.ts'
import { importing } from '../../src/bash/internal/commands/python.ts'

const wasm = process.argv[2] ?? 'dist/python.wasm'
const module = new WebAssembly.Module(readFileSync(wasm))
const data = readFileSync(wasm.replace(/\.wasm$/, '.data'))

async function shell(sci?: Sci, kind: 'sync' | 'async' = 'sync') {
  const memory = MemoryFileSystem.create()
  const fs =
    kind === 'sync'
      ? memory
      : new Proxy(memory, {
          get: (target, key) => (key === 'sync' ? undefined : Reflect.get(target, key)),
        })
  const bash = await Bash.create({
    fs,
    cwd: '/home/user',
    python: { module, data, cpuMs: 60000, stepsPerMs: 42000, ...(sci ? { sci } : {}) },
    limits: { maxMemoryBytes: 512 << 20, timeoutMs: 120000 },
  })
  await bash.exec(
    'mkdir -p /home/user/data /tmp/in && echo a,b > /home/user/data/t.csv && echo 7 > /tmp/in/x.txt',
  )
  return bash
}

function standIn(sent: SciRequest[]): Sci {
  return {
    async run(request) {
      sent.push(request)
      return {
        kind: 'exited',
        status: 0,
        stdout: 'shape: (1, 2)\n',
        stderr: '',
        files: [['/home/user/out/chart.png', new Uint8Array([137, 80, 78, 71])]],
        deleted: ['/home/user/data/t.csv'],
      }
    },
  }
}

const probes: [string, () => Promise<string | true>][] = [
  [
    'scan',
    async () => {
      const yes = [
        'import polars as pl',
        'import os, polars',
        'from polars import col',
        'x = 1; import polars.selectors as cs',
        'pl = __import__("polars")',
        'import importlib; importlib.import_module("polars")',
        'if True:\n    import polars',
      ]
      const no = [
        'import polarsx',
        'import os # polars',
        'print("import polars is fun")',
        'from x import polars',
      ]
      const wrong = [
        ...yes.filter((source) => !importing(source, ['polars'])),
        ...no.filter((source) => importing(source, ['polars'])),
      ]
      return wrong.length ? 'misread: ' + JSON.stringify(wrong) : true
    },
  ],
  [
    'no_sci',
    async () => {
      const bash = await shell()
      const result = await bash.exec("python3 -c 'import polars as pl'")
      return result.exitCode !== 0 && /polars/.test(result.stderr) && /sci/.test(result.stderr)
        ? true
        : result.exitCode + ' ' + result.stderr
    },
  ],
  [
    'routed',
    async () => {
      const sent: SciRequest[] = []
      const bash = await shell(standIn(sent))
      const result = await bash.exec(
        'cd /home/user && python3 -c \'import polars as pl; print(pl.read_csv("/tmp/in/x.txt"))\' --flag',
      )
      const request = sent[0]
      const paths = request?.files.map(([path]) => path) ?? []
      const chart = await bash.exec('wc -c < /home/user/out/chart.png; ls /home/user/data')
      const ok =
        result.exitCode === 0 &&
        result.stdout === 'shape: (1, 2)\n' &&
        request?.cwd === '/home/user' &&
        request.argv.join(' ') ===
          '-c import polars as pl; print(pl.read_csv("/tmp/in/x.txt")) --flag' &&
        paths.includes('/home/user/data/t.csv') &&
        paths.includes('/tmp/in/x.txt') &&
        chart.stdout.trim() === '4'
      return ok ? true : JSON.stringify({ result, request: { ...request, files: paths }, chart })
    },
  ],
  [
    'script_file',
    async () => {
      const sent: SciRequest[] = []
      const bash = await shell(standIn(sent), 'async')
      await bash.exec("printf 'import polars\\n' > /home/user/run.py")
      const result = await bash.exec('cd /home/user && python3 run.py')
      return result.exitCode === 0 && sent[0]?.argv[0] === 'run.py' ? true : JSON.stringify(result)
    },
  ],
  [
    'unrouted',
    async () => {
      const sent: SciRequest[] = []
      const bash = await shell(standIn(sent))
      const result = await bash.exec("python3 -c 'import json; print(json.dumps(1))'")
      return result.stdout === '1\n' && sent.length === 0 ? true : JSON.stringify(result)
    },
  ],
  ...(['sync', 'async'] as const).map(
    (kind) =>
      [
        'retry_' + kind,
        async () => {
          const sent: SciRequest[] = []
          const bash = await shell(standIn(sent), kind)
          await bash.exec(
            'cd /home/user && printf \'import polars\\n\' > helper.py && printf \'open("early.txt", "w").write("x")\\nimport helper\\n\' > main.py',
          )
          const result = await bash.exec('cd /home/user && python3 main.py')
          const early = await bash.exec('test -e /home/user/early.txt && echo kept || echo dropped')
          return result.exitCode === 0 && sent.length === 1 && early.stdout === 'dropped\n'
            ? true
            : JSON.stringify({ result, sent: sent.length, early: early.stdout })
        },
      ] as [string, () => Promise<string | true>],
  ),
  [
    'in_process',
    async () => {
      const bash = await shell({ module, data, modules: ['json'] })
      const result = await bash.exec(
        'cd /home/user && python3 -c \'import json; open("o.json", "w").write(json.dumps([1]))\' && cat o.json',
      )
      return result.stdout === '[1]' ? true : JSON.stringify(result)
    },
  ],
  [
    'worker',
    async () => {
      const binding = {
        fetch: (input: string, init?: RequestInit) =>
          PythonSci.serve(new Request(input, init), { module, data }),
      }
      const bash = await shell({ ...PythonSci.remote(binding), modules: ['json'] })
      await bash.exec(
        'printf \'import json, sys\\nrows = open("data/t.csv").read()\\nopen("out.json", "w").write(json.dumps([rows, sys.argv[1:], sys.stdin.read()]))\\n\' > /home/user/go.py',
      )
      const result = await bash.exec(
        "cd /home/user && echo in | python3 go.py one 'two words' && cat out.json",
      )
      return result.stdout === '["a,b\\n", ["one", "two words"], "in\\n"]'
        ? true
        : JSON.stringify(result)
    },
  ],
]

if (process.env.POLARS) {
  const dir = process.env.POLARS
  const sci = PythonSci.local({ module: dir + '/python.wasm', data: dir + '/python.data' })
  const script = [
    'import polars as pl',
    'df = pl.read_csv("data/t.csv")',
    'df.write_csv("out.csv")',
    'print(pl.__version__, df.shape)',
  ].join('; ')
  probes.push(
    [
      'polars_in_process',
      async () => {
        const bash = await shell(sci)
        const result = await bash.exec(
          "cd /home/user && python3 -c '" + script + "' && cat out.csv",
        )
        return /^1\.33\.1 \(0, 2\)\na,b\n$/.test(result.stdout) ? true : JSON.stringify(result)
      },
    ],
    [
      'polars_worker',
      async () => {
        const binding = {
          fetch: (input: string, init?: RequestInit) =>
            PythonSci.serve(new Request(input, init), sci),
        }
        const bash = await shell(PythonSci.remote(binding), 'async')
        const result = await bash.exec(
          "cd /home/user && python3 -c '" + script + "' && cat out.csv",
        )
        return /^1\.33\.1 \(0, 2\)\na,b\n$/.test(result.stdout) ? true : JSON.stringify(result)
      },
    ],
  )
}

let failed = 0
for (const [name, probe] of probes) {
  const started = performance.now()
  const outcome = await probe().catch((error: unknown) => String((error as Error)?.stack ?? error))
  if (outcome !== true) failed++
  console.log(
    JSON.stringify({
      name,
      ok: outcome === true,
      ms: Math.round(performance.now() - started),
      out: outcome === true ? undefined : outcome.slice(-600),
    }),
  )
}
console.log(probes.length - failed + '/' + probes.length)
process.exit(failed ? 1 : 0)
