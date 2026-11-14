import * as ChildProcess from 'node:child_process'
import * as Fs from 'node:fs'
import * as Http from 'node:http'
import * as Path from 'node:path'

type Row = { [key: string]: number | string | boolean | undefined }

const arg = (name: string, fallback: string) => process.argv.find((a) => a.startsWith('--' + name + '='))?.slice(name.length + 3) ?? fallback

const dir = Path.resolve(arg('dir', 'output/bench/sla/dashboard'))
const host = arg('host', '127.0.0.1')
const port = Number(arg('port', '8830'))
const interval = Number(arg('interval', '900000'))
const lock = arg('lock', Path.join(dir, 'live.lock'))
const span = Number(arg('window', '86400000'))
const worker = arg('worker', 'https://nanocode-cloudflare-durable.tempo-dev.workers.dev/')
const turns = Number(arg('turns', '3'))
const settle = arg('settle', '3000')
const timeout = Number(arg('timeout', '60000'))
const codexModel = arg('codex-model', 'gpt-6-luna')
const claudeModel = arg('claude-model', 'claude-haiku-5-5')
const coldGate = Number(arg('cold-gate', '500'))
const warmGate = Number(arg('warm-gate', '50'))
const samplesFile = Path.join(dir, 'samples.jsonl')
const cyclesFile = Path.join(dir, 'cycles.jsonl')
const tempfail = 75

const lanes = arg('lanes', 'live-nc-codex@now,live-codex,live-nc-claude@now,live-claude').split(',').filter(Boolean)

const workers = arg('workers', 'claude:' + claudeModel + ',codex:' + codexModel + ',codex:glm-5.3')
  .split(',')
  .filter(Boolean)
  .map((entry) => {
    const [provider, model] = entry.split(':')
    if (!provider || !model) throw new Error('worker entry must be provider:model, got ' + entry)
    return { model, provider }
  })

const native: { [kind: string]: { model: string; name: string; pair: string } } = {
  'live-claude': { model: claudeModel, name: 'Claude Code · ' + claudeModel, pair: 'claude' },
  'live-codex': { model: codexModel, name: 'Codex CLI · ' + codexModel, pair: 'codex' },
  'live-nc-claude': { model: claudeModel, name: 'nanocode · ' + claudeModel, pair: 'claude' },
  'live-nc-codex': { model: codexModel, name: 'nanocode · ' + codexModel, pair: 'codex' },
}

const kind = (lane: unknown) => {
  const entry = native[String(lane).split('@')[0]!]
  if (!entry) throw new Error('unknown native lane ' + lane)
  return entry
}

const append = (file: string, rows: readonly Row[]) => Fs.appendFileSync(file, rows.map((row) => JSON.stringify(row) + '\n').join(''))

const read = (file: string): Row[] => (Fs.existsSync(file) ? Fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])

const pct = (values: readonly number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil((p / 100) * sorted.length) - 1]
}

const timing = (row: Row): { [name: string]: number } =>
  Object.fromEntries(
    String(row.timing ?? '')
      .split(',')
      .map((part) => part.trim().match(/^([\w-]+);dur=([\d.]+)$/))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [match[1]!, Number(match[2])]),
  )

