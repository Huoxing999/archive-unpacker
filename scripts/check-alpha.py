# -*- coding: utf-8 -*-
"""绕过 PIL 的 ICO 读取逻辑，直接抽 ICO 内嵌 PNG 数据检查 alpha。"""
import struct, io
from PIL import Image

BASE = r"C:\Users\999\Desktop\Code\C_C_Project\ArchiveUnpacker\build"
log = []

# 1) 独立 PNG 文件的 alpha
png = Image.open(BASE + r"\icon.png")
a = png.convert("RGBA").getchannel("A")
t = sum(1 for v in a.getdata() if v == 0)
log.append(f"icon.png {png.size}: transparent {t * 100.0 / (png.size[0] * png.size[1]):.1f}%")
corner = png.convert("RGBA").getpixel((2, 2))
log.append(f"icon.png corner pixel (2,2): {corner}")

# 2) 直接从 ICO 里抠出各 entry 的 PNG 字节解码
raw = open(BASE + r"\icon.ico", "rb").read()
count = struct.unpack("<HHH", raw[:6])[2]
for i in range(count):
    off = 6 + i * 16
    bw, bh, colors, res, planes, bpp, size, offset = struct.unpack("<BBBBHHII", raw[off:off + 16])
    w = bw or 256
    data = raw[offset:offset + size]
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        img = Image.open(io.BytesIO(data)).convert("RGBA")
        aa = img.getchannel("A")
        tt = sum(1 for v in aa.getdata() if v == 0)
        log.append(f"ICO entry {w}x{w}: PNG decoded {img.size}, transparent {tt * 100.0 / (img.size[0] * img.size[1]):.1f}%, corner={img.getpixel((1, 1))}")
    else:
        # BMP 编码的 entry（老格式，alpha 在 AND mask / 32bpp 里）
        log.append(f"ICO entry {w}x{w}: BMP-encoded, first bytes {data[:4].hex()}")

open(r"C:\Users\999\Desktop\Code\C_C_Project\ArchiveUnpacker\_alpha_check.txt", "w", encoding="utf-8").write("\n".join(log))
print("OK")
