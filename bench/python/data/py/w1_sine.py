import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

x = np.linspace(0, 4 * np.pi, 2000)
y = np.sin(x) * np.exp(-x / 10)
fig, ax = plt.subplots(figsize=(8, 4), dpi=100)
ax.plot(x, y, label="damped sine")
ax.plot(x, np.cos(x) * 0.5, label="cosine")
ax.set_title("Damped sine")
ax.legend()
ax.grid(True)
fig.savefig("sine.png")
print(round(float(y.max()), 4), round(float(y.min()), 4), len(open("sine.png", "rb").read()) > 20000)