async function probe(provider: string, model: string, cycle: string): Promise<Row[]> {
  const session = 'sla-dash-' + provider + '-' + Date.now().toString(36)
  const visitor = 'sla-dash-' + Math.random().toString(16).slice(2, 8)
  const prompt = 'Count from 1 to 150, separated by spaces, nothing else.'
  const rows: Row[] = []
  for (let turn = 1; turn <= turns; turn++) {
    const row: Row = { at: Date.now(), cycle, lane: 'worker-' + provider + '@' + model, model, name: 'Worker · ' + model, pair: provider, source: 'worker', turn }
    const t0 = performance.now()
    try {
      const res = await fetch(new URL('sessions/' + session + '/turns?live=1', worker), { body: JSON.stringify({ model, prompt: prompt + ' (' + session + '-' + turn + ')', provider, request_id: 'turn-' + turn }), headers: { accept: 'text/event-stream', 'content-type': 'application/json', 'x-nanocode-visitor': visitor }, method: 'POST', signal: AbortSignal.timeout(timeout) })
      row.headers = Math.round(performance.now() - t0)
      row.http = res.status
      row.timing = res.headers.get('server-timing') ?? undefined
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let result: any
      while (!result) {
        const next = await reader.read()
        if (next.done) break
        buffer += decoder.decode(next.value, { stream: true })
        const cut = buffer.lastIndexOf('\n\n')
        if (cut < 0) continue
        const at = Math.round(performance.now() - t0)
        for (const block of buffer.slice(0, cut).split('\n\n')) {
          const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5)).join('')
          if (!data) continue
          const parsed = JSON.parse(data)
          const event = parsed.event?.event
          if (event?.type === 'assistant.delta' && String(event.payload?.text ?? event.payload?.delta ?? '').length) row.ttft ??= at
          if (parsed.event?.type === 'result') result = parsed.event
        }
        buffer = buffer.slice(cut + 2)
      }
      reader.cancel().catch(() => {})
      const timing = result?.timing ?? {}
      const request = (timing.model_requests ?? []).filter((entry: any) => entry.provider).at(-1) ?? {}
      Object.assign(row, { admission: timing.admission_ms, model_headers: request.headers_ms && Math.round(request.headers_ms), model_start: request.started_ms && Math.round(request.started_ms), open: timing.runtime_open_ms, status: result?.status })
      if (row.ttft === undefined) row.error = 'no delta: http ' + res.status + ', result ' + (result?.status ?? 'missing')
    } catch (error) {
      row.error = String(error)
    }
    rows.push(row)
  }
  return rows
}

async function cycle() {
  const id = new Date().toISOString()
  const started = Date.now()
  const out = Path.join(dir, 'native')
  const label = 'cycle-' + id.replace(/[^0-9A-Za-z]/g, '')
  const version = ChildProcess.spawnSync(process.env.NC_BIN_NOW!, ['--version'], { encoding: 'utf8' }).stdout.trim()
  for (const lane of lanes) kind(lane)
  const run = lanes.length === 0 ? undefined : ChildProcess.spawnSync(process.execPath, [Path.join(import.meta.dirname, 'run.ts'), '--live', '--lanes=' + lanes.join(','), '--codex-model=' + codexModel, '--claude-model=' + claudeModel, '--samples=1', '--turns=' + turns, '--settle=' + settle, '--timeout=' + timeout, '--label=' + label, '--out=' + out], { encoding: 'utf8' })
  ChildProcess.spawnSync('pkill', ['-f', Path.join(out, 'work') + '/'])
  const nativeRows = read(Path.join(out, label + '.jsonl')).flatMap((sample) => (sample.turn === undefined ? Array.from({ length: turns }, (_, index) => ({ ...sample, turn: index + 1 })) : [sample])).map((sample): Row => ({ at: started, cycle: id, error: sample.error, lane: sample.lane, model: kind(sample.lane).model, name: kind(sample.lane).name, pair: kind(sample.lane).pair, ready: sample.ready, source: 'native', ttft: sample.e2e, turn: sample.turn }))
  append(samplesFile, nativeRows)
  const nativeDone = Date.now()
  const workerRows: Row[] = []
  for (const entry of workers) workerRows.push(...(await probe(entry.provider, entry.model, id)))
  append(samplesFile, workerRows)
  const rows = [...nativeRows, ...workerRows]
  append(cyclesFile, [{ at: started, cycle: id, errors: rows.filter((row) => row.error).length, exit: run ? (run.status ?? String(run.signal)) : undefined, native_ms: nativeDone - started, rows: rows.length, status: 'done', total_ms: Date.now() - started, version }])
  console.log(id, 'rows', rows.length, 'errors', rows.filter((row) => row.error).length, 'native_ms', nativeDone - started, 'total_ms', Date.now() - started)
}

function schedule(log: number) {
  const at = Date.now()
  const child = ChildProcess.spawn('flock', ['-n', '-E', String(tempfail), lock, process.execPath, import.meta.filename, '--cycle', ...process.argv.slice(2)], { stdio: ['ignore', log, log] })
  child.on('exit', (code, signal) => {
    if (code === tempfail) append(cyclesFile, [{ at, status: 'skipped' }])
    else if (code !== 0) append(cyclesFile, [{ at, exit: code ?? String(signal), status: 'failed' }])
    setTimeout(() => schedule(log), interval)
  })
}

