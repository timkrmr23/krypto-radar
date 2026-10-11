"""Zeichnet die App-Symbole (Radar mit Signalpunkt) als PNG nach web/icons/. Nur numpy, keine Grafikbibliothek.

Aufruf aus dem Ordner krypto-radar:
    %LOCALAPPDATA%\\TradingDesk\\venv\\Scripts\\python.exe werkzeuge\\symbole.py
"""

import struct
import zlib
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parents[1] / "web" / "icons"
SIZES = (180, 192, 512)
SUPER = 4  # Kantenglättung durch Überabtastung


def hex_rgb(code: str) -> np.ndarray:
    return np.array([int(code[i:i + 2], 16) for i in (1, 3, 5)], dtype=float) / 255


def blend(image: np.ndarray, color: str, alpha: np.ndarray) -> None:
    image[...] = image * (1 - alpha[..., None]) + hex_rgb(color) * alpha[..., None]


def draw(size: int) -> np.ndarray:
    n = size * SUPER
    v, u = np.mgrid[0:n, 0:n]
    u = (u + 0.5) / n * 2 - 1
    v = (v + 0.5) / n * 2 - 1
    radius = np.hypot(u, v)
    image = np.empty((n, n, 3))
    top, bottom = hex_rgb("#13233a"), hex_rgb("#0a0f17")
    image[...] = top * (1 - (v[..., None] + 1) / 2) + bottom * ((v[..., None] + 1) / 2)

    angle = np.degrees(np.arctan2(u, -v)) % 360  # 0° = oben, im Uhrzeigersinn
    sweep = (angle <= 70) & (radius <= 0.78)
    blend(image, "#2ebd85", np.where(sweep, 0.42 * np.clip(1 - angle / 70, 0, 1) ** 1.5, 0.0))
    for ring in (0.27, 0.52, 0.77):
        blend(image, "#5b9bff", np.clip(1 - np.abs(radius - ring) / 0.022, 0, 1) * 0.6)
    blend(image, "#5b9bff", np.clip(1 - np.abs(u) / 0.012, 0, 1) * (radius <= 0.78) * 0.25)
    blend(image, "#5b9bff", np.clip(1 - np.abs(v) / 0.012, 0, 1) * (radius <= 0.78) * 0.25)

    dot = np.hypot(u - 0.33, v + 0.36)
    blend(image, "#2ebd85", np.clip(1 - dot / 0.26, 0, 1) ** 2 * 0.55)  # Leuchten
    blend(image, "#7dffc4", (dot <= 0.085).astype(float))
    blend(image, "#e8edf3", (radius <= 0.045).astype(float))

    image = image.reshape(size, SUPER, size, SUPER, 3).mean(axis=(1, 3))
    return (np.clip(image, 0, 1) * 255).round().astype(np.uint8)


def write_png(path: Path, rgb: np.ndarray) -> None:
    height, width, _ = rgb.shape
    raw = b"".join(b"\x00" + row.tobytes() for row in rgb)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8 Bit, RGB ohne Transparenz
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        write_png(OUT / f"icon-{size}.png", draw(size))
        print(f"icon-{size}.png")
