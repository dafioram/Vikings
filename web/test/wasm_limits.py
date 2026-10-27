#!/usr/bin/env python3
"""wasm_limits.py — check vikings.wasm against the browsers' per-module limits.

V8 / SpiderMonkey / JSC reject a module whose function body exceeds 7 654 321
bytes (kV8MaxWasmFunctionSize; the JS-API limits of the spec) — the generated
executors are large units, and a link-time inliner that merges them into one
function produces a module that compiles nowhere. Prints the largest bodies
(named when the module keeps a name section: --profiling-funcs) and exits 1
when one is over.

  python3 web/test/wasm_limits.py web/dist/vikings.wasm [--top 8]
"""
import argparse
import sys

MAX_FUNCTION_SIZE = 7654321
MAX_FUNCTIONS = 1000000


def leb(b, p):
    r = s = 0
    while True:
        x = b[p]; p += 1
        r |= (x & 0x7f) << s; s += 7
        if not x & 0x80:
            return r, p


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('wasm')
    ap.add_argument('--top', type=int, default=8)
    a = ap.parse_args()
    b = open(a.wasm, 'rb').read()
    if b[:4] != b'\0asm':
        sys.exit(f'{a.wasm}: not a wasm module')
    p, imports, bodies, names = 8, 0, [], {}
    while p < len(b):
        sid = b[p]; size, p = leb(b, p + 1); end = p + size
        if sid == 2:   # imports: function imports shift the function indices
            n, q = leb(b, p)
            for _ in range(n):
                for _ in range(2):
                    l, q = leb(b, q); q += l
                kind = b[q]; q += 1
                if kind == 0: _, q = leb(b, q); imports += 1
                elif kind == 1: q += 1; fl, q = leb(b, q); _, q = leb(b, q); q = leb(b, q)[1] if fl & 1 else q
                elif kind == 2: fl, q = leb(b, q); _, q = leb(b, q); q = leb(b, q)[1] if fl & 1 else q
                elif kind == 3: q += 2
                elif kind == 4: q += 1; _, q = leb(b, q)
        elif sid == 10:   # code
            n, q = leb(b, p)
            for i in range(n):
                sz, q = leb(b, q); bodies.append((sz, imports + i)); q += sz
        elif sid == 0:   # custom: the name section's function names
            l, q = leb(b, p)
            if b[q:q + l] == b'name':
                q += l
                while q < end:
                    sub, q = b[q], q + 1; ssz, q = leb(b, q); se = q + ssz
                    if sub == 1:
                        n, r = leb(b, q)
                        for _ in range(n):
                            idx, r = leb(b, r); l2, r = leb(b, r)
                            names[idx] = b[r:r + l2].decode('utf-8', 'replace'); r += l2
                    q = se
        p = end
    bodies.sort(reverse=True)
    print(f'{a.wasm}: {len(bodies)} functions, code {sum(s for s, _ in bodies)} bytes')
    for sz, idx in bodies[:a.top]:
        print(f'  {sz:>10}  {names.get(idx, "#%d" % idx)}{"   <-- OVER THE LIMIT" if sz > MAX_FUNCTION_SIZE else ""}')
    over = [s for s, _ in bodies if s > MAX_FUNCTION_SIZE]
    if over or len(bodies) > MAX_FUNCTIONS:
        print(f'FAIL: {len(over)} function(s) over {MAX_FUNCTION_SIZE} bytes — browsers will not compile this module')
        return 1
    print(f'OK: every function within {MAX_FUNCTION_SIZE} bytes')
    return 0


if __name__ == '__main__':
    sys.exit(main())
