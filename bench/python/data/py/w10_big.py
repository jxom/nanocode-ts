import csv, os, sys
import numpy as np

path = sys.argv[1]
# W10 probes the largest CSV that fits the memory cap, so it reads through
# csv and numpy: importing pandas alone holds about 43 MiB of the 48.
try:
    if not os.environ.get("BENCH_PANDAS"):
        raise ImportError
    import pandas as pd
except ImportError:
    pd = None
if pd is not None:
    df = pd.read_csv(path, usecols=["region", "units", "price_cents"])
    revenue = int((df["units"] * df["price_cents"]).sum())
    rows = len(df)
else:
    units, price = [], []
    with open(path, newline="") as file:
        reader = csv.reader(file)
        header = next(reader)
        u, p = header.index("units"), header.index("price_cents")
        for row in reader:
            units.append(row[u])
            price.append(row[p])
    revenue = int((np.array(units, dtype=np.int64) * np.array(price, dtype=np.int64)).sum())
    rows = len(units)
print(rows, revenue)
