"""Generate the extension PNG icons with the Python standard library only."""
from __future__ import annotations

import struct
import zlib
from pathlib import Path


def _chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def make_icon(size: int) -> bytes:
    purple = (124, 58, 237, 255)
    white = (255, 255, 255, 255)
    transparent = (0, 0, 0, 0)
    radius = max(2, size // 5)
    x0, x1 = int(size * 0.22), int(size * 0.78)
    y0, y1 = int(size * 0.28), int(size * 0.66)
    dot_radius = max(1, size // 28)
    dot_positions = [int(size * f) for f in (0.38, 0.50, 0.62)]
    dot_y = int(size * 0.47)

    rows: list[bytes] = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            cx = min(max(x, radius), size - 1 - radius)
            cy = min(max(y, radius), size - 1 - radius)
            pixel = transparent
            if (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2:
                pixel = purple
                if x0 <= x <= x1 and y0 <= y <= y1:
                    pixel = white
                    for dx in dot_positions:
                        if (x - dx) ** 2 + (y - dot_y) ** 2 <= dot_radius ** 2:
                            pixel = purple
                            break
                elif y1 < y <= int(size * 0.80) and int(size * 0.30) <= x <= int(size * 0.30) + (y - y1):
                    pixel = white
            row.extend(pixel)
        rows.append(bytes(row))

    raw = b"".join(b"\x00" + row for row in rows)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(raw, 9)) + _chunk(b"IEND", b""))


def main() -> None:
    folder = Path(__file__).resolve().parents[1] / "icons"
    folder.mkdir(parents=True, exist_ok=True)
    for size in (16, 48, 128):
        (folder / f"icon{size}.png").write_bytes(make_icon(size))
    print(f"Wrote icons to {folder}")


if __name__ == "__main__":
    main()
