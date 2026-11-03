"""Make an AI-upscaled HD pack for the browser engine from your own G-Nome.

    python3 tools/hdpack.py GAME_FOLDER OUT.zip [--model M.pth] [--only 2d|3d]

Every 2D bitmap (menus, cockpits, HUD art) and every 3D model texture goes
through a Real-ESRGAN network (tools/sr_onnx.py, run by onnxruntime on the
CPU) and is saved as WebP in a zip. Load the zip with the "HD pack" button
in the web engine's Graphics row. The pack is made from your game files, so
like them it must not be committed or shared.

Pictures are palette indices, and the palette changes per world, so the
pack is keyed by the picture as the engine sees it: a hash of its RGBA
(see `image_key`, the same as web/src/hdpack.js). Each picture is hashed
under the menu palette and every world palette; each distinct result is
upscaled once.

Needs: pip install numpy pillow onnx onnxruntime
Model weights (BSD-3-Clause), from https://github.com/xinntao/Real-ESRGAN/releases:
  realesr-general-x4v3.pth   default; fast (about 10 minutes for the game)
  RealESRGAN_x4plus.pth      sharper, about 20x slower
"""
import argparse
import io
import json
import sys
import time
import zipfile
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import gnome_extract as g  # noqa: E402
import sr_onnx  # noqa: E402

M1, X1 = np.uint32(0x9E3779B1), np.uint32(0x85EBCA77)
M2, X2 = np.uint32(0x85EBCA77), np.uint32(0xC2B2AE3D)


def image_key(rgba, w, h):
    """16 hex digits for a w x h RGBA picture (alpha 0 pixels all zero).
    Sum over pixels of word_i * k(i), wrapping at 32 bits, twice with
    different constants: order-sensitive and vectorizable in numpy and JS."""
    words = rgba.reshape(-1, 4).astype(np.uint32)
    words = words[:, 0] | (words[:, 1] << 8) | (words[:, 2] << 16) | (words[:, 3] << 24)
    i = np.arange(1, len(words) + 1, dtype=np.uint32)
    with np.errstate(over="ignore"):
        a = np.sum(words * ((i * M1) ^ X1), dtype=np.uint32)
        b = np.sum(words * ((i * M2) ^ X2), dtype=np.uint32)
        a ^= np.uint32(w) * np.uint32(0x27D4EB2D) ^ np.uint32(h)
        b ^= np.uint32(h) * np.uint32(0x165667B1) ^ np.uint32(w)
    return f"{int(a):08x}{int(b):08x}"


def palettes(bin_data, entries):
    """Every palette the engine can show a picture under, as 256x3 arrays."""
    sec = g.bin_sections(bin_data)
    menu = np.array(g.palette_from_236(sec["palette"]), np.uint8)
    out = {menu.tobytes(): menu}
    buf = sec.get("script", b"")
    for e in entries:
        if e.type == 17 and e.offset + e.size <= len(buf) and e.size == 944:
            world = np.array(g.palette_from_236(buf[e.offset:e.offset + e.size]), np.uint8)
            hybrid = menu.copy()
            hybrid[186:246] = world[186:246]
            for p in (world, hybrid):
                out[p.tobytes()] = p
    return list(out.values())


def pictures(game, only):
    """(kind, label, w, h, indices) for every bitmap and texture."""
    bin_data = g.find_file(game, "G-NOME.BIN").read_bytes()
    entries = g.read_index(bin_data)
    packs = g.Packs(game)
    pals = palettes(bin_data, entries)
    pics = []
    for e in entries:
        if not e.size or e.type not in (1, 2):
            continue
        kind = "2d" if e.type == 1 else "3d"
        if only and kind != only:
            continue
        try:
            data = packs.read(e)
            bms = [(str(e.index), g.parse_bitmap(data))] if e.type == 1 else \
                [(f"{e.index}:{g.bmp_name(p)}", b) for p, b in g.texture_records(data)]
        except (OSError, ValueError):
            continue
        for label, bm in bms:
            if bm.width < 2 or bm.height < 2:
                continue
            try:
                px = np.frombuffer(g.bitmap_pixels(bm), np.uint8)
            except (ValueError, IndexError):
                continue
            if len(px) != bm.width * bm.height:
                continue
            pics.append((kind, label, bm.width, bm.height, px))
    return pics, pals


def rgba_of(px, pal, w, h):
    rgba = np.zeros((h, w, 4), np.uint8)
    flat = rgba.reshape(-1, 4)
    flat[:, :3] = pal[px]
    flat[:, 3] = 255
    flat[px == 0] = 0
    return rgba


def bleed(rgb, alpha):
    """Fill see-through pixels' colour from opaque neighbours (so the
    network and the filtering don't pull black into edges)."""
    rgb = rgb.astype(np.float32)
    known = alpha > 0
    if known.all() or not known.any():
        return rgb
    for _ in range(64):
        if known.all():
            break
        acc = np.zeros_like(rgb)
        n = np.zeros(known.shape, np.float32)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx or dy:
                    k = np.roll(np.roll(known, dy, 0), dx, 1)
                    acc += np.roll(np.roll(rgb, dy, 0), dx, 1) * k[..., None]
                    n += k
        new = ~known & (n > 0)
        rgb[new] = acc[new] / n[new][:, None]
        known = known | new
    return rgb


