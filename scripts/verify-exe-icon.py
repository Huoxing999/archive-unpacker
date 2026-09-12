# -*- coding: utf-8 -*-
"""在指定的 exe 里搜 icon.ico 各尺寸的 PNG 字节，验证图标嵌入情况。"""
import struct, os, sys

BASE = r"C:\Users\999\Desktop\Code\C_C_Project\ArchiveUnpacker"
ICO = os.path.join(BASE, "build", "icon.ico")
TARGETS = sys.argv[1:] or [os.path.join(BASE, "release", "批量解压工具.exe")]
out = []

ico_raw = open(ICO, "rb").read()
count = struct.unpack("<HHH", ico_raw[:6])[2]
out.append(f"icon.ico: {len(ico_raw)} bytes, {count} entries")

for target in TARGETS:
    if not os.path.exists(target):
        out.append(f"\n--- {target}: MISSING")
        continue
    raw = open(target, "rb").read()
    out.append(f"\n--- {os.path.basename(target)}: {len(raw)/1024/1024:.1f} MB")
    hits = 0
    for i in range(count):
        off = 6 + i * 16
        bw, bh, colors, res, planes, bpp, size, offset = struct.unpack("<BBBBHHII", ico_raw[off:off + 16])
        w = bw or 256
        data = ico_raw[offset:offset + size]
        if data[:8] != b"\x89PNG\r\n\x1a\n":
            continue
        if raw.find(data) >= 0:
            hits += 1
            out.append(f"   {w}x{w}: exact match FOUND")
        elif raw.find(data[:64]) >= 0:
            hits += 1
            out.append(f"   {w}x{w}: header FOUND (payload repacked)")
        else:
            out.append(f"   {w}x{w}: not found as raw bytes")
    out.append(f"   => matched {hits}/{count}")

open(os.path.join(BASE, "_portable_icon_check.txt"), "w", encoding="utf-8").write("\n".join(out))
