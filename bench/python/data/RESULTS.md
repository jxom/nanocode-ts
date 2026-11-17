# Python data-work benchmark

Ten deterministic data-work workloads run through the nanocode-ts `Bash` API with python3 (nanocode-python, `dist/python.wasm` + `dist/python.data`), each in a fresh Node process (a fresh isolate), once cold and then warm in the same shell, at Cloudflare's `maxMemoryBytes` of 48 MiB and at the default 1 GiB (`unl`).

Run it on any build's `dist` (a release tarball's `package/dist` or a local `npm run build`):

```
gh release download build-<sha> -R nanocodexyz/nanocode-ts -D output/rel && tar xzf output/rel/*.tgz -C output/rel
node bench/python/data/run.ts output/rel/package/dist --label build-<sha> [--only W1,W3] [--limits 48,unl] [--warm 3]
```

It prints a markdown table and one SCORE line, and writes every step's timings and memory to `output/data/<label>.json`. Fixtures come from seeded generators in `fixtures.ts` (nothing big is committed); `expected.json` holds CPython 3.13's output for each step (numpy 2.5.5, matplotlib 3.11.2, pandas 3.1.1, polars 2.1.0), regenerated with `node bench/python/data/reference.ts <venv>/bin/python`. A step passes when it exits 0 and prints exactly that output (a `mode=` line, pandas or numpy, is left out). W3, W6 and W10 use pandas when it imports and a numpy/csv path with the same output otherwise (`BENCH_NUMPY=1` forces it); W9 is skipped while polars does not import.

| id | workload |
| --- | --- |
| W1 | numpy damped sine, two lines, legend, savefig |
| W2 | os.walk of a 3,002-file tree (8.5 MB) plus `git ls-files`, top-20 barh chart |
| W3 | 10 MB sales CSV (200,000 rows, date/text/int columns): groupby region, month, product; two-panel chart |
| W4 | 10,000 JSON API records: filter, sort, markdown table, counters |
| W5a, W5b | bootstrap CI for 90 tasks with 4,000 and 100,000 resamples each (numpy) |
| W6 | 100,000 timestamped payments: daily sums, 7-day rolling mean, line chart |
| W7 | five consecutive `python3 w7_chart.py <n>` calls, each importing numpy and matplotlib |
| W8 | ten `git` subprocess calls and a nested `python3 -c` |
| W9 | W3 in polars |
| W10 | probe: CSVs of 5, 10, 20, 35 and 50 MB loaded and summed; reports the largest that passes |

