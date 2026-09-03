#!/usr/bin/env python3
"""把 PNG 帧合成 GIF。用法: gif.py <输出> <目标宽度> <duration JSON 数组> <帧文件...>

帧是 2 倍分辨率拍的，这里缩回目标宽度（超采样，字更干净），再统一调色板做增量优化：
每帧各自量化会让相邻帧的板子不一致，体积暴涨还会闪色。
"""
import json
import sys

from PIL import Image

out, width, durations, *frames = sys.argv[1:]
width = int(width)
durations = json.loads(durations)

images = []
for f in frames:
    im = Image.open(f).convert("RGB")
    if im.width != width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    images.append(im)

palette = images[0].quantize(colors=128, method=Image.MEDIANCUT)
quantized = [im.quantize(palette=palette, dither=Image.NONE) for im in images]

quantized[0].save(
    out,
    save_all=True,
    append_images=quantized[1:],
    duration=durations,
    loop=0,
    optimize=True,
    disposal=1,
)
print(f"  gif: {len(quantized)} 帧 {quantized[0].width}x{quantized[0].height}")