function data(window: number) {
  const since = Date.now() - window
  const samples = read(samplesFile)
  const cycles = read(cyclesFile)
  const recent = samples.filter((row) => Number(row.at) >= since)
  const cells: { [key: string]: Row[] } = {}
  for (const row of recent) (cells[row.lane + '|' + row.turn] ??= []).push(row)
  const summary = Object.values(cells).map((rows) => {
    const ok = rows.filter((row) => !row.error)
    const of = (values: readonly unknown[]) => {
      const numbers = values.filter((value): value is number => typeof value === 'number')
      return numbers.length ? { n: numbers.length, p50: pct(numbers, 50), p99: pct(numbers, 99) } : undefined
    }
    const stats = (metric: string) => of(ok.map((row) => row[metric]))
    const split = ok.map((row) => ({ ...timing(row), model_headers: row.model_headers, model_start: row.model_start }))
    const names = [...new Set(split.flatMap((entry) => Object.keys(entry)))]
    const splits = rows[0]!.source === 'worker' ? Object.fromEntries(names.map((name) => [name, of(split.map((entry) => entry[name as keyof typeof entry]))])) : undefined
    return { errors: rows.length - ok.length, headers: stats('headers'), lane: rows[0]!.lane, model: rows[0]!.model, name: rows[0]!.name, pair: rows[0]!.pair, source: rows[0]!.source, splits, ttft: stats('ttft'), turn: rows[0]!.turn }
  })
  const measured = new Set(recent.filter((row) => row.source === 'native' && !row.error).map((row) => row.pair))
  const missing = [...new Set(Object.values(native).map((entry) => entry.pair))].filter((pair) => !measured.has(pair)).map((pair) => ({ configured: lanes.filter((lane) => kind(lane).pair === pair), errors: recent.filter((row) => row.pair === pair && row.source === 'native' && row.error).map((row) => String(row.error)).slice(-1)[0], pair }))
  const done = cycles.filter((entry) => entry.status === 'done')
  const latest = done.at(-1)
  return {
    cycles: cycles.slice(-24),
    gate: { cold: coldGate, warm: warmGate },
    interval,
    lanes,
    missing,
    latest: latest ? { cycle: latest, rows: samples.filter((row) => row.cycle === latest.cycle) } : undefined,
    now: Date.now(),
    series: recent.filter((row) => !row.error).map((row) => ({ at: row.at, cycle: row.cycle, headers: row.headers, lane: row.lane, model: row.model, name: row.name, source: row.source, ttft: row.ttft, turn: row.turn })),
    workers,
    summary,
    window,
  }
}

