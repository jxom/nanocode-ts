import collections, os, subprocess
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

sizes = {}
for root, dirs, names in os.walk("repo"):
    dirs[:] = [d for d in dirs if d != ".git"]
    for name in names:
        path = os.path.join(root, name)
        sizes[os.path.relpath(path, "repo")] = os.path.getsize(path)
tracked = subprocess.run(["git", "ls-files"], cwd="repo", capture_output=True, text=True, check=True).stdout.split()
by_ext = collections.Counter()
by_dir = collections.Counter()
for path in tracked:
    by_ext[os.path.splitext(path)[1] or "(none)"] += sizes[path]
    by_dir[path.split("/")[0]] += sizes[path]
top = sorted(((size, path) for path, size in sizes.items()), reverse=True)[:20]
fig, ax = plt.subplots(figsize=(9, 6), dpi=100)
ax.barh([path for _, path in top][::-1], [size for size, _ in top][::-1])
ax.set_xlabel("bytes")
ax.set_title("Largest files")
fig.tight_layout()
fig.savefig("repo.png")
print(len(sizes), len(tracked), sum(sizes.values()))
print(sorted(by_ext.items(), key=lambda item: (-item[1], item[0]))[:3])
print(sorted(by_dir.items(), key=lambda item: (-item[1], item[0]))[:3])
print(top[0])
