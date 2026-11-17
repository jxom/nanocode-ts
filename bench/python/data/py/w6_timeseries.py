import os
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

try:
    if os.environ.get("BENCH_NUMPY"):
        raise ImportError
    import pandas as pd
except ImportError:
    pd = None

if pd is not None:
    df = pd.read_csv("payments.csv", parse_dates=["ts"])
    daily = df.set_index("ts")["amount_cents"].resample("D").sum()
    rolling = daily.rolling(7).mean()
    days = [str(d.date()) for d in daily.index]
    totals = daily.to_numpy().astype(np.int64)
    smooth = rolling.to_numpy()
    by_currency = df.groupby("currency")["amount_cents"].sum().sort_index()
    currencies = [(name, int(value)) for name, value in by_currency.items()]
    mode = "pandas"
else:
    raw = np.genfromtxt("payments.csv", delimiter=",", names=True, dtype=None, encoding="utf-8")
    stamps = raw["ts"].astype("datetime64[s]").astype("datetime64[D]")
    first, last = stamps.min(), stamps.max()
    offsets = (stamps - first).astype(np.int64)
    totals = np.bincount(offsets, weights=raw["amount_cents"], minlength=int((last - first).astype(np.int64)) + 1).astype(np.int64)
    days = [str(first + np.timedelta64(i, "D")) for i in range(len(totals))]
    smooth = np.full(len(totals), np.nan)
    smooth[6:] = np.convolve(totals, np.ones(7), mode="valid") / 7
    names, index = np.unique(raw["currency"], return_inverse=True)
    currencies = [(str(name), int(value)) for name, value in zip(names, np.bincount(index, weights=raw["amount_cents"]).astype(np.int64))]
    mode = "numpy"

fig, ax = plt.subplots(figsize=(10, 4), dpi=100)
ax.plot(np.arange(len(totals)), totals / 100, alpha=0.4, label="daily")
ax.plot(np.arange(len(totals)), smooth / 100, label="7-day mean")
ax.set_title("Daily volume")
ax.legend()
fig.savefig("volume.png")
print(len(days), days[0], days[-1], int(totals.sum()))
print(int(totals.max()), days[int(totals.argmax())], round(float(smooth[-1]) / 100, 2))
print(currencies)
print("mode=" + mode)
