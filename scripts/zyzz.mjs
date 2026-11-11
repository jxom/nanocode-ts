import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const scope = /\.z(?:-theme-|_scheme-)[\w-]+\{[^{}]*\}/g

rmSync('output/zyzz-ui', { force: true, recursive: true })
const result = spawnSync(
  'npx',
  [
    'zyzz',
    'build',
    'dist/ui',
    '--out-dir',
    'output/zyzz-ui',
    '--package-id',
    'nanocode-ts',
    '--minify',
    '--external',
    'react',
    '--external',
    'react/*',
    '--external',
    '../*',
  ],
  { stdio: 'inherit' },
)
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

for (const file of readdirSync('output/zyzz-ui', { recursive: true, withFileTypes: true })) {
  if (!file.isFile() || !file.name.endsWith('.js') || file.name === 'zyzz.js') continue
  const source = join(file.parentPath, file.name)
  const target = join('dist/ui', relative('output/zyzz-ui', source))
  const css = readFileSync(source + '.css', 'utf8').replace(scope, '')
  writeFileSync(target, readFileSync(source, 'utf8') + (css ? `import './${file.name}.css'\n` : ''))
  copyFileSync(source + '.map', target + '.map')
  if (css) writeFileSync(target + '.css', css)
  if (existsSync(source + '.zyzz.json')) copyFileSync(source + '.zyzz.json', target + '.zyzz.json')
}
