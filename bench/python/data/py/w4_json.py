import collections, json

with open("records.json") as file:
    records = json.load(file)
settled = [r for r in records if r["status"] == "settled" and r["amount"] > 100]
settled.sort(key=lambda r: (-r["amount"], r["id"]))
lines = ["| id | user | country | amount | created |", "| --- | --- | --- | ---: | --- |"]
for r in settled[:20]:
    lines.append("| %d | %s | %s | %.2f | %s |" % (r["id"], r["user"]["name"], r["user"]["country"], r["amount"], r["created_at"][:10]))
with open("top.md", "w") as file:
    file.write("\n".join(lines) + "\n")
countries = collections.Counter(r["user"]["country"] for r in settled)
tags = collections.Counter(tag for r in records for tag in r["tags"])
print(len(records), len(settled), round(sum(r["amount"] for r in settled), 2))
print(lines[2])
print(sorted(countries.items(), key=lambda item: (-item[1], item[0]))[:3])
print(sorted(tags.items(), key=lambda item: (-item[1], item[0]))[:3])
