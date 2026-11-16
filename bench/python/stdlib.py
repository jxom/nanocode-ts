import base64
import bisect
import binascii
import collections
import csv
import dataclasses
import datetime
import decimal
import fractions
import functools
import hashlib
import heapq
import io
import itertools
import json
import math
import os
import pathlib
import random
import re
import shutil
import statistics
import string
import struct
import sys
import textwrap
import time

records = [{"id": i, "name": f"user{i}", "score": i * 1.5, "active": i % 3 == 0, "tags": ["a", "b", str(i)], "parent": None} for i in range(2000)]
records_text = json.dumps(records)
words = [f"w{i % 397}x{i % 13}" for i in range(20000)]
text_block = " ".join(words)
lines = [f"{i},user{i},{i * 7 % 1000},{'yes' if i % 2 else 'no'}" for i in range(5000)]
csv_text = "\n".join(lines) + "\n"
ints = [(i * 7919) % 100003 for i in range(50000)]
strs = [f"k{(i * 31) % 50000:05d}" for i in range(20000)]
scratch = pathlib.Path(os.environ.get("TMPDIR", "/tmp")) / f"stdlib-bench-{os.getpid()}"


def w_json_dumps():
    return len(json.dumps(records))


def w_json_loads():
    return len(json.loads(records_text))


def w_json_dumps_indent():
    return len(json.dumps(records[:500], indent=2, sort_keys=True))


def w_json_roundtrip_small():
    n = 0
    for i in range(3000):
        n += len(json.loads(json.dumps({"a": i, "b": [1, 2, 3], "c": "x"})))
    return n


def w_re_compile_match():
    pattern = re.compile(r"(\w+)x(\d+)")
    n = 0
    for word in words:
        if pattern.match(word):
            n += 1
    return n


def w_re_findall():
    return len(re.findall(r"w(\d+)x", text_block))


def w_re_sub():
    return len(re.sub(r"x(\d+)", r"<\1>", text_block))


def w_re_split():
    return len(re.split(r"\s+", text_block))


def w_re_search_groups():
    pattern = re.compile(r"(?P<user>user\d+),(?P<n>\d+)")
    total = 0
    for line in lines:
        m = pattern.search(line)
        total += int(m.group("n"))
    return total


def w_pathlib_pure():
    n = 0
    for i in range(3000):
        p = pathlib.PurePosixPath("/srv/data") / f"dir{i % 17}" / f"file{i}.tar.gz"
        n += len(p.name) + len(p.suffix) + len(p.parent.parts) + len(str(p.with_suffix(".zip")))
    return n


def w_pathlib_relative():
    base = pathlib.PurePosixPath("/srv/data")
    n = 0
    for i in range(2000):
        p = base / "a" / "b" / f"c{i}" / "d.txt"
        n += len(str(p.relative_to(base))) + p.match("*.txt")
    return n


def w_pathlib_fs():
    scratch.mkdir(parents=True, exist_ok=True)
    for i in range(40):
        (scratch / f"f{i}.txt").write_text(f"line {i}\n" * 20)
    n = 0
    for p in sorted(scratch.iterdir()):
        if p.suffix == ".txt":
            n += len(p.read_text()) + p.stat().st_size
    return n


def w_str_split_join():
    n = 0
    for _ in range(20):
        n += len("-".join(text_block.split(" ")))
    return n


def w_str_replace():
    s = text_block
    for _ in range(20):
        s = s.replace("x1", "y1").replace("y1", "x1")
    return len(s)


def w_str_format():
    out = []
    for i in range(20000):
        out.append("%s:%d:%.2f" % ("k", i, i / 3))
    return len(out[-1]) + len(out)


def w_str_fstring():
    out = []
    for i in range(20000):
        out.append(f"{i:>8}|{i / 7:.3f}|{'x' * (i % 5)}")
    return sum(map(len, out))


def w_str_methods():
    n = 0
    for word in words:
        n += word.upper().startswith("W") + word.find("x") + len(word.strip("w")) + word.isalnum()
    return n


def w_str_concat():
    s = ""
    for i in range(30000):
        s += "ab"
    return len(s)


def w_str_encode_decode():
    n = 0
    for _ in range(20):
        n += len(text_block.encode("utf-8").decode("utf-8"))
    return n


def w_str_unicode():
    s = "héllo wörld ñandú 日本語 " * 2000
    return len(s.upper()) + len(s.encode("utf-8")) + s.count("ö")


def w_dict_build():
    d = {}
    for i in range(50000):
        d[i] = i * 2
    return len(d)


def w_dict_lookup_str():
    d = {s: i for i, s in enumerate(strs)}
    n = 0
    for s in strs:
        n += d[s]
    return n


def w_dict_items_iter():
    d = {s: i for i, s in enumerate(strs)}
    n = 0
    for _ in range(5):
        for k, v in d.items():
            n += v
    return n


