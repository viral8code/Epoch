"""Draws the Epoch icon (a counter-clockwise arrow around a dot: time going back) and writes
the PNG and ICO files that the Tauri build expects. Needs only the Python standard library.

    python scripts/make-icons.py
"""

import math
import pathlib
import struct
import zlib

OUT = pathlib.Path(__file__).resolve().parent.parent / "icons"


RING = 0.29
WIDTH = 0.055
GAP_FROM, GAP_TO = 70, 110


def arrow_head():
    """Triangle (screen coordinates, y down) at the 70-degree end, pointing counter-clockwise."""
    t = math.radians(GAP_FROM)
    bx, by = 0.5 + RING * math.cos(t), 0.5 - RING * math.sin(t)
    # Counter-clockwise tangent and outward normal, in y-down coordinates.
    tx, ty = -math.sin(t), -math.cos(t)
    nx, ny = math.cos(t), -math.sin(t)
    length, half = 0.13, 0.11
    return ((bx + tx * length, by + ty * length), (bx + nx * half, by + ny * half), (bx - nx * half, by - ny * half))


def inside(x, y, triangle):
    (x1, y1), (x2, y2), (x3, y3) = triangle
    d1 = (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2)
    d2 = (x - x3) * (y2 - y3) - (x2 - x3) * (y - y3)
    d3 = (x - x1) * (y3 - y1) - (x3 - x1) * (y - y1)
    negative = d1 < 0 or d2 < 0 or d3 < 0
    positive = d1 > 0 or d2 > 0 or d3 > 0
    return not (negative and positive)


HEAD = arrow_head()


def shade(x, y, size):
    """Colour of one sample point in [0, size)^2, as (r, g, b, a) floats in 0..1."""
    s = size
    u, v = x / s, y / s
    # Rounded square.
    r = 0.2
    dx = max(abs(u - 0.5) - (0.5 - r), 0)
    dy = max(abs(v - 0.5) - (0.5 - r), 0)
    if dx * dx + dy * dy > r * r:
        return (0, 0, 0, 0)
    t = (u + v) / 2
    bg = (0.20 + 0.15 * t, 0.16 + 0.12 * t, 0.55 + 0.30 * t)
    cx, cy = u - 0.5, v - 0.5
    dist = math.hypot(cx, cy)
    angle = math.degrees(math.atan2(-cy, cx)) % 360  # counter-clockwise from +x, y up
    white = (1.0, 1.0, 1.0, 1.0)
    # The arc runs counter-clockwise from 110 degrees all the way round to 70 degrees, leaving a
    # gap at the top. The head sits on the 70-degree end and points on, counter-clockwise, into
    # the gap: a "rewind" arrow.
    if abs(dist - RING) < WIDTH and not (GAP_FROM < angle < GAP_TO):
        return white
    if inside(u, v, HEAD):
        return white
    if dist < 0.075:
        return (1.0, 0.82, 0.35, 1.0)
    return (*bg, 1.0)


def render(size, samples=4):
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(samples):
                for sx in range(samples):
                    c = shade(x + (sx + 0.5) / samples, y + (sy + 0.5) / samples, size)
                    acc[0] += c[0] * c[3]
                    acc[1] += c[1] * c[3]
                    acc[2] += c[2] * c[3]
                    acc[3] += c[3]
            n = samples * samples
            alpha = acc[3] / n
            if alpha > 0:
                rgb = [acc[i] / acc[3] for i in range(3)]
            else:
                rgb = [0, 0, 0]
            row += bytes([round(rgb[0] * 255), round(rgb[1] * 255), round(rgb[2] * 255), round(alpha * 255)])
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def ico(pngs):
    header = struct.pack("<HHH", 0, 1, len(pngs))
    offset = 6 + 16 * len(pngs)
    entries, data = b"", b""
    for size, png in pngs:
        dim = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png), offset + len(data))
        data += png
    return header + entries + data


def main():
    OUT.mkdir(exist_ok=True)
    images = {size: render(size) for size in (16, 32, 48, 128, 256)}
    (OUT / "32x32.png").write_bytes(images[32])
    (OUT / "128x128.png").write_bytes(images[128])
    (OUT / "icon.png").write_bytes(images[256])
    (OUT / "icon.ico").write_bytes(ico([(s, images[s]) for s in (16, 32, 48, 256)]))
    print("icons written to", OUT)


if __name__ == "__main__":
    main()