Columns: cold ms is the first run in a fresh process after the modules compiled (instantiate, image copy, imports, the script); warm ms is the median of three more runs in the same shell; peak linear MiB is the largest python.wasm linear memory right after a step (it never shrinks, so it is that instance's peak); live linear MiB is the python.wasm memory still alive after GC (0 when the run dropped its instance because it grew past half of maxMemoryBytes); max RSS MiB is the process's peak RSS. W10's times are the sum of all sizes tried.

SCORE: `pass48` workloads passing at 48 MiB over those not skipped (W10 is reported as `big48`, the largest CSV that fits); `warmUnl` and `coldUnl` the geometric mean of warm and cold times over workloads passing at 1 GiB (the stable speed metric); `warm48`/`cold48` the same over workloads passing at 48 MiB; `peakLin*` the largest peak linear memory. Lanes climb on pass48 and big48 first, then warmUnl and peakLinUnl, and must not regress any of them. Times on the shared hosted Hand vary by about 20% between runs; compare interleaved runs before claiming a speedup.

## Runs

### 2026-11-17 BASELINE build-89d6d85 (nanocode 2b90366ef), Node v24.22.3

| id | workload | limit | status | mode | cold ms | warm ms | peak linear MiB | live linear MiB | max RSS MiB | note |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| W1 | sine chart | 48 | pass | - | 1870 | 1063.2 | 69.7 | 0 | 411.2 |  |
| W1 | sine chart | unl | pass | - | 1482 | 225.5 | 80.1 | 80.1 | 421.7 |  |
| W2 | repo files chart | 48 | pass | - | 2582 | 1824.7 | 76.1 | 0 | 457 |  |
| W2 | repo files chart | unl | pass | - | 2785 | 970.9 | 99.7 | 99.7 | 458.3 |  |
| W3 | csv 10 MB groupby chart | 48 | fail | - | 1133 | - | 88.1 | 0 | 519.7 | ta in chunks (a file line by line, a batch of rows at a time) and write results out as you go instead of holding it all  |
| W3 | csv 10 MB groupby chart | unl | pass | numpy | 4341 | 3941.2 | 376.1 | 376.1 | 833.6 |  |
| W4 | json 10k records table | 48 | pass | - | 433 | 67.1 | 52.3 | 52.3 | 366.8 |  |
| W4 | json 10k records table | unl | pass | - | 440 | 80.6 | 52.3 | 52.3 | 373.4 |  |
| W5a | bootstrap 90x4000 | 48 | pass | - | 651 | 122 | 48.4 | 48.4 | 369.2 |  |
| W5a | bootstrap 90x4000 | unl | pass | - | 652 | 104.7 | 48.5 | 48.5 | 368.8 |  |
| W5b | bootstrap 90x100000 | 48 | fail | - | 765 | - | 119 | 0 | 418 | ta in chunks (a file line by line, a batch of rows at a time) and write results out as you go instead of holding it all  |
| W5b | bootstrap 90x100000 | unl | pass | - | 2152 | 1654.4 | 119 | 119 | 426.6 |  |
| W6 | time series daily rolling chart | 48 | fail | - | 1639 | - | 89.6 | 0 | 430.5 | ta in chunks (a file line by line, a batch of rows at a time) and write results out as you go instead of holding it all  |
| W6 | time series daily rolling chart | unl | pass | numpy | 4254 | 2046.7 | 256.3 | 256.3 | 604.7 |  |
| W7 | five python3 calls numpy+mpl | 48 | pass | - | 4852 | 4072.3 | 70.3 | 0 | 416.5 |  |
| W7 | five python3 calls numpy+mpl | unl | pass | - | 1894 | 691.1 | 109.2 | 109.2 | 446.6 |  |
| W8 | git subprocess heavy | 48 | pass | - | 381 | 48.2 | 34.2 | 34 | 388.1 |  |
| W8 | git subprocess heavy | unl | pass | - | 394 | 46.4 | 34.4 | 34.4 | 395 |  |
| W9 | polars csv groupby chart | 48 | skip | - | 281 | - | 34 | 34 | 448.6 |  |
| W9 | polars csv groupby chart | unl | skip | - | 317 | - | 34 | 34 | 462.8 |  |
| W10 | big csv probe | 48 | pass | - | 1688 | - | 116.7 | 0 | 1264.7 | largest 5 MB |
| W10 | big csv probe | unl | pass | - | 10934 | - | 649.8 | 436.1 | 1781.3 | largest 50 MB |
SCORE build-89d6d85 pass48=6/9 passUnl=9/9 warm48=382ms cold48=1166ms warmUnl=452ms coldUnl=1485ms peakLin48=119MiB peakLinUnl=376.1MiB rss48=519.7MiB big48=5 MB bigUnl=50 MB

At 48 MiB the instance is dropped after every run that grew past 24 MiB, so W1's warm run costs 1,063 ms against 226 ms at 1 GiB and W7's five calls 4.1 s against 0.69 s. W3, W5b and W6 are refused at 48 MiB (peak linear 88, 119 and 90 MiB, image 34 MiB); at 1 GiB the numpy/csv path of W3 peaks at 376 MiB linear for a 10 MB CSV, and W10 reaches 650 MiB for 50 MB.

### 2026-11-17 build-89d6d85 in workerd 2026-11-17 (compat date 2026-10-16, nodejs_compat)

`node bench/python/data/run.ts <dist> --runtime workerd --workerd <path to workerd>` bundles `worker.ts` with the dist's `bash/index.js` (esbuild), embeds python.wasm, psh.wasm and python.data as modules, starts one `workerd serve` per workload and limit (a fresh isolate) and runs the same steps inside it. max RSS is the workerd process's VmHWM (all compiled code, every linear memory and the JS heap, the closest local stand-in for Cloudflare's 128 MB isolate limit; workerd sets no limit itself); live linear counts every python.wasm memory not yet collected, since workerd exposes no gc().

| id | workload | limit | status | mode | cold ms | warm ms | peak linear MiB | live linear MiB | max RSS MiB | note |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| W1 | sine chart | 48 | pass | - | 1579 | 1071 | 69.7 | 278.6 | 613 |  |
| W1 | sine chart | unl | pass | - | 1597 | 316 | 80.1 | 80.1 | 415.3 |  |
| W2 | repo files chart | 48 | pass | - | 2879 | 2373 | 76.1 | 304.3 | 723.4 |  |
| W2 | repo files chart | unl | pass | - | 3461 | 1236 | 99.7 | 99.7 | 523.7 |  |
| W3 | csv 10 MB groupby chart | 48 | fail | - | 1747 | - | 88.1 | 88.1 | 603.3 | ta in chunks (a file line by line, a batch of rows at a time) and write results out as you go instead of holding it all  |
| W3 | csv 10 MB groupby chart | unl | pass | numpy | 6078 | 5500 | 376.1 | 376.1 | 794.7 |  |
| W4 | json 10k records table | 48 | pass | - | 407 | 112 | 52.3 | 52.3 | 407.9 |  |
| W4 | json 10k records table | unl | pass | - | 369 | 102 | 52.3 | 52.3 | 407 |  |
| W5a | bootstrap 90x4000 | 48 | pass | - | 641 | 125 | 48.5 | 48.5 | 379.3 |  |
| W5a | bootstrap 90x4000 | unl | pass | - | 883 | 148 | 48.5 | 48.5 | 381 |  |
| W5b | bootstrap 90x100000 | 48 | fail | - | 700 | - | 119 | 119 | 435.2 | ta in chunks (a file line by line, a batch of rows at a time) and write results out as you go instead of holding it all  |
| W5b | bootstrap 90x100000 | unl | pass | - | 2898 | 2153 | 119 | 119 | 447.1 |  |
| W6 | time series daily rolling chart | 48 | fail | - | 2282 | - | 89.6 | 89.6 | 476.6 | ta in chunks (a file line by line, a batch of rows at a time) and write results out as you go instead of holding it all  |
| W6 | time series daily rolling chart | unl | pass | numpy | 4366 | 3092 | 256.3 | 256.3 | 646.4 |  |
| W7 | five python3 calls numpy+mpl | 48 | pass | - | 6100 | 5614 | 70.3 | 1401.9 | 1720.8 |  |
| W7 | five python3 calls numpy+mpl | unl | pass | - | 3057 | 1038 | 109.1 | 109.1 | 446.7 |  |
| W8 | git subprocess heavy | 48 | pass | - | 232 | 70 | 34.2 | 170.8 | 506.2 |  |
| W8 | git subprocess heavy | unl | pass | - | 229 | 50 | 34.4 | 170.4 | 505 |  |
| W9 | polars csv groupby chart | 48 | skip | - | 218 | - | 34 | 34 | 602.6 |  |
| W9 | polars csv groupby chart | unl | skip | - | 200 | - | 34 | 34 | 603.3 |  |
| W10 | big csv probe | 48 | pass | - | 2462 | - | 116.7 | 206.3 | 1697.1 | largest 5 MB |
| W10 | big csv probe | unl | pass | - | 15848 | - | 649.8 | 649.8 | 1696.4 | largest 50 MB |
SCORE build-89d6d85-workerd pass48=6/9 passUnl=9/9 warm48=491ms cold48=1090ms warmUnl=607ms coldUnl=1662ms peakLin48=119MiB peakLinUnl=376.1MiB rss48=1720.8MiB big48=5MB bigUnl=50MB

Timings track Node within the hosted Hand's noise. The memory finding: at 48 MiB every run that grew past 24 MiB drops its instance, and in workerd those dropped linear memories stay alive: after W7's 20 chart runs 1,402 MiB of python.wasm memory is still uncollected and the process peaks at 1,721 MiB RSS, and W8's nested python3 leaves 170 MiB across instances. On Cloudflare that garbage counts against the 128 MB isolate until V8 collects it, so dropping instances is itself a memory risk, not only a speed cost.

### 2026-11-17 rerun at master 2d10d99 (split: lazy python.wasm load; same python.wasm as build-89d6d85), Node

Built with `sh bench/python/data/dist.sh <release dist> output/dist-2d10d99` (master's TypeScript, the release's wasm files). Load average on the shared Hand was 6.6 to 7.9.

| id | workload | limit | status | mode | cold ms | warm ms | peak linear MiB | live linear MiB | max RSS MiB | note |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| W1 | sine chart | 48 | pass | - | 1986 | 1544.1 | 69.7 | 0 | 405.6 |  |
| W1 | sine chart | unl | pass | - | 2320 | 315 | 80.1 | 80.1 | 409.4 |  |
| W2 | repo files chart | 48 | pass | - | 2962 | 1866.6 | 76.1 | 0 | 437.7 |  |
| W2 | repo files chart | unl | pass | - | 2690 | 1020.4 | 99.7 | 99.7 | 477.7 |  |
| W3 | csv 10 MB groupby chart | 48 | fail | - | 1577 | - | 88.1 | 0 | 507.4 | ta in chunks (a file line by line, a batch of rows at a time) and write results out as you go instead of holding it all  |
| W3 | csv 10 MB groupby chart | unl | pass | numpy | 7956 | 5477 | 376.1 | 376.1 | 796.6 |  |
| W4 | json 10k records table | 48 | pass | - | 790 | 104.6 | 52.3 | 52.3 | 376.5 |  |
| W4 | json 10k records table | unl | pass | - | 764 | 93.6 | 52.3 | 52.3 | 376.1 |  |
| W5a | bootstrap 90x4000 | 48 | pass | - | 1424 | 148.9 | 48.5 | 48.5 | 358.2 |  |
| W5a | bootstrap 90x4000 | unl | pass | - | 986 | 188.3 | 48.5 | 48.5 | 354.1 |  |
| W5b | bootstrap 90x100000 | 48 | fail | - | 1347 | - | 119 | 0 | 421.6 | ta in chunks (a file line by line, a batch of rows at a time) and write results out as you go instead of holding it all  |
| W5b | bootstrap 90x100000 | unl | pass | - | 2630 | 1707.4 | 119 | 119 | 428 |  |
| W6 | time series daily rolling chart | 48 | fail | - | 2760 | - | 89.6 | 0 | 442.4 | ta in chunks (a file line by line, a batch of rows at a time) and write results out as you go instead of holding it all  |
| W6 | time series daily rolling chart | unl | pass | numpy | 7538 | 2629.8 | 256.3 | 256.3 | 608.4 |  |
| W7 | five python3 calls numpy+mpl | 48 | pass | - | 6990 | 5839.3 | 70.3 | 0 | 422.1 |  |
| W7 | five python3 calls numpy+mpl | unl | pass | - | 3104 | 1297 | 109.2 | 109.2 | 423 |  |
| W8 | git subprocess heavy | 48 | pass | - | 908 | 68.6 | 34.2 | 34 | 363.8 |  |
| W8 | git subprocess heavy | unl | pass | - | 660 | 67.3 | 34.4 | 34.4 | 366.7 |  |
| W9 | polars csv groupby chart | 48 | skip | - | 356 | - | 34 | 34 | 433.3 |  |
| W9 | polars csv groupby chart | unl | skip | - | 474 | - | 34 | 34 | 391.6 |  |
| W10 | big csv probe | 48 | pass | - | 2917 | - | 116.7 | 0 | 1000 | largest 5 MB |
| W10 | big csv probe | unl | pass | - | 18656 | - | 649.8 | 436.1 | 1737.6 | largest 50 MB |
SCORE master-2d10d99 pass48=6/9 passUnl=9/9 warm48=512ms cold48=1864ms warmUnl=613ms coldUnl=2257ms peakLin48=119MiB peakLinUnl=376.1MiB rss48=507.4MiB big48=5MB bigUnl=50MB

The full run reads slower than the baseline (warmUnl 613 against 452 ms), but an interleaved A/B of W1, W4, W5a, W7 and W8 at 1 GiB, two rounds each, gives warmUnl 196 and 200 ms for build-89d6d85 against 233 and 182 ms for master, coldUnl 1,126 and 1,211 against 1,200 and 1,059 ms: no regression, the gap is the Hand's load. The change only moves compiling python.wasm out of Worker boot under the new module registry, which this Node bench (it hands the runtime a compiled module) cannot see. Memory is unchanged (peakLinUnl 376 MiB, pass48 6/9). Compare interleaved runs, not runs taken at different times.
