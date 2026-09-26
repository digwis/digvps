#!/usr/bin/env python3
"""Generate OpenVPS app icon: dark squircle + glowing server rack."""
import os
from PIL import Image, ImageDraw, ImageFilter

S = 4  # supersample
SIZE = 1024
W = SIZE * S

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))

def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)

def make_icon():
    img = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Squircle-ish background (macOS: icon body ~ 824/1024, margin ~100px)
    m = int(W * 0.08)
    box = (m, m, W - m, W - m)
    r = int(W * 0.225)

    # vertical gradient dark slate -> deep navy blue
    grad = Image.new("RGBA", (W - 2 * m, W - 2 * m))
    gd = ImageDraw.Draw(grad)
    top = (16, 22, 34)
    bot = (10, 14, 26)
    h = W - 2 * m
    for y in range(h):
        gd.line([(0, y), (grad.width, y)], fill=lerp(top, bot, y / h) + (255,))
    mask = Image.new("L", grad.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, grad.width, grad.height), radius=r, fill=255)
    img.paste(grad, (m, m), mask)
    d = ImageDraw.Draw(img)

    # subtle top highlight
    hi = Image.new("RGBA", grad.size, (0, 0, 0, 0))
    ImageDraw.Draw(hi).rounded_rectangle((0, 0, grad.width, int(grad.height * 0.5)),
                                         radius=r, fill=(255, 255, 255, 14))
    hi = hi.filter(ImageFilter.GaussianBlur(30 * S))
    img.paste(hi, (m, m), Image.new("L", grad.size, 0).point(lambda _: 0) if False else hi.split()[3].point(lambda a: a))
    # simpler: paste with its own alpha
    # (redo cleanly)
    img.paste(hi, (m, m), hi.split()[3])

    # inner border stroke
    d.rounded_rectangle(box, radius=r, outline=(255, 255, 255, 30), width=3 * S)

    # --- server rack: 3 rounded bars + LED dots ---
    cx = W / 2
    bar_w = int(W * 0.52)
    bar_h = int(W * 0.115)
    gap = int(W * 0.055)
    total_h = bar_h * 3 + gap * 2
    top_y = int((W - total_h) / 2) - int(W * 0.01)

    bars_layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    bd = ImageDraw.Draw(bars_layer)

    bar_top_c = (96, 165, 250)   # blue-400
    bar_bot_c = (56, 130, 246)   # deeper blue
    led_c = (52, 211, 153)       # emerald
    for i in range(3):
        y0 = top_y + i * (bar_h + gap)
        x0 = int(cx - bar_w / 2)
        x1 = int(cx + bar_w / 2)
        y1 = y0 + bar_h
        br = int(bar_h * 0.32)
        # gradient bar
        bar = Image.new("RGBA", (x1 - x0, y1 - y0))
        bdraw = ImageDraw.Draw(bar)
        for yy in range(bar.height):
            bdraw.line([(0, yy), (bar.width, yy)],
                       fill=lerp(bar_top_c, bar_bot_c, yy / bar.height) + (255,))
        bmask = Image.new("L", bar.size, 0)
        ImageDraw.Draw(bmask).rounded_rectangle((0, 0, bar.width, bar.height), radius=br, fill=255)
        bars_layer.paste(bar, (x0, y0), bmask)
        # LED dot
        led_r = int(bar_h * 0.16)
        lx = x0 + int(bar_w * 0.08)
        ly = y0 + bar_h // 2
        bd.ellipse((lx - led_r, ly - led_r, lx + led_r, ly + led_r), fill=led_c + (255,))
        # small "drive" slot line on right
        sx0 = x0 + int(bar_w * 0.72)
        sx1 = x0 + int(bar_w * 0.92)
        bd.rounded_rectangle((sx0, ly - int(bar_h*0.09), sx1, ly + int(bar_h*0.09)),
                             radius=int(bar_h*0.09), fill=(255, 255, 255, 110))

    # glow behind bars
    glow = bars_layer.filter(ImageFilter.GaussianBlur(28 * S))
    img.alpha_composite(glow)
    img.alpha_composite(bars_layer)

    # downscale
    return img.resize((SIZE, SIZE), Image.LANCZOS)

def main():
    out = "/tmp/openvps-icon"
    os.makedirs(out, exist_ok=True)
    icon = make_icon()
    icon.save(f"{out}/icon.png")

    dst = "/Volumes/SanDisk Extreme 1TB/开发应用/Electron/openvps/src-tauri/icons"
    icon.save(f"{dst}/icon.png")
    for name, size in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256)]:
        icon.resize((size, size), Image.LANCZOS).save(f"{dst}/{name}")

    # iconset for icns
    iset = f"{out}/icon.iconset"
    os.makedirs(iset, exist_ok=True)
    for base, px in [("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
                     ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
                     ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
                     ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
                     ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024)]:
        icon.resize((px, px), Image.LANCZOS).save(f"{iset}/{base}")

    # ico (multi-size) via PIL
    icon.save(f"{dst}/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("done")

if __name__ == "__main__":
    main()
