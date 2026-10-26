#!/usr/bin/env python3
"""sha256 of a Soroban wasm with its `contractmetav0` custom sections removed.

deploy.sh builds with `--meta source_repo=… --meta commit_sha=…` (SEP-46 /
SEP-55 provenance, Raven STD-05), so the raw wasm hash changes on every
commit even when the code is the same. Reuse decisions compare this hash
instead: same code + same spec = same hash, whatever the meta says.

  scripts/wasm-code-hash.py FILE...    # prints "<hash>  <file>" per file
"""
import hashlib
import sys

MAGIC = b"\0asm\x01\0\0\0"
META_SECTION = b"contractmetav0"


def _uleb(buf: bytes, pos: int) -> tuple[int, int]:
    val = shift = 0
    while True:
        b = buf[pos]
        pos += 1
        val |= (b & 0x7F) << shift
        if b < 0x80:
            return val, pos
        shift += 7


def strip_meta(wasm: bytes) -> bytes:
    if wasm[:8] != MAGIC:
        raise ValueError("not a wasm module")
    out = bytearray(wasm[:8])
    pos = 8
    while pos < len(wasm):
        start = pos
        sid = wasm[pos]
        size, body = _uleb(wasm, pos + 1)
        end = body + size
        if end > len(wasm):
            raise ValueError("truncated section")
        if sid == 0:
            nlen, npos = _uleb(wasm, body)
            if wasm[npos:npos + nlen] == META_SECTION:
                pos = end
                continue
        out += wasm[start:end]
        pos = end
    return bytes(out)


def code_hash(wasm: bytes) -> str:
    return hashlib.sha256(strip_meta(wasm)).hexdigest()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for path in sys.argv[1:]:
        with open(path, "rb") as f:
            print(f"{code_hash(f.read())}  {path}")
