# -*- coding: utf-8 -*-
"""
从源图生成项目图标：build/icon.ico（多尺寸）+ build/icon.png。

处理要点
  1. 抠掉边缘连通的白底（flood fill 只吃「从四角连得上的白」，主体内部的高光白不动）；
  2. 按内容裁切并补成正方形（图标填满画布，不留大片空白）；
  3. ICO 一次带全 Windows 需要的尺寸，16px 也不糊到认不出。
"""
from PIL import Image, ImageDraw, ImageFilter

SRC = r"C:\Users\999\.workbuddy\clipboard-images\clipboard-2026-09-12T07-57-21-109Z-4117c78b.jpg"
OUT_DIR = r"C:\Users\999\Desktop\Code\C_C_Project\ArchiveUnpacker\build"

log = []

im = Image.open(SRC).convert("RGBA")
log.append(f"source: {im.size} {im.mode}")

# ---- 1) 抠白底：只吃与边缘连通的白 ----
r, g, b, a = im.split()
# 近白像素（抗锯齿边缘的浅灰也算，减少白边残留）
WHITE_T = 232
white_mask = Image.new("L", im.size, 0)
px_mask = white_mask.load()
px = im.load()
w, h = im.size
for y in range(h):
    for x in range(w):
        rr, gg, bb, aa = px[x, y]
        if rr >= WHITE_T and gg >= WHITE_T and bb >= WHITE_T and aa > 0:
            px_mask[x, y] = 255

# 从四角 flood fill 标记「边缘白」，结果塞到 128
marked = white_mask.copy()
for seed in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
    if marked.getpixel(seed) == 255:
        ImageDraw.floodfill(marked, seed, 128, thresh=0)

# 注意：getchannel 返回的是独立副本，必须改副本再 putalpha 回去，
# 直接改 getchannel(...).load() 是不生效的（踩过）。
alpha = im.getchannel("A").copy()
alpha_px = alpha.load()
marked_px = marked.load()
cleared = 0
for y in range(h):
    for x in range(w):
        if marked_px[x, y] == 128:
            alpha_px[x, y] = 0
            cleared += 1
log.append(f"cleared edge-white pixels: {cleared} ({cleared * 100.0 / (w * h):.1f}%)")

# 羽化 alpha 边缘一点，缩小时不留硬锯齿
alpha = alpha.filter(ImageFilter.GaussianBlur(0.6))
im.putalpha(alpha)

# ---- 2) 按内容裁切 + 补成正方形 ----
bbox = im.getbbox()
log.append(f"content bbox: {bbox}")
bw, bh = bbox[2] - bbox[0], bbox[3] - bbox[1]
cx, cy = (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2
side = int(max(bw, bh) * 1.10)  # 留一点边距
side = min(side, max(w, h))
left = int(round(cx - side / 2))
top = int(round(cy - side / 2))
left = max(0, min(left, w - side))
top = max(0, min(top, h - side))
master = im.crop((left, top, left + side, top + side))
log.append(f"square crop: ({left},{top}) side={side}")

# ---- 3) 输出 ----
import os
os.makedirs(OUT_DIR, exist_ok=True)

MASTER = 512
master512 = master.resize((MASTER, MASTER), Image.LANCZOS)
master512.save(os.path.join(OUT_DIR, "icon.png"), "PNG")
log.append("wrote icon.png (512x512)")

sizes = [256, 128, 64, 48, 40, 32, 24, 20, 16]
master512.save(os.path.join(OUT_DIR, "icon.ico"), "ICO", sizes=[(s, s) for s in sizes])
log.append(f"wrote icon.ico sizes={sizes}")

ico_path = os.path.join(OUT_DIR, "icon.ico")
log.append(f"ico bytes: {os.path.getsize(ico_path)}")

open(r"C:\Users\999\Desktop\Code\C_C_Project\ArchiveUnpacker\_icon_log.txt", "w", encoding="utf-8").write("\n".join(log))
print("DONE")
