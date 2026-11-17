import csv, os, sys
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
    df = pd.read_csv("sales.csv")
    df["revenue"] = df["units"] * df["price_cents"]
    df["month"] = df["date"].str.slice(0, 7)
    regions = df.groupby("region").agg(n=("units", "size"), revenue=("revenue", "sum"), price=("price_cents", "mean")).sort_index()
    region_rows = [(name, int(row.n), int(row.revenue), round(float(row.price) / 100, 2)) for name, row in regions.iterrows()]
    months = df.groupby("month")["revenue"].sum().sort_index()
    month_rows = [(name, int(value)) for name, value in months.items()]
    products = df.groupby("product")["revenue"].sum()
    product_rows = sorted(((int(value), name) for name, value in products.items()), reverse=True)[:5]
    customers = int(df["customer"].nunique())
    mode = "pandas"
else:
    with open("sales.csv", newline="") as file:
        reader = csv.reader(file)
        header = next(reader)
        columns = list(zip(*reader))
    data = dict(zip(header, columns))
    units = np.array(data["units"], dtype=np.int64)
    price = np.array(data["price_cents"], dtype=np.int64)
    revenue = units * price
    region_names, region_index = np.unique(np.array(data["region"]), return_inverse=True)
    counts = np.bincount(region_index)
    region_rows = [(str(name), int(counts[i]), int(revenue[region_index == i].sum()), round(float(price[region_index == i].mean()) / 100, 2)) for i, name in enumerate(region_names)]
    month_names, month_index = np.unique(np.array([d[:7] for d in data["date"]]), return_inverse=True)
    month_rows = [(str(name), int(value)) for name, value in zip(month_names, np.bincount(month_index, weights=revenue).astype(np.int64))]
    product_names, product_index = np.unique(np.array(data["product"]), return_inverse=True)
    product_rows = sorted(((int(value), str(name)) for name, value in zip(product_names, np.bincount(product_index, weights=revenue).astype(np.int64))), reverse=True)[:5]
    customers = len(set(data["customer"]))
    mode = "numpy"

fig, (left, right) = plt.subplots(1, 2, figsize=(11, 4), dpi=100)
left.bar([row[0] for row in region_rows], [row[2] / 100 for row in region_rows])
left.set_title("Revenue by region")
right.plot([row[0] for row in month_rows], [row[1] / 100 for row in month_rows], marker="o")
right.set_title("Revenue by month")
right.tick_params(axis="x", rotation=45)
fig.tight_layout()
fig.savefig("sales.png")
print(sum(row[1] for row in region_rows), customers)
print(region_rows[:3])
print(month_rows[:2], len(month_rows))
print(product_rows)
print("mode=" + mode)
