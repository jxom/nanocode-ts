import { readFileSync } from 'node:fs'
import { Bash, MemoryFileSystem } from '../../src/bash/index.ts'

const dist = process.env.NANOCODE_DIST ?? 'dist'
const module = new WebAssembly.Module(readFileSync(dist + '/python.wasm'))
const data = readFileSync(dist + '/python.data')
const psh = new WebAssembly.Module(readFileSync(dist + '/psh.wasm'))

const cases: readonly (readonly [string, string])[] = [
  ['requests', 'import requests; print(requests.__version__)'],
  ['httpx', 'import httpx; print(httpx.__version__)'],
  [
    'rich',
    'from rich.table import Table; from rich.console import Console; c = Console(); t = Table("a"); t.add_row("1"); c.print(t)',
  ],
  ['tabulate', 'from tabulate import tabulate; print(tabulate([[1, 2]], headers=["a", "b"]))'],
  [
    'beautifulsoup4',
    'from bs4 import BeautifulSoup; print(BeautifulSoup("<p>hi</p>", "html.parser").p.text)',
  ],
  [
    'python-dateutil',
    'from dateutil import parser; print(parser.parse("2024-01-02T03:04:05Z").year)',
  ],
  [
    'pytz',
    'import pytz, datetime; print(datetime.datetime(2024, 1, 1, tzinfo=pytz.utc).astimezone(pytz.timezone("US/Pacific")).hour)',
  ],
  ['attrs', 'import attrs\n@attrs.define\nclass P:\n    x: int\nprint(P(1))'],
  [
    'pydantic',
    'from pydantic import BaseModel\nclass M(BaseModel):\n    x: int\nprint(M(x="3").x)',
  ],
  ['click', 'import click; print(click.__name__)'],
  ['jinja2', 'import jinja2; print(jinja2.Template("{{ a }}!").render(a=1))'],
  ['toml', 'import toml; print(toml.loads("a = 1")["a"])'],
  ['tomli', 'import tomli; print(tomli.loads("a = 1")["a"])'],
  ['sqlalchemy', 'import sqlalchemy as sa; print(sa.__version__); print(sa.select(sa.literal(1)))'],
  ['networkx', 'import networkx as nx; print(nx.shortest_path(nx.path_graph(4), 0, 3))'],
  ['sympy', 'import sympy as s; x = s.Symbol("x"); print(s.expand((x + 1) ** 2))'],
  [
    'openpyxl',
    'import openpyxl; wb = openpyxl.Workbook(); wb.active["A1"] = 5; wb.save("a.xlsx"); print(openpyxl.load_workbook("a.xlsx").active["A1"].value)',
  ],
  [
    'xlsxwriter',
    'import xlsxwriter; w = xlsxwriter.Workbook("b.xlsx"); w.add_worksheet().write(0, 0, 1); w.close(); print("ok")',
  ],
  ['faker', 'from faker import Faker; print(len(Faker().name()) > 0)'],
  ['tqdm', 'from tqdm import tqdm; print(sum(tqdm(range(10), disable=True)))'],
  ['simplejson', 'import simplejson; print(simplejson.dumps({"a": 1}))'],
  ['chardet', 'import chardet; print(chardet.detect("héllo wörld".encode("utf-8"))["encoding"])'],
  ['idna', 'import idna; print(idna.encode("ドメイン.テスト"))'],
  ['eth-abi', 'from eth_abi import encode; print(encode(["uint256"], [1]).hex())'],
  [
    'seaborn',
    'import matplotlib; matplotlib.use("Agg"); import seaborn as sns; print(sns.__version__)',
  ],
  [
    'plotly',
    'import plotly.graph_objects as go; print(len(go.Figure(go.Bar(y=[1, 2])).to_json()) > 10)',
  ],
  [
    'altair',
    'import altair as alt, pandas as pd; print(alt.Chart(pd.DataFrame({"a": [1]})).mark_bar().encode(x="a").to_dict()["mark"])',
  ],
  ['statsmodels', 'import statsmodels.api as sm; print(sm.__name__)'],
  ['scipy', 'import scipy; print(scipy.__version__)'],
  ['scikit-learn', 'import sklearn; print(sklearn.__version__)'],
  ['lxml', 'from lxml import etree; print(etree.fromstring("<a>1</a>").text)'],
  ['orjson', 'import orjson; print(orjson.dumps({"a": 1}))'],
  ['cryptography', 'from cryptography.fernet import Fernet; print(len(Fernet.generate_key()))'],
  ['pyarrow', 'import pyarrow; print(pyarrow.__version__)'],
  ['polars', 'import polars as pl; print(pl.DataFrame({"a": [1]}).shape)'],
  ['markdown', 'import markdown; print(markdown.markdown("# hi"))'],
  ['pyyaml', 'import yaml; print(yaml.safe_dump({"a": 1}).strip())'],
  ['numpy', 'import numpy as np; print(np.arange(3).sum())'],
  ['pandas', 'import pandas as pd; print(pd.DataFrame({"a": [1, 2]}).a.sum())'],
  ['matplotlib', 'import matplotlib; print(matplotlib.__version__)'],
]

const only = process.argv.slice(2)
let ok = 0
let total = 0
for (const [name, code] of cases) {
  if (only.length && !only.includes(name)) continue
  total++
  const bash = await Bash.create({
    cwd: '/workspace',
    fetch,
    fs: MemoryFileSystem.create(),
    limits: { maxMemoryBytes: 512 << 20, timeoutMs: 300000 },
    psh,
    python: { cpuMs: 300000, data, module, stepsPerMs: 42000 },
  })
  const started = performance.now()
  const installed = await bash.exec('pip install -q ' + name)
  const installMs = Math.round(performance.now() - started)
  await bash.writeFile('/workspace/probe.py', code)
  const ran = installed.exitCode === 0 ? await bash.exec('python3 probe.py') : undefined
  const pass = ran !== undefined && ran.exitCode === 0
  if (pass) ok++
  const tail = (text: string) => text.trim().split('\n').slice(-2).join(' | ').slice(0, 300)
  console.log(
    JSON.stringify({
      name,
      pass,
      installMs,
      runMs: Math.round(performance.now() - started) - installMs,
      out: pass
        ? tail(ran.stdout)
        : tail(installed.stderr + installed.stdout + (ran ? ran.stderr + ran.stdout : '')),
    }),
  )
}
console.log(JSON.stringify({ ok, total }))
