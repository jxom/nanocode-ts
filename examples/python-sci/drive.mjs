// Runs a script on a python-sci Worker n times with a CSV beside it: node drive.mjs <url> <script.py> <data.csv> [n]
import * as Fs from 'node:fs'
import * as Path from 'node:path'
const [url, script, csv, n] = process.argv.slice(2)
const files = [
  ['/workspace/' + Path.basename(csv), Fs.readFileSync(csv)],
  ['/workspace/t.py', Fs.readFileSync(script)],
]
const header = Buffer.from(
  JSON.stringify({
    argv: ['t.py'],
    cwd: '/workspace',
    files: files.map(([path, bytes]) => [path, bytes.length]),
  }),
)
const length = Buffer.alloc(4)
length.writeUInt32LE(header.length)
const body = Buffer.concat([length, header, ...files.map(([, bytes]) => bytes)])
for (let i = 0; i < Number(n || 3); i++) {
  const started = performance.now()
  const raw = Buffer.from(await (await fetch(url, { method: 'POST', body })).arrayBuffer())
  const out = JSON.parse(raw.subarray(4, 4 + raw.readUInt32LE(0)).toString())
  console.log(
    JSON.stringify({
      i,
      wallMs: Math.round(performance.now() - started),
      ...out,
      stdout: out.stdout.slice(-80),
      stderr: out.stderr.slice(-160),
    }),
  )
}
