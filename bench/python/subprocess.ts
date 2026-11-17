import { readFileSync } from 'node:fs'
import { Bash, MemoryFileSystem } from '../../src/bash/index.ts'

const module = new WebAssembly.Module(readFileSync(process.argv[2] ?? 'dist/python.wasm'))
const psh = new WebAssembly.Module(readFileSync('dist/psh.wasm'))

const probes: readonly (readonly [string, string, RegExp])[] = [
  [
    'git_ls_files',
    'import subprocess\nr = subprocess.run(["git", "ls-files"], capture_output=True, text=True)\nprint(r.returncode, sorted(r.stdout.split()), repr(r.stderr))',
    /^0 \['README\.md', 'src\/a\.ts', 'src\/big\.ts'\] ''$/,
  ],
  [
    'check_output_text',
    'import subprocess\nprint(subprocess.check_output("ls src | wc -l", shell=True, text=True).strip())\nprint(subprocess.check_output(["echo", "a b", "c\'d"]).decode().strip())',
    /^2\na b c'd$/,
  ],
  [
    'called_process_error',
    'import subprocess\ntry:\n    subprocess.check_output(["grep", "nomatch", "README.md"])\nexcept subprocess.CalledProcessError as e:\n    print("status", e.returncode, e.cmd)\ntry:\n    subprocess.run("exit 3", shell=True, check=True)\nexcept subprocess.CalledProcessError as e:\n    print("status", e.returncode)',
    /^status 1 \['grep', 'nomatch', 'README\.md'\]\nstatus 3$/,
  ],
  [
    'os_system',
    'import os, sys\nprint(os.system("true"), os.system("exit 2"))\nsys.stdout.flush()\nprint(os.system("echo hi"))',
    /^0 512\nhi\n0$/,
  ],
  [
    'os_popen',
    'import os\nwith os.popen("wc -c < src/big.ts") as f:\n    print(f.read().strip())\nprint(os.popen("exit 4").close())',
    /^3000\n1024$/,
  ],
  [
    'input_cwd_env',
    'import os, subprocess\nprint(subprocess.run(["tr", "a-z", "A-Z"], input="hello", capture_output=True, text=True).stdout)\nprint(subprocess.run("pwd", shell=True, cwd="src", capture_output=True, text=True).stdout.strip())\nprint(subprocess.run("echo $GREETING", shell=True, env={**os.environ, "GREETING": "hey"}, capture_output=True, text=True).stdout.strip())',
    /^HELLO\n\/workspace\/repo\/src\nhey$/,
  ],
  [
    'popen_communicate',
    'import subprocess\np = subprocess.Popen(["git", "ls-files", "src"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)\nout, err = p.communicate()\nprint(p.wait(), out.split())\nprint(subprocess.getstatusoutput("cat nofile")[0], subprocess.getoutput("echo  x"))',
    /^0 \['src\/a\.ts', 'src\/big\.ts'\]\n1 x$/,
  ],
  [
    'writes_then_command',
    'import os, subprocess\nos.mkdir("out")\nopen("out/log.txt", "a").write("one\\n")\nprint(subprocess.check_output(["cat", "out/log.txt"], text=True).strip())\nsubprocess.run("echo two >> out/log.txt", shell=True)\nprint(open("out/log.txt").read().split())\nprint(sorted(os.listdir("out")), subprocess.check_output("ls out", shell=True, text=True).split())',
    /^one\n\['one', 'two'\]\n\['log\.txt'\] \['log\.txt'\]$/,
  ],
  [
    'missing_program',
    'import subprocess\ntry:\n    subprocess.run(["nosuchprogram_xyz"])\nexcept FileNotFoundError as e:\n    print("missing", e.filename)',
    /^missing nosuchprogram_xyz$/,
  ],
  [
    'chart_largest',
    'import os, subprocess\nimport matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\nfiles = subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout.split()\nsizes = sorted(((os.path.getsize(f), f) for f in files), reverse=True)\nplt.barh([f for _, f in sizes], [s for s, _ in sizes])\nplt.savefig("sizes.png")\nprint(sizes[0], os.path.getsize("sizes.png") > 5000)',
    /^\(3000, 'src\/big\.ts'\) True$/,
  ],
]

function hidden(fs: ReturnType<typeof MemoryFileSystem.create>) {
  return new Proxy(fs, {
    get(target, key) {
      if (key === 'sync') return undefined
      const value = (target as unknown as Record<PropertyKey, unknown>)[key]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

async function shell(kind: 'sync' | 'async', engine: 'psh' | 'ts') {
  const memory = MemoryFileSystem.create()
  const bash = await Bash.create({
    fs: kind === 'sync' ? memory : hidden(memory),
    cwd: '/workspace/repo',
    ...(engine === 'psh' ? { psh } : {}),
    python: { module, cpuMs: 60000, stepsPerMs: 42000 },
    limits: { maxMemoryBytes: 256 << 20, timeoutMs: 120000 },
  })
  await bash.exec(
    'mkdir -p /workspace/repo/src && cd /workspace/repo && git init -q && echo hello > README.md && echo a > src/a.ts && head -c 3000 /dev/zero | tr "\\0" x > src/big.ts && git add . && git commit -qm init',
  )
  return bash
}

let failed = 0
for (const kind of ['sync', 'async'] as const)
  for (const engine of ['psh', 'ts'] as const)
    for (const [name, code, expected] of probes) {
      if (process.argv[3] && !name.includes(process.argv[3])) continue
      const bash = await shell(kind, engine)
      await bash.writeFile('/workspace/repo/probe.py', code)
      const started = performance.now()
      const result = await bash.exec('python3 probe.py')
      const out = (result.stdout + result.stderr).trim()
      const ok = expected.test(out)
      if (!ok) failed++
      console.log(
        JSON.stringify({
          kind,
          engine,
          name,
          ok,
          ms: Math.round(performance.now() - started),
          out: ok ? undefined : out.slice(-600),
        }),
      )
    }
process.exit(failed ? 1 : 0)
