from PIL import Image, ImageDraw
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESOURCES = os.path.join(ROOT, "resources")
ICONSET = os.path.join(RESOURCES, "openvps.iconset")

os.makedirs(ICONSET, exist_ok=True)

SIZE = 1024
CENTER = SIZE // 2

img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Background: rounded square with subtle gradient
bg_top = (18, 22, 34)
bg_bottom = (11, 13, 18)
corner_radius = 220

# Draw gradient background manually
for y in range(SIZE):
    ratio = y / SIZE
    r = int(bg_top[0] * (1 - ratio) + bg_bottom[0] * ratio)
    g = int(bg_top[1] * (1 - ratio) + bg_bottom[1] * ratio)
    b = int(bg_top[2] * (1 - ratio) + bg_bottom[2] * ratio)
    draw.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))

# Mask to rounded rectangle
mask = Image.new("L", (SIZE, SIZE), 0)
mask_draw = ImageDraw.Draw(mask)
mask_draw.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=corner_radius, fill=255)
img.putalpha(mask)

draw = ImageDraw.Draw(img)

# Accent colors
cloud_color = (240, 248, 255, 245)
nest_color = (0, 212, 170, 255)
nest_highlight = (64, 232, 200, 255)

# Cloud: three overlapping circles
def draw_cloud(cx, cy, scale):
    r1 = int(110 * scale)
    r2 = int(130 * scale)
    r3 = int(110 * scale)
    draw.ellipse([cx - r1 - 80 * scale, cy - r1, cx - 80 * scale + r1, cy + r1], fill=cloud_color)
    draw.ellipse([cx + 80 * scale - r2, cy - r2 - 30 * scale, cx + 80 * scale + r2, cy + r2 - 30 * scale], fill=cloud_color)
    draw.ellipse([cx - r3 + 90 * scale, cy - r3 + 20 * scale, cx + r3 + 90 * scale, cy + r3 + 20 * scale], fill=cloud_color)

cloud_cx = CENTER
cloud_cy = CENTER - 70
draw_cloud(cloud_cx, cloud_cy, 1.0)

# Nest: bowl shape made of woven arcs
def draw_nest(cx, cy, scale):
    # Outer bowl
    width = int(340 * scale)
    height = int(160 * scale)
    y_offset = int(60 * scale)
    
    # Bottom arc
    draw.arc(
        [cx - width, cy - height + y_offset, cx + width, cy + height + y_offset],
        start=0,
        end=180,
        fill=nest_color,
        width=int(24 * scale),
    )
    
    # Cross weave arcs
    weave_count = 5
    for i in range(weave_count):
        t = (i - weave_count / 2) / (weave_count / 2)
        offset_x = int(t * 120 * scale)
        offset_y = int(abs(t) * 30 * scale)
        arc_width = int((170 - abs(t) * 60) * scale)
        arc_height = int((90 - abs(t) * 30) * scale)
        draw.arc(
            [cx - arc_width + offset_x, cy - arc_height + y_offset - offset_y,
             cx + arc_width + offset_x, cy + arc_height + y_offset - offset_y],
            start=200,
            end=340,
            fill=nest_highlight if i % 2 == 0 else nest_color,
            width=int(14 * scale),
        )

nest_cx = CENTER
nest_cy = CENTER + 80
draw_nest(nest_cx, nest_cy, 1.0)

# Save main PNG
main_png = os.path.join(RESOURCES, "openvps.png")
img.save(main_png)

# Save iconset sizes for icns
icon_sizes = [16, 32, 128, 256, 512]
for s in icon_sizes:
    icon_img = img.resize((s, s), Image.LANCZOS)
    icon_img.save(os.path.join(ICONSET, f"icon_{s}x{s}.png"))
    if s <= 512:
        icon_img2x = img.resize((s * 2, s * 2), Image.LANCZOS)
        icon_img2x.save(os.path.join(ICONSET, f"icon_{s}x{s}@2x.png"))

# Generate icns
icns_path = os.path.join(RESOURCES, "openvps.icns")
subprocess.run(["iconutil", "-c", "icns", "-o", icns_path, ICONSET], check=True)

# Generate Windows ico (multi-size)
try:
    ico_sizes = [16, 32, 48, 256]
    ico_images = [img.resize((s, s), Image.LANCZOS) for s in ico_sizes]
    ico_path = os.path.join(RESOURCES, "openvps.ico")
    ico_images[0].save(ico_path, format="ICO", sizes=[(s, s) for s in ico_sizes], append_images=ico_images[1:])
except Exception as e:
    print(f"ICO generation failed: {e}")

# Generate icons/ folder
icons_dir = os.path.join(RESOURCES, "icons")
os.makedirs(icons_dir, exist_ok=True)
for s in [16, 32, 128, 256, 512, 1024]:
    icon_img = img.resize((s, s), Image.LANCZOS)
    icon_img.save(os.path.join(icons_dir, f"{s}x{s}.png"))

print(f"Generated logo resources in {RESOURCES}")
