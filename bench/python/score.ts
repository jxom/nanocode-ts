import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Bash, MemoryFileSystem } from '../../src/bash/index.ts'

const root = process.env.CAPI ?? join(process.env.HOME ?? '', 'rpw/capi')
const module = new WebAssembly.Module(readFileSync(process.argv[2] ?? 'dist/python.wasm'))
const psh = new WebAssembly.Module(readFileSync('dist/psh.wasm'))
const kept = new Set(['tokio', 'mio', 'socket2', 'futures-core', 'futures-sink', 'futures-task', 'futures-util', 'futures-channel', 'futures-io', 'futures-macro', 'tracing', 'tracing-core', 'slab', 'pin-project-lite', 'serde', 'serde_core', 'serde_derive', 'syn', 'quote', 'proc-macro2', 'unicode-ident', 'libc', 'wasi', 'windows-sys', 'windows-link', 'bytes', 'rustls-pki-types', 'zeroize'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

// A wheel's Python files (and, with data, its other files but compiled
// modules) under /site, as site-packages holds them.
const data = (path: string) => !path.endsWith('.so') && !path.includes('.dist-info') && !path.includes('.libs/') && !path.includes('/tests/baseline_images/')
async function copy(fs: ReturnType<typeof MemoryFileSystem.create>, bash: Awaited<ReturnType<typeof Bash.create>>, base: string, keep = (path: string) => path.endsWith('.py')) {
  const files = walk(base).filter((path) => !path.includes('.dist-info') && !path.includes('.libs/') && keep(path))
  const dirs = [...new Set(files.map((path) => ('/site/' + relative(base, path)).replace(/\/[^/]*$/, '')))]
  if (dirs.length) await bash.exec('mkdir -p ' + dirs.join(' '))
  for (const path of files) await fs.write('/site/' + relative(base, path), readFileSync(path))
}
// Packages whose modules import other wheels' Python code or data files.
const needs: Record<string, string[]> = { matplotlib: ['pillow', 'kiwisolver', 'contourpy', '../deps'] }
const frozen = new Set(['pandas'])

const packages = readdirSync(join(root, 'x')).sort()
const rows: { name: string; extensions: number; imported: number }[] = []
for (const name of packages) {
  const base = join(root, 'x', name)
  const files = walk(base).filter((path) => !path.includes('.dist-info') && !path.includes('.libs/'))
  const extensions = files.filter((path) => path.endsWith('.so')).map((path) => relative(base, path).split('.')[0]!.replaceAll('/', '.'))
  const fs = MemoryFileSystem.create()
  const bash = await Bash.create({ fs, cwd: '/workspace', psh, python: { module, stepsPerMs: 42000 }, limits: { timeoutMs: 60000 } })
  await bash.exec('mkdir -p /workspace /site')
  if (!frozen.has(name)) await copy(fs, bash, base, needs[name] ? data : undefined)
  for (const other of needs[name] ?? []) await copy(fs, bash, join(root, 'x', other), data)
  await fs.write('/workspace/probe.py', new TextEncoder().encode('import importlib, sys\nsys.path.insert(0, "/site")\nok = 0\nfor name in sys.argv[1:]:\n    try:\n        ok += not getattr(importlib.import_module(name), "__file__", "").endswith(".py")\n    except BaseException:\n        pass\nprint(ok)\n'))
  const result = await bash.exec('python3 probe.py ' + extensions.join(' '))
  rows.push({ name, extensions: extensions.length, imported: Number(result.stdout.trim()) || 0 })
}

const symbols = readFileSync(join(root, 'freq.txt'), 'utf8').trim().split('\n').map((line) => line.trim().split(/\s+/).pop()!)
const exported = new Set(WebAssembly.Module.exports(module).map((entry) => entry.name))
const lock = readFileSync('python/Cargo.lock', 'utf8')
const external = [...lock.matchAll(/name = "([^"]+)"\nversion = "[^"]+"\nsource = "registry/g)].map((match) => match[1]!).filter((name) => !kept.has(name))
const limits = await (async () => {
  const fs = MemoryFileSystem.create()
  const bash = await Bash.create({ fs, python: { module, stepsPerMs: 42000 }, limits: { maxMemoryBytes: 48 << 20, timeoutMs: 2000 } })
  const checks: [string, number][] = [['python3 -c "print(1)"', 0], ['python3 -c "s=\'a \'*30000000; print(len(s.split()))"', 126], ['python3 -c "while True: pass"', 124], ['python3 -c "import json; json.loads(\'x\')"', 1]]
  let passed = 0
  for (const [script, status] of checks) if ((await bash.exec(script)).exitCode === status) passed++
  return passed + '/' + checks.length
})()
const numpy = await (async () => {
  const fs = MemoryFileSystem.create()
  const bash = await Bash.create({ fs, cwd: '/workspace', psh, python: { module, stepsPerMs: 42000 }, limits: { timeoutMs: 120000 } })
  const checks: [string, string][] = [
    ['np.linspace(0, 1, 5)', '[0.   0.25 0.5  0.75 1.  ]'],
    ['np.sin(np.linspace(0, np.pi, 3)).round(6)', '[0. 1. 0.]'],
    ['np.arange(12).reshape(3, 4).sum(axis=0)', '[12 15 18 21]'],
    ['np.arange(6).reshape(2, 3) + np.array([10, 20, 30])', '[[10 21 32]\n [13 24 35]]'],
    ['np.array([1.5, 2.7]).astype(int)', '[1 2]'],
    ['np.array(["1", "2"]).astype(float)', '[1. 2.]'],
    ['np.linalg.solve(np.array([[3.0, 1.0], [1.0, 2.0]]), [9.0, 8.0])', '[2. 3.]'],
    ['np.linalg.det(np.array([[3.0, 1.0], [1.0, 2.0]])).round(6)', '5.0'],
    ['np.linalg.inv(np.array([[3.0, 1.0], [1.0, 2.0]])).round(4)', '[[ 0.4 -0.2]\n [-0.2  0.6]]'],
    ['np.linalg.eig(np.array([[2.0, 0.0], [0.0, 3.0]]))[0]', '[2.+0.j 3.+0.j]'],
    ['np.random.default_rng(0).normal(size=3)', '[ 0.12573022 -0.13210486  0.64042265]'],
    ['np.fft.fft(np.array([1.0, 2.0, 3.0, 4.0]))', '[10.+0.j -2.+2.j -2.+0.j -2.-2.j]'],
    ['np.unique([3, 1, 3, 2])', '[1 2 3]'],
    ['np.char.upper(np.array(["ab"]))', "['AB']"],
  ]
  const script = 'import numpy as np\n' + checks.map(([expression]) => 'print(str(' + expression + '), end="\\0")').join('\n') + '\n'
  await fs.write('/workspace/numpy_check.py', new TextEncoder().encode(script))
  const outputs = (await bash.exec('python3 numpy_check.py')).stdout.split('\0')
  return checks.filter(([, expected], index) => outputs[index] === expected).length + '/' + checks.length
})()
const plots = await (async () => {
  // matplotlib (Agg, ft2font, _path, _tri, _image), Pillow (core, ImageMath,
  // ImageMorph, the PNG codec) and contourpy, with their pure-Python
  // requirements from $CAPI/deps; each expected value is what CPython 3.13
  // prints with the same wheels.
  const fs = MemoryFileSystem.create()
  const bash = await Bash.create({ fs, cwd: '/workspace', psh, python: { module, stepsPerMs: 42000 }, limits: { timeoutMs: 300000 } })
  await bash.exec('mkdir -p /workspace /site /tmp')
  for (const base of ['matplotlib', 'pillow', 'contourpy', 'kiwisolver'].map((name) => join(root, 'x', name)).concat(join(root, 'deps'))) await copy(fs, bash, base, data)
  const checks: [string, string, string][] = [
    ['matplotlib', 'Path([(0, 0), (1, 0), (1, 1), (0, 1)]).contains_point((0.5, 0.5))', 'True'],
    ['matplotlib', 'tuple(float(v) for v in Path([(0, 0), (1, 1), (2, 0)]).get_extents().bounds)', '(0.0, 0.0, 2.0, 1.0)'],
    ['matplotlib', 'Affine2D().rotate_deg(90).transform([[1.0, 0.0]]).round(6)', '[[0. 1.]]'],
    ['matplotlib', 'Triangulation([0, 1, 0, 1], [0, 0, 1, 1]).triangles.shape', '(2, 3)'],
    ['matplotlib', 'figure_hash()', '04a16b00a678a551'],
    ['matplotlib', 'contour_hash()', '02c0efaa974a7972'],
    ['pillow', 'Image.new("RGB", (4, 4), "red").getpixel((0, 0))', '(255, 0, 0)'],
    ['pillow', 'Image.linear_gradient("L").filter(ImageFilter.GaussianBlur(2)).getpixel((5, 100))', '100'],
    ['pillow', 'ImageMath.lambda_eval(lambda a: a["x"] * 2, x=Image.new("L", (2, 2), 7)).getpixel((0, 0))', '14'],
    ['pillow', 'ImageMorph.MorphOp(op_name="erosion4").apply(Image.new("L", (5, 5), 255))[0]', '0'],
    ['pillow', 'hashlib.sha256(png_bytes()).hexdigest()[:16]', '0e578415339aecf5'],
    ['pillow', 'Image.open(io.BytesIO(png_bytes())).convert("L").getpixel((10, 32))', '130'],
    ['contourpy', '[len(line) for line in contourpy.contour_generator(z=np.array([[0.0, 1.0], [1.0, 2.0]])).lines(1.0)]', '[2]'],
    ['contourpy', 'contourpy.contour_generator(z=np.arange(9.0).reshape(3, 3), name="serial").filled(1.0, 5.0)[0][0].shape', '(10, 2)'],
    ['kiwisolver', 'solve()', '(7.0, 3.0)'],
  ]
  const script = [
    'import hashlib, io, os, sys',
    'sys.path.insert(0, "/site")',
    'os.environ["MPLCONFIGDIR"] = "/tmp/matplotlib"',
    'def run(expression):',
    '    try:',
    '        return str(eval(expression))',
    '    except BaseException as error:',
    '        return "error: " + type(error).__name__ + ": " + str(error)',
    'try:',
    '    import numpy as np, matplotlib',
    '    matplotlib.use("Agg")',
    '    import matplotlib.pyplot as plt',
    '    from matplotlib.path import Path',
    '    from matplotlib.transforms import Affine2D',
    '    from matplotlib.tri import Triangulation',
    'except BaseException as error:',
    '    print("matplotlib:", type(error).__name__, error, file=sys.stderr)',
    'try:',
    '    from PIL import Image, ImageFilter, ImageMath, ImageMorph',
    '    import contourpy, kiwisolver',
    'except BaseException as error:',
    '    print("pillow, contourpy, kiwisolver:", type(error).__name__, error, file=sys.stderr)',
    'def figure_hash():',
    '    x = np.linspace(0, 2 * np.pi, 200)',
    '    figure, axes = plt.subplots(figsize=(4, 3), dpi=50)',
    '    axes.plot(x, np.sin(x)); axes.set_title("sine")',
    '    figure.canvas.draw()',
    '    return hashlib.sha256(bytes(figure.canvas.buffer_rgba())).hexdigest()[:16]',
    'def contour_hash():',
    '    y, x = np.mgrid[-2:2:40j, -2:2:40j]',
    '    figure, axes = plt.subplots(figsize=(3, 3), dpi=40)',
    '    axes.contourf(x, y, np.exp(-x * x - y * y), levels=5); axes.imshow(np.arange(16.0).reshape(4, 4), extent=(-2, -1, -2, -1))',
    '    figure.canvas.draw()',
    '    return hashlib.sha256(bytes(figure.canvas.buffer_rgba())).hexdigest()[:16]',
    'def png_bytes():',
    '    out = io.BytesIO(); Image.linear_gradient("L").resize((64, 64)).convert("RGB").save(out, "PNG"); return out.getvalue()',
    'def solve():',
    '    a, b = kiwisolver.Variable("a"), kiwisolver.Variable("b")',
    '    solver = kiwisolver.Solver(); solver.addConstraint(a + b == 10); solver.addConstraint(a - b == 4); solver.updateVariables()',
    '    return (a.value(), b.value())',
    ...checks.map(([, expression]) => 'print(run(' + JSON.stringify(expression) + '), end="\\0")'),
    '',
  ].join('\n')
  await fs.write('/workspace/plots_check.py', new TextEncoder().encode(script))
  const result = await bash.exec('python3 plots_check.py')
  const outputs = result.stdout.split('\0')
  const groups: Record<string, string> = {}
  for (const group of new Set(checks.map(([name]) => name))) {
    const mine = checks.map((check, index) => [check, outputs[index]] as const).filter(([[name]]) => name === group)
    groups[group] = mine.filter(([[, , expected], output]) => output === expected).length + '/' + mine.length
  }
  if (process.env.SCORE_VERBOSE) checks.forEach(([, expression, expected], index) => outputs[index] !== expected && console.error(expression, '=>', JSON.stringify(outputs[index]), 'expected', JSON.stringify(expected), result.stderr.slice(-400)))
  return groups
})()
const pandas = await (async () => {
  const fs = MemoryFileSystem.create()
  const bash = await Bash.create({ fs, cwd: '/workspace', psh, python: { module, stepsPerMs: 42000 }, limits: { timeoutMs: 120000 } })
  const checks: [string, string][] = [
    ["df.groupby('k')['v'].sum().tolist()", "[3.0, 5.0, 7.0]"],
    ["df.groupby('k').agg(n=('v', 'size'), m=('v', 'mean')).to_dict()", "{'n': {'a': 2, 'b': 2, 'c': 2}, 'm': {'a': 1.5, 'b': 2.5, 'c': 3.5}}"],
    ["df.merge(pd.DataFrame({'k': ['a', 'b'], 'w': [10, 20]}), on='k', how='left')['w'].tolist()", "[10.0, 20.0, nan, 10.0, 20.0, nan]"],
    ["df.set_index('d')['v'].resample('2D').mean().tolist()", "[0.5, 2.5, 4.5]"],
    ["df['v'].rolling(3).mean().round(3).tolist()", "[nan, nan, 1.0, 2.0, 3.0, 4.0]"],
    ["pd.read_csv(io.StringIO('a,b,c\\n1,x,2024-01-02\\n2,y,2024-02-03\\n'), parse_dates=['c'])['c'].dt.month.tolist()", "[1, 2]"],
    ["str(pd.Timestamp('2024-03-01 12:00') + pd.Timedelta(hours=5))", "2024-03-01 17:00:00"],
    ["df.pivot_table(index='k', values='v', aggfunc='mean').to_dict()", "{'v': {'a': 1.5, 'b': 2.5, 'c': 3.5}}"],
    ["round(float(df['v'].std()), 6)", "1.870829"],
    ["pd.Series([1, None, 3]).fillna(0).tolist()", "[1.0, 0.0, 3.0]"],
    ["df.to_json()[:40]", "{\"k\":{\"0\":\"a\",\"1\":\"b\",\"2\":\"c\",\"3\":\"a\",\"4"],
    ["df.sort_values('v', ascending=False).head(2).index.tolist()", "[5, 4]"],
  ]
  const script = 'import io, warnings\nwarnings.simplefilter("ignore")\nimport numpy as np, pandas as pd\ndf = pd.DataFrame({"k": list("abcabc"), "v": np.arange(6.0), "d": pd.date_range("2024-01-01", periods=6, freq="D")})\n' + checks.map(([expression]) => 'print(str(' + expression + '), end="\\0")').join('\n') + '\n'
  await fs.write('/workspace/pandas_check.py', new TextEncoder().encode(script))
  const outputs = (await bash.exec('python3 pandas_check.py')).stdout.split('\0')
  return checks.filter(([, expected], index) => outputs[index] === expected).length + '/' + checks.length
})()
const imported = rows.reduce((sum, row) => sum + row.imported, 0)
const extensions = rows.reduce((sum, row) => sum + row.extensions, 0)
console.log(JSON.stringify({ imported, extensions, packages: rows.filter((row) => row.extensions && row.imported === row.extensions).length + '/' + rows.length, capi: symbols.filter((symbol) => exported.has(symbol)).length + '/' + symbols.length, bytes: statSync(process.argv[2] ?? 'dist/python.wasm').size, external: external.length, externalCrates: external, limits, numpy, pandas, plots, rows }))
