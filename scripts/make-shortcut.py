# -*- coding: utf-8 -*-
"""在桌面创建「批量解压工具」快捷方式（指向目录版 exe，图标用 build/icon.ico）。"""
import os
import win32com.client

BASE = r"C:\Users\999\Desktop\Code\C_C_Project\ArchiveUnpacker"
DESK = os.path.join(os.path.expanduser("~"), "Desktop")
LNK = os.path.join(DESK, "批量解压工具.lnk")
TARGET = os.path.join(BASE, "release", "win-unpacked", "ArchiveUnpacker.exe")
ICON = os.path.join(BASE, "build", "icon.ico")

log = []
log.append(f"target exists: {os.path.exists(TARGET)}")
log.append(f"icon exists: {os.path.exists(ICON)}")

shell = win32com.client.Dispatch("WScript.Shell")
link = shell.CreateShortCut(LNK)
link.TargetPath = TARGET
link.WorkingDirectory = BASE
link.IconLocation = ICON + ",0"
link.Description = "批量解压工具"
link.WindowStyle = 1
link.Save()
log.append(f"created: {os.path.exists(LNK)}")

# 读回校验
check = shell.CreateShortCut(LNK)
log.append(f"readback target = {check.TargetPath}")
log.append(f"readback workdir = {check.WorkingDirectory}")
log.append(f"readback icon = {check.IconLocation}")
log.append(f"readback desc = {check.Description}")

open(os.path.join(BASE, "_lnk_result.txt"), "w", encoding="utf-8").write("\n".join(log))
