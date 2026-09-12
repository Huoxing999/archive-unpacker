# -*- coding: utf-8 -*-
"""校验生成的 ICO：结构尺寸表 + 各尺寸视觉效果（棋盘格背景看透明度）。"""
import struct, os
from PIL import Image

ICO = r"C:\Users\999\Desktop\Code\C_C_Project\ArchiveUnpacker\build\icon.ico"
OUT = r"C:\Users\999\Desktop\Code\C_C_Project\ArchiveUnpacker\build\_preview.png"

log = []
raw = open(ICO, "rb").read()
reserved, itype, count = struct.unpack("<HHH", raw[:6])
log.append(f"ICONDIR: reserved={reserved} type={itype} count={count}")
for i in range(count):
    off = 6 + i * 16
    bw, bh, colors, res, planes, bpp, size, offset = struct.unpack("<BBBBHHII", raw[off:off + 16])
    w = bw or 256
    h = bh or 256
    head = raw[offset:offset + 8]
    kind = "PNG" if head[:8] == b"\x89PNG\r\n\x1a\n" else "BMP"
    log.append(f"  entry {i}: {w}x{h} {bpp}bpp {kind} bytes={size}")

ico = Image.open(ICO)
frames = []
for s in [256, 128, 64, 48, 32, 24, 16]:
    try:
        ico.size = (s, s)
        f = ico.convert("RGBA").copy()
        # 检查透明像素占比
        alphas = f.getchannel("A").getdata()
        transparent = sum(1 for v in alphas if v == 0)
        log.append(f"  {s}x{s}: transparent pixels {transparent * 100.0 / (s * s):.1f}%")
        frames.append((s, f))
    except Exception as e:
        log.append(f"  {s}x{s}: FAIL {e}")

# 棋盘格背景拼图，每个尺寸统一放大到 160 显示
CELL = 160
tile = 16
pad = 12
W = sum(CELL + pad for _ in frames) + pad
H = CELL + 2 * pad
canvas = Image.new("RGB", (W, H), (245, 245, 248))
board = Image.new("RGB", (CELL, CELL), (255, 255, 255))
bp = board.load()
for y in range(CELL):
    for x in range(CELL):
        if ((x // tile) + (y // tile)) % 2 == 0:
            bp[x, y] = (205, 205, 212)
x = pad
for s, f in frames:
    big = f.resize((CELL, CELL), Image.NEAREST)
    canvas.paste(board, (x, pad))
    canvas.paste(big, (x, pad), big)
    x += CELL + pad
canvas.save(OUT, "PNG")
log.append(f"preview: {OUT}")

open(r"C:\Users\999\Desktop\Code\C_C_Project\ArchiveUnpacker\_icon_check.txt", "w", encoding="utf-8").write("\n".join(log))
print("OK")
