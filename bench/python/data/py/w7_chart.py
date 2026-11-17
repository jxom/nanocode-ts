import sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

step = int(sys.argv[1])
rng = np.random.default_rng(step)
values = rng.normal(size=(4, 200)).cumsum(axis=1)
fig, ax = plt.subplots(figsize=(6, 3), dpi=80)
for row in values:
    ax.plot(row)
ax.set_title("run %d" % step)
fig.savefig("run%d.png" % step)
print(step, round(float(values[:, -1].sum()), 4))