class Upscaler:
    def __init__(self, pth):
        model = sr_onnx.to_onnx(pth).SerializeToString()
        self.s = ort.InferenceSession(model, providers=["CPUExecutionProvider"])

    def run(self, rgb, wrap, tile=256, pad=12):
        """x4 of an h x w x 3 float image 0..255. wrap: tile the edges (3D
        textures repeat), else replicate them."""
        h, w, _ = rgb.shape
        src = np.pad(rgb, ((pad, pad), (pad, pad), (0, 0)), mode="wrap" if wrap else "edge") / 255
        out = np.zeros((h * 4, w * 4, 3), np.float32)
        for y in range(0, h, tile):
            for x in range(0, w, tile):
                th, tw = min(tile, h - y), min(tile, w - x)
                part = src[y:y + th + 2 * pad, x:x + tw + 2 * pad]
                r = self.s.run(None, {"input": part.transpose(2, 0, 1)[None].astype(np.float32)})[0][0]
                out[y * 4:(y + th) * 4, x * 4:(x + tw) * 4] = r.transpose(1, 2, 0)[pad * 4:(pad + th) * 4, pad * 4:(pad + tw) * 4]
        return np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("game", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--model", type=Path, default=Path("realesr-general-x4v3.pth"))
    ap.add_argument("--only", choices=["2d", "3d"])
    ap.add_argument("--scale-2d", type=int, default=4, choices=[2, 3, 4], help="stored size for 2D art (default 4x)")
    ap.add_argument("--scale-3d", type=int, default=2, choices=[2, 3, 4], help="stored size for textures (default 2x)")
    ap.add_argument("--quality", type=int, default=88, help="WebP quality")
    ap.add_argument("--limit", type=int, default=0, help="stop after this many pictures (testing)")
    args = ap.parse_args()

    game = g.find_game_folder(args.game)
    pics, pals = pictures(game, args.only)
    print(f"{len(pics)} pictures, {len(pals)} palettes", flush=True)
    jobs = {}  # key -> (kind, label, w, h, rgba)
    for kind, label, w, h, px in pics:
        used = np.unique(px)
        seen = set()
        for pal in pals:
            sig = pal[used].tobytes()
            if sig in seen:
                continue
            seen.add(sig)
            rgba = rgba_of(px, pal, w, h)
            key = image_key(rgba, w, h)
            if key not in jobs:
                jobs[key] = (kind, label, w, h, rgba)
    total = sum(w * h for _, _, w, h, _ in jobs.values())
    print(f"{len(jobs)} distinct pictures, {total / 1e6:.1f} M pixels", flush=True)

    up = Upscaler(args.model)
    manifest = {"version": 1, "model": args.model.name, "images": {}}
    old = {}
    if args.out.exists():  # resume: keep what an earlier run made
        with zipfile.ZipFile(args.out) as z:
            if "manifest.json" in z.namelist():
                for k, v in json.loads(z.read("manifest.json"))["images"].items():
                    old[k] = (v, z.read(v["file"]))
    tmp = args.out.with_suffix(".part")
    done, px_done, t0 = 0, 0, time.time()
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:
        for key, (kind, label, w, h, rgba) in jobs.items():
            if args.limit and done >= args.limit:
                break
            file = f"{kind}/{key}.webp"
            if key in old:
                manifest["images"][key] = old[key][0]
                z.writestr(file, old[key][1])
                done += 1
                continue
            s = args.scale_2d if kind == "2d" else args.scale_3d
            alpha = rgba[..., 3]
            big = up.run(bleed(rgba[..., :3], alpha), wrap=kind == "3d")
            img = Image.fromarray(big, "RGB")
            if s != 4:
                img = img.resize((w * s, h * s), Image.LANCZOS)
            if (alpha < 255).any():
                a = Image.fromarray(alpha, "L").resize((w * s, h * s), Image.BICUBIC)
                img = img.convert("RGBA")
                img.putalpha(a)
            buf = io.BytesIO()
            img.save(buf, "WEBP", quality=args.quality, method=4, alpha_quality=100)
            z.writestr(file, buf.getvalue())
            manifest["images"][key] = {"file": file, "w": w, "h": h, "scale": s, "src": label}
            done += 1
            px_done += w * h
            if done % 100 == 0:
                rate = px_done / max(time.time() - t0, 1e-6)
                print(f"{done}/{len(jobs)}  {rate / 1e3:.0f} k px/s  ~{(total - px_done) / max(rate, 1) / 60:.0f} min left", flush=True)
        z.writestr("manifest.json", json.dumps(manifest))
    tmp.replace(args.out)
    print(f"wrote {args.out} ({len(manifest['images'])} pictures, {args.out.stat().st_size / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
