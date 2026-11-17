import polars as pl
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

df = pl.read_csv("sales.csv").with_columns((pl.col("units") * pl.col("price_cents")).alias("revenue"), pl.col("date").str.slice(0, 7).alias("month"))
regions = df.group_by("region").agg(pl.len().alias("n"), pl.col("revenue").sum(), pl.col("price_cents").mean().alias("price")).sort("region")
region_rows = [(r["region"], int(r["n"]), int(r["revenue"]), round(float(r["price"]) / 100, 2)) for r in regions.iter_rows(named=True)]
months = df.group_by("month").agg(pl.col("revenue").sum()).sort("month")
month_rows = [(r["month"], int(r["revenue"])) for r in months.iter_rows(named=True)]
products = df.group_by("product").agg(pl.col("revenue").sum())
product_rows = sorted(((int(r["revenue"]), r["product"]) for r in products.iter_rows(named=True)), reverse=True)[:5]
customers = df["customer"].n_unique()
fig, (left, right) = plt.subplots(1, 2, figsize=(11, 4), dpi=100)
left.bar([row[0] for row in region_rows], [row[2] / 100 for row in region_rows])
right.plot([row[0] for row in month_rows], [row[1] / 100 for row in month_rows], marker="o")
fig.tight_layout()
fig.savefig("sales_polars.png")
print(sum(row[1] for row in region_rows), customers)
print(region_rows[:3])
print(month_rows[:2], len(month_rows))
print(product_rows)
print("mode=polars")
