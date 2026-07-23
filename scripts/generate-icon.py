from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
RESOURCES = ROOT / "resources"
MASTER_PATH = RESOURCES / "openvps.png"
ICONSET_PATH = RESOURCES / "openvps.iconset"
ICNS_PATH = RESOURCES / "openvps.icns"

ICON_SIZES = [16, 32, 64, 128, 256, 512, 1024]


def hex_color(value: str) -> tuple[int, int, int, int]:
    value = value.lstrip("#")
    return tuple(int(value[i : i + 2], 16) for i in range(0, 6, 2)) + (255,)


def lerp_channel(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def blend(a: tuple[int, int, int, int], b: tuple[int, int, int, int], t: float) -> tuple[int, int, int, int]:
    return tuple(lerp_channel(ca, cb, t) for ca, cb in zip(a, b))


def build_background(size: int) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    square = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(square)

    inset = int(size * 0.08)
    radius = int(size * 0.22)
    rect = (inset, inset, size - inset, size - inset)

    top = hex_color("#0f172a")
    bottom = hex_color("#162033")
    for y in range(size):
        t = y / (size - 1)
        color = blend(top, bottom, t)
        draw.rounded_rectangle((0, y, size, y + 1), radius=radius, fill=color)

    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(rect, radius=radius, fill=255)
    square.putalpha(mask)

    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_color = (59, 130, 246, 34)
    glow_draw.rounded_rectangle(rect, radius=radius, outline=glow_color, width=max(4, size // 64))
    glow = glow.filter(ImageFilter.GaussianBlur(size // 56))

    highlight = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    highlight_draw = ImageDraw.Draw(highlight)
    highlight_draw.ellipse(
        (
            int(size * 0.22),
            int(size * 0.12),
            int(size * 0.78),
            int(size * 0.40),
        ),
        fill=(148, 163, 184, 12),
    )
    highlight = highlight.filter(ImageFilter.GaussianBlur(size // 14))
    highlight.putalpha(mask)

    canvas.alpha_composite(glow)
    canvas.alpha_composite(square)
    canvas.alpha_composite(highlight)
    return canvas


def draw_server_glyph(image: Image.Image) -> None:
    size = image.width
    shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    draw = ImageDraw.Draw(image)

    width = int(size * 0.50)
    height = int(size * 0.15)
    gap = int(size * 0.07)
    left = (size - width) // 2
    top = (size - (height * 2 + gap)) // 2
    radius = int(height * 0.30)
    stroke = max(18, size // 42)

    panels = [
        (left, top, left + width, top + height),
        (left, top + height + gap, left + width, top + height * 2 + gap),
    ]

    for panel in panels:
        shadow_draw.rounded_rectangle(
            (panel[0], panel[1] + size * 0.018, panel[2], panel[3] + size * 0.018),
            radius=radius,
            fill=(15, 23, 42, 125),
        )
    shadow = shadow.filter(ImageFilter.GaussianBlur(size // 28))
    image.alpha_composite(shadow)

    panel_fill = (255, 255, 255, 14)
    panel_outline = (241, 245, 249, 255)
    accent = (103, 232, 249, 255)

    for panel in panels:
        draw.rounded_rectangle(panel, radius=radius, fill=panel_fill, outline=panel_outline, width=stroke)

        dot_x = panel[0] + int(width * 0.16)
        dot_y = (panel[1] + panel[3]) // 2
        dot_r = int(height * 0.10)
        draw.ellipse((dot_x - dot_r, dot_y - dot_r, dot_x + dot_r, dot_y + dot_r), fill=accent)

        line_left = panel[0] + int(width * 0.30)
        line_right = panel[2] - int(width * 0.11)
        line_y = dot_y
        draw.line((line_left, line_y, line_right, line_y), fill=panel_outline, width=stroke, joint="curve")

    connector_x = left + width // 2
    connector_top = panels[0][3] + int(gap * 0.18)
    connector_bottom = panels[1][1] - int(gap * 0.18)
    draw.line(
        (connector_x, connector_top, connector_x, connector_bottom),
        fill=(148, 163, 184, 220),
        width=max(10, stroke // 2),
        joint="curve",
    )


def write_iconset(master: Image.Image) -> None:
    ICONSET_PATH.mkdir(parents=True, exist_ok=True)
    for base_size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            pixel_size = base_size * scale
            resized = master.resize((pixel_size, pixel_size), Image.Resampling.LANCZOS)
            suffix = "@2x" if scale == 2 else ""
            resized.save(ICONSET_PATH / f"icon_{base_size}x{base_size}{suffix}.png")


def main() -> None:
    size = 1024
    base = build_background(size)
    draw_server_glyph(base)
    base.save(MASTER_PATH)
    write_iconset(base)

    if ICNS_PATH.exists():
        ICNS_PATH.unlink()


if __name__ == "__main__":
    main()