def w_dict_update_merge():
    base = {f"k{i}": i for i in range(1000)}
    n = 0
    for i in range(100):
        merged = {**base, "x": i}
        merged.update(base)
        n += len(merged)
    return n


def w_list_append_pop():
    a = []
    for i in range(50000):
        a.append(i)
    n = 0
    while a:
        n += a.pop()
    return n


def w_list_index_slice():
    n = 0
    for i in range(20000):
        n += sum(ints[i:i + 5]) + ints[-1 - (i % 100)]
    return n


def w_list_sort_ints():
    return sorted(ints)[len(ints) // 2]


def w_list_sort_strs():
    return sorted(strs)[100]


def w_list_sort_key():
    return sorted(records, key=lambda r: (r["score"] % 7, r["name"]))[0]["id"]


def w_list_sort_tuples():
    rows = [(i % 97, -i, str(i)) for i in range(20000)]
    rows.sort()
    return rows[0][1]


def w_set_ops():
    a = set(ints[:25000])
    b = set(ints[25000:])
    return len(a & b) + len(a | b) + len(a - b)


def w_tuple_unpack():
    pairs = [(i, i + 1) for i in range(30000)]
    n = 0
    for a, b in pairs:
        n += a * b - b
    return n


def w_listcomp():
    return len([x * 2 for x in ints if x % 3])


def w_dictcomp():
    return len({x: x + 1 for x in ints})


def w_setcomp_nested():
    return len({(x, y) for x in range(200) for y in range(100) if (x ^ y) & 1})


def w_genexpr_sum():
    return sum(x * x for x in ints)


def add3(a, b, c):
    return a + b + c


def kw(a, b=2, *, c=3):
    return a + b + c


def w_call_positional():
    n = 0
    for i in range(50000):
        n = add3(n, i, 1)
    return n


def w_call_kwargs():
    n = 0
    for i in range(30000):
        n += kw(i, b=1, c=2) + kw(i)
    return n


def w_call_closure_lambda():
    def make(k):
        return lambda x: x + k

    fs = [make(i) for i in range(100)]
    n = 0
    for _ in range(300):
        for f in fs:
            n = f(n) & 0xFFFF
    return n


def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)


def w_call_recursion():
    return fib(20)


def w_call_star_args():
    def f(*args, **kwargs):
        return len(args) + len(kwargs)

    n = 0
    for i in range(20000):
        n += f(1, 2, i, x=1, y=i)
    return n


class Point:
    def __init__(self, x, y):
        self.x = x
        self.y = y

    def norm2(self):
        return self.x * self.x + self.y * self.y

    @property
    def sum(self):
        return self.x + self.y


class Point3(Point):
    def __init__(self, x, y, z):
        super().__init__(x, y)
        self.z = z

    def norm2(self):
        return super().norm2() + self.z * self.z


class Slotted:
    __slots__ = ("a", "b")

    def __init__(self, a, b):
        self.a = a
        self.b = b


@dataclasses.dataclass
class Item:
    name: str
    qty: int
    price: float = 1.0


def w_class_instantiate():
    return sum(Point(i, i).x for i in range(30000))


def w_class_method_attr():
    p = Point(3, 4)
    n = 0
    for _ in range(50000):
        n += p.norm2() + p.sum
    return n


def w_class_inherit_super():
    return sum(Point3(i, 1, 2).norm2() for i in range(15000))


def w_class_slots():
    objs = [Slotted(i, i + 1) for i in range(30000)]
    return sum(o.a + o.b for o in objs)


def w_dataclass():
    items = [Item(f"i{i}", i) for i in range(10000)]
    return sum(i.qty for i in items) + (items[5] == Item("i5", 5))


def w_dunder_ops():
    class V:
        __slots__ = ("v",)

        def __init__(self, v):
            self.v = v

        def __add__(self, o):
            return V(self.v + o.v)

        def __lt__(self, o):
            return self.v < o.v

    acc = V(0)
    one = V(1)
    for _ in range(30000):
        acc = acc + one
    return acc.v + len(sorted([V(i % 50) for i in range(2000)]))


def w_exceptions():
    n = 0
    for i in range(20000):
        try:
            if i % 2:
                raise ValueError(i)
            n += 1
        except ValueError as e:
            n += e.args[0] & 1
    return n


def w_generators():
    def gen(n):
        for i in range(n):
            yield i * 2

    return sum(gen(100000))


def w_counter():
    return collections.Counter(words).most_common(3)[0][1]


def w_defaultdict_group():
    groups = collections.defaultdict(list)
    for r in records * 5:
        groups[r["id"] % 17].append(r["id"])
    return len(groups) + sum(map(len, groups.values()))


def w_deque():
    d = collections.deque()
    for i in range(50000):
        d.append(i)
        if len(d) > 100:
            d.popleft()
    d.rotate(7)
    return d[0]


