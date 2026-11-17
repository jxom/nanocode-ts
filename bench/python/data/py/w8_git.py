import subprocess, sys

def git(*args):
    return subprocess.run(["git", *args], cwd="repo", capture_output=True, text=True, check=True).stdout

out = []
out.append(len(git("ls-files").split()))
out.append(len(git("ls-files", "src").split()))
out.append(len(git("log", "--oneline").splitlines()))
out.append(len(git("rev-parse", "HEAD").strip()))
out.append(len(git("status", "--porcelain").splitlines()))
out.append(len(git("ls-files", "docs").split()))
out.append(len(git("log", "--format=%s").splitlines()))
out.append(len(git("ls-files", "*.json").split()))
out.append(len(git("diff", "--stat").splitlines()))
out.append(len(git("ls-files", "--", "src/core").split()))
nested = subprocess.run([sys.executable, "-c", "import json; print(json.dumps(sorted({'b': 2, 'a': 1})))"], capture_output=True, text=True, check=True).stdout.strip()
out.append(nested)
print(out)