const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>nanocode TTFT</title><meta name="viewport" content="width=device-width">
<style>
body{font:14px ui-monospace,Menlo,monospace;background:#111;color:#ddd;margin:24px}
h1{font-size:18px}h2{font-size:15px;margin-top:28px}
table{border-collapse:collapse}td,th{padding:3px 10px;border-bottom:1px solid #333;text-align:right}td:first-child,th:first-child{text-align:left}
.err{color:#e66}.dim{color:#888}.win{color:#6c6}.lose{color:#e96}
svg{background:#181818;margin:6px 12px 6px 0}
.legend span{margin-right:16px}
</style></head><body>
<h1>nanocode TTFT: Enter to first token drawn (native), POST to first delta (Worker)</h1>
<div id="meta" class="dim"></div>
<div>window: <select id="win"><option value="3600000">1 h</option><option value="21600000">6 h</option><option value="86400000" selected>24 h</option><option value="604800000">7 d</option><option value="31536000000">all</option></select></div>
<h2>Rolling p50 / p99 ms (n)</h2><div id="missing" class="err"></div><div id="summary"></div>
<h2>Worker gate</h2><div id="gate"></div><div id="workercharts"></div>
<h2>Time series (ms)</h2><div class="legend" id="legend"></div><div id="charts"></div>
<h2>Latest run</h2><div id="latest"></div>
<h2>Cycles</h2><div id="cycles"></div>
<script>
const colors=['#4fa3ff','#ff7a59','#7bd88f','#f2c14e','#c792ea','#5ad1d1','#ff5c8a','#aaaaaa']
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[c])
const time=t=>new Date(t).toLocaleString()
async function load(){
  const d=await (await fetch('data.json?window='+document.getElementById('win').value)).json()
  const pairOf=Object.fromEntries(d.summary.map(s=>[s.lane,s.pair]))
  const lanes=[...new Set(d.summary.map(s=>s.lane))].sort((a,b)=>(pairOf[a]+a).localeCompare(pairOf[b]+b))
  const names=Object.fromEntries(d.summary.map(s=>[s.lane,s.name]))
  const turns=[...new Set(d.summary.map(s=>s.turn))].sort((a,b)=>a-b)
  const color=Object.fromEntries(lanes.map((l,i)=>[l,colors[i%colors.length]]))
  const cell=(lane,turn)=>d.summary.find(s=>s.lane===lane&&s.turn===turn)
  const isNative=s=>s.source!=='worker'
  const sign=v=>(v>0?'+':'')+Math.round(v)
  const rivalsOf=s=>d.summary.filter(o=>o.pair===s.pair&&o.turn===s.turn&&o.lane!==s.lane&&o.ttft&&isNative(o))
  const ncOf=s=>d.summary.find(o=>o.model===s.model&&o.turn===s.turn&&isNative(o)&&o.lane.startsWith('live-nc-')&&o.ttft)
  const best=(s,q)=>{const r=rivalsOf(s);if(!s.ttft||!r.length)return '';return r.every(o=>s.ttft[q]<o.ttft[q])?'win':'lose'}
  const lead=(s,q)=>{const r=rivalsOf(s);return r.length?sign(s.ttft[q]-Math.min(...r.map(o=>o.ttft[q]))):''}
  const coldOk=(s,q)=>s.headers?(s.headers[q]<d.gate.cold?'win':'lose'):''
  const warmDelta=(s,q)=>{const n=ncOf(s);return n&&s.ttft?s.ttft[q]-n.ttft[q]:undefined}
  const warmOk=(s,q)=>{const v=warmDelta(s,q);return v===undefined?'':v<=d.gate.warm?'win':'lose'}
  let h='<table><tr><th>lane</th>'+turns.map(t=>'<th>turn '+t+(t===1?' (cold for Worker)':'')+'</th>').join('')+'</tr>'
  for(const l of lanes)h+='<tr><td><span style="color:'+color[l]+'">■</span> '+esc(names[l])+'</td>'+turns.map(t=>{const s=cell(l,t);if(!s||!s.ttft)return '<td class="dim">-</td>'
    const n='<span class="dim">('+s.ttft.n+(s.errors?', <span class=err>'+s.errors+' err</span>':'')+')</span>'
    if(isNative(s)){const r=rivalsOf(s);return '<td><span class="'+best(s,'p50')+'">'+Math.round(s.ttft.p50)+'</span> / <span class="'+best(s,'p99')+'">'+Math.round(s.ttft.p99)+'</span> '+n+(r.length?'<br><span class="dim">vs '+esc(r.map(o=>o.name).join(', '))+' '+lead(s,'p50')+' / '+lead(s,'p99')+'</span>':'')+'</td>'}
    if(s.turn===1)return '<td>'+Math.round(s.ttft.p50)+' / '+Math.round(s.ttft.p99)+' '+n+(s.headers?'<br>headers <span class="'+coldOk(s,'p50')+'">'+Math.round(s.headers.p50)+'</span> / <span class="'+coldOk(s,'p99')+'">'+Math.round(s.headers.p99)+'</span> <span class="dim">gate &lt; '+d.gate.cold+'</span>':'')+'</td>'
    const w50=warmDelta(s,'p50'),w99=warmDelta(s,'p99')
    return '<td><span class="'+warmOk(s,'p50')+'">'+Math.round(s.ttft.p50)+'</span> / <span class="'+warmOk(s,'p99')+'">'+Math.round(s.ttft.p99)+'</span> '+n+'<br><span class="dim">'+(w50===undefined?'no native nanocode '+esc(s.model)+' lane':'vs native nanocode '+sign(w50)+' / '+sign(w99)+', gate ≤ +'+d.gate.warm)+'</span></td>'}).join('')+'</tr>'
  document.getElementById('summary').innerHTML=h+'</table><div class="dim">native: green is lower than every rival in its pair at that percentile, orange is not, and the second line is the difference from the best rival. Worker: turn 1 headers against the cold gate, later turns against native nanocode on the same model plus the warm gate. p99 is the nearest-rank percentile, so it equals the max until n reaches 100.</div>'
  document.getElementById('missing').innerHTML=d.missing.map(m=>'<div>'+esc(m.pair)+' pair: no native sample in this window'+(m.configured.length?' (lanes '+esc(m.configured.join(', '))+(m.errors?', last error: '+esc(String(m.errors).slice(0,200)):'')+')':', its lanes are not in --lanes ('+esc(d.lanes.join(', '))+')')+'</div>').join('')
  let g='<table><tr><th>Worker lane</th><th>turn</th><th>check</th><th>p50</th><th>p99</th><th>gate</th><th>server-timing and result timing p50 / p99 (ms)</th></tr>'
  for(const s of d.summary.filter(s=>!isNative(s)&&s.ttft).sort((a,b)=>(a.lane+a.turn).localeCompare(b.lane+b.turn))){
    const sp=Object.entries(s.splits||{}).filter(e=>e[1]).map(e=>esc(e[0])+' '+Math.round(e[1].p50)+'/'+Math.round(e[1].p99)).join(', ')
    if(s.turn===1){g+='<tr><td>'+esc(s.name)+'</td><td>1</td><td style="text-align:left">cold: POST to response headers</td><td class="'+coldOk(s,'p50')+'">'+(s.headers?Math.round(s.headers.p50):'-')+'</td><td class="'+coldOk(s,'p99')+'">'+(s.headers?Math.round(s.headers.p99):'-')+'</td><td>&lt; '+d.gate.cold+'</td><td class="dim" style="text-align:left">'+sp+'</td></tr>';continue}
    const w50=warmDelta(s,'p50'),w99=warmDelta(s,'p99')
    g+='<tr><td>'+esc(s.name)+'</td><td>'+s.turn+'</td><td style="text-align:left">warm: TTFT minus native nanocode</td><td class="'+warmOk(s,'p50')+'">'+(w50===undefined?'-':sign(w50))+'</td><td class="'+warmOk(s,'p99')+'">'+(w99===undefined?'-':sign(w99))+'</td><td>≤ +'+d.gate.warm+'</td><td class="dim" style="text-align:left">'+(w50===undefined?'no native nanocode '+esc(s.model)+' lane, ':'')+sp+'</td></tr>'}
  document.getElementById('gate').innerHTML=g+'</table>'
  document.getElementById('legend').innerHTML=lanes.map(l=>'<span style="color:'+color[l]+'">■ '+esc(names[l])+'</span>').join('')
  const W=560,H=220,P=36
  const t0=Math.min(...d.series.map(s=>s.at)),t1=Math.max(...d.series.map(s=>s.at))
  const chart=(title,pts,gate)=>{
    const vals=pts.map(p=>p.v).concat(gate===undefined?[]:[gate])
    const hi=Math.max(1,...vals),lo=Math.min(0,...vals)
    const x=a=>P+(t1>t0?(a-t0)/(t1-t0):0.5)*(W-P-8),y=v=>H-20-((v-lo)/(hi-lo))*(H-30)
    let s='<svg width="'+W+'" height="'+H+'"><text x="'+P+'" y="12" fill="#aaa">'+esc(title)+'</text>'
    for(const f of [0,0.25,0.5,0.75,1]){const v=lo+(hi-lo)*f;s+='<line x1="'+P+'" x2="'+(W-8)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="#2a2a2a"/><text x="2" y="'+(y(v)+4)+'" fill="#777" font-size="10">'+Math.round(v)+'</text>'}
    if(gate!==undefined)s+='<line x1="'+P+'" x2="'+(W-8)+'" y1="'+y(gate)+'" y2="'+y(gate)+'" stroke="#e66" stroke-dasharray="4 3"/><text x="'+(W-10)+'" y="'+(y(gate)-3)+'" fill="#e66" font-size="10" text-anchor="end">gate '+gate+'</text>'
    for(const l of lanes){const q=pts.filter(p=>p.lane===l).sort((a,b)=>a.at-b.at);if(!q.length)continue
      s+='<polyline fill="none" stroke="'+color[l]+'" stroke-width="1.5" points="'+q.map(p=>x(p.at)+','+y(p.v)).join(' ')+'"/>'+q.map(p=>'<circle r="2" fill="'+color[l]+'" cx="'+x(p.at)+'" cy="'+y(p.v)+'"><title>'+esc(names[l])+' '+Math.round(p.v)+' ms '+time(p.at)+'</title></circle>').join('')}
    if(pts.length)s+='<text x="'+P+'" y="'+(H-4)+'" fill="#777" font-size="10">'+time(t0)+'</text><text x="'+(W-8)+'" y="'+(H-4)+'" fill="#777" font-size="10" text-anchor="end">'+time(t1)+'</text>'
    return s+'</svg>'
  }
  document.getElementById('charts').innerHTML=turns.map(t=>chart('turn '+t+' TTFT',d.series.filter(s=>s.turn===t).map(s=>({at:s.at,lane:s.lane,v:s.ttft})))).join('')
  const ncAt={}
  for(const s of d.series)if(s.source==='native'&&s.lane.startsWith('live-nc-'))ncAt[s.model+'|'+s.cycle+'|'+s.turn]=s.ttft
  let wc=chart('Worker turn 1: POST to response headers',d.series.filter(s=>s.source==='worker'&&s.turn===1&&s.headers!=null).map(s=>({at:s.at,lane:s.lane,v:s.headers})),d.gate.cold)
  for(const t of turns.filter(t=>t>1))wc+=chart('Worker turn '+t+': TTFT minus native nanocode, same cycle',d.series.filter(s=>s.source==='worker'&&s.turn===t&&ncAt[s.model+'|'+s.cycle+'|'+t]!==undefined).map(s=>({at:s.at,lane:s.lane,v:s.ttft-ncAt[s.model+'|'+s.cycle+'|'+t]})),d.gate.warm)
  document.getElementById('workercharts').innerHTML=wc
  if(d.latest){const r=d.latest.rows;document.getElementById('latest').innerHTML='<div class="dim">'+esc(d.latest.cycle.cycle)+' · '+esc(d.latest.cycle.version)+' · '+Math.round(d.latest.cycle.total_ms/1000)+' s</div><table><tr><th>lane</th><th>turn</th><th>ttft</th><th>headers</th><th>server-timing / error</th></tr>'+r.map(x=>'<tr><td>'+esc(x.name)+'</td><td>'+x.turn+'</td><td>'+(x.ttft!=null?Math.round(x.ttft):'-')+'</td><td>'+(x.headers??'')+'</td><td class="'+(x.error?'err':'dim')+'" style="text-align:left">'+esc(x.error?String(x.error).slice(0,160):x.timing)+'</td></tr>').join('')+'</table>'}
  document.getElementById('cycles').innerHTML='<table><tr><th>start</th><th>status</th><th>rows</th><th>errors</th><th>seconds</th></tr>'+d.cycles.slice().reverse().map(x=>'<tr><td>'+time(x.at)+'</td><td>'+x.status+'</td><td>'+(x.rows??'')+'</td><td>'+(x.errors??'')+'</td><td>'+(x.total_ms?Math.round(x.total_ms/1000):'')+'</td></tr>').join('')+'</table>'
  document.getElementById('meta').textContent='updated '+time(d.now)+' · a cycle every '+Math.round(d.interval/60000)+' min plus its run time, skipped when the live lock is held'
}
document.getElementById('win').onchange=load
load();setInterval(load,60000)
</script></body></html>
`

if (process.argv.includes('--cycle')) {
  Fs.mkdirSync(dir, { recursive: true })
  await cycle()
  process.exit(0)
}

Fs.mkdirSync(dir, { recursive: true })
const log = Fs.openSync(Path.join(dir, 'dashboard.log'), 'a')
Http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/data.json') {
    res.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json' })
    res.end(JSON.stringify(data(Number(url.searchParams.get('window') ?? span))))
    return
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page)
    return
  }
  res.writeHead(404)
  res.end()
}).listen(port, host, () => console.log('listening on http://' + host + ':' + port + '/'))
if (!process.argv.includes('--serve-only')) schedule(log)
