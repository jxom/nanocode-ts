import json, sys
import numpy as np

draws = int(sys.argv[1])
with open("tasks.json") as file:
    tasks = json.load(file)
rng = np.random.default_rng(12345)
lows, highs, widths = [], [], []
for task in tasks:
    scores = np.asarray(task["scores"], dtype=np.float64)
    index = rng.integers(0, len(scores), size=(draws, len(scores)))
    means = scores[index].mean(axis=1)
    low, high = np.percentile(means, [2.5, 97.5])
    lows.append(low)
    highs.append(high)
    widths.append(high - low)
print(len(tasks), draws)
print(round(float(np.mean(lows)), 4), round(float(np.mean(highs)), 4), round(float(np.max(widths)), 4))
print([round(float(v), 4) for v in lows[:3]])