def w_namedtuple():
    P = collections.namedtuple("P", "x y")
    return sum(P(i, i).y for i in range(20000))


def w_itertools():
    n = sum(1 for _ in itertools.combinations(range(40), 3))
    n += sum(x for x, _ in zip(itertools.count(), itertools.repeat(None, 10000)))
    n += len(list(itertools.chain.from_iterable([[1, 2, 3]] * 5000)))
    n += sum(len(list(g)) for _, g in itertools.groupby(sorted(ints[:10000], key=lambda x: x % 10), key=lambda x: x % 10))
    return n


def w_functools():
    @functools.lru_cache(maxsize=None)
    def f(n):
        return n if n < 2 else f(n - 1) + f(n - 2)

    n = 0
    for i in range(300):
        f.cache_clear()
        n += f(60) & 0xFF
    p = functools.partial(add3, 1, 2)
    n += functools.reduce(lambda a, b: a + p(b), range(10000), 0)
    return n


def w_heapq():
    h = []
    for x in ints[:30000]:
        heapq.heappush(h, x)
    return sum(heapq.heappop(h) for _ in range(1000)) + heapq.nsmallest(5, ints)[0]


def w_bisect():
    s = sorted(ints)
    return sum(bisect.bisect_left(s, x) for x in ints[:30000])


def w_math():
    total = 0.0
    for i in range(1, 30000):
        total += math.sqrt(i) + math.sin(i) * math.log(i) + math.floor(i / 3)
    return round(total, 3)


def w_struct():
    packer = struct.Struct("<iId")
    n = 0
    for i in range(20000):
        a, b, c = packer.unpack(packer.pack(i, i * 2, i / 3))
        n += a + b
    return n


def w_base64_binascii():
    data = text_block.encode()
    n = 0
    for _ in range(10):
        n += len(base64.b64decode(base64.b64encode(data))) + binascii.crc32(data)
    return n


def w_hashlib():
    data = text_block.encode()
    n = 0
    for _ in range(20):
        n += len(hashlib.sha256(data).hexdigest()) + len(hashlib.md5(data).digest())
    return n


def w_csv_reader():
    return sum(int(row[2]) for row in csv.reader(io.StringIO(csv_text)))


def w_csv_writer():
    buf = io.StringIO()
    writer = csv.writer(buf)
    for i in range(5000):
        writer.writerow([i, f"user{i}", i * 1.5, "a,b"])
    return len(buf.getvalue())


def w_stringio():
    buf = io.StringIO()
    for i in range(30000):
        buf.write(str(i))
        buf.write("\n")
    return len(buf.getvalue().splitlines())


def w_textwrap():
    return len(textwrap.wrap(text_block[:40000], width=60)) + len(textwrap.dedent("    a\n    b\n" * 500))


def w_string_template():
    t = string.Template("$name has $qty items at $$${price}")
    return sum(len(t.substitute(name=f"n{i}", qty=i, price=i * 2)) for i in range(10000))


def w_datetime():
    start = datetime.datetime(2026, 1, 1, 12, 0, 0)
    n = 0
    for i in range(10000):
        d = start + datetime.timedelta(minutes=i * 37)
        n += d.weekday() + len(d.isoformat())
    return n + len(datetime.date(2026, 11, 16).strftime("%Y-%m-%d %A"))


def w_random():
    rng = random.Random(42)
    n = 0
    for _ in range(20000):
        n += rng.randint(0, 100)
    xs = list(range(5000))
    rng.shuffle(xs)
    return n + xs[0] + len(rng.sample(xs, 100))


def w_statistics():
    data = [x % 1000 for x in ints[:20000]]
    return round(statistics.mean(data) + statistics.median(data) + statistics.pstdev(data), 6)


def w_decimal():
    decimal.getcontext().prec = 28
    total = decimal.Decimal(0)
    for i in range(1, 5000):
        total += decimal.Decimal(i) / decimal.Decimal(7)
    return str(total.quantize(decimal.Decimal("0.0001")))


def w_fractions():
    total = fractions.Fraction(0)
    for i in range(1, 500):
        total += fractions.Fraction(1, i)
    return total.numerator % 1000003


def w_int_bigint():
    n = 1
    for i in range(1, 600):
        n *= i
    return len(str(n)) + (n % 1000003)


workloads = {name[2:]: fn for name, fn in globals().items() if name.startswith("w_") and callable(fn)}


def main():
    reps = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    names = sys.argv[2:] or list(workloads)
    out = {}
    try:
        for name in names:
            fn = workloads[name]
            check = repr(fn())
            samples = []
            for _ in range(reps):
                t = time.perf_counter_ns()
                fn()
                samples.append(time.perf_counter_ns() - t)
            samples.sort()
            out[name] = [samples[len(samples) // 2] if samples else 0, binascii.crc32(check.encode()) & 0xFFFFFFFF]
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    print(json.dumps(out))


main()
