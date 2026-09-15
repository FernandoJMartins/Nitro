"""Testes da distorção de texto estilo "Fisheye" (Instagram Edits) — sem ffmpeg.

Verifica os 6 presets (fisheye/curve/bulge/warp/wave/stretch) na transformação
Pillow: dimensões, propriedade "centro expandido / pontas comprimidas" do
Fisheye (via gradiente suave + derivada do perfil), direção da curvatura do
Curve (∪) e renderização de todos os presets sem perder conteúdo.
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from app.services import video
from app.services.video import TEXT_FISHEYE_PRESETS, _apply_fisheye

tmp = Path("_test_fisheye")
tmp.mkdir(exist_ok=True)

W, H, MAXV = 240, 40, 220


def make_gradient() -> Image.Image:
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = img.load()
    for x in range(W):
        v = int(MAXV * x / (W - 1))
        for y in range(H):
            px[x, y] = (v, v, v, 255)
    return img


def make_flat_text(text="IIIIII") -> Image.Image:
    font = ImageFont.truetype(
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf", 64
    )
    d = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    x0, y0, x1, y1 = d.textbbox((0, 0), text, font=font, stroke_width=3)
    img = Image.new("RGBA", (x1 - x0 + 6, y1 - y0 + 6), (0, 0, 0, 0))
    ImageDraw.Draw(img).text(
        (3 - x0, 3 - y0), text, font=font, fill="white",
        stroke_width=3, stroke_fill=(0, 0, 0, 230),
    )
    return img


def test_presets_known():
    assert set(TEXT_FISHEYE_PRESETS) == {"fisheye", "curve", "bulge", "warp", "wave", "stretch"}


def test_stretch_keeps_exact_dims():
    src = make_gradient()
    out = _apply_fisheye(src, TEXT_FISHEYE_PRESETS["stretch"])
    assert out.width == round(W * 0.62), (out.width, round(W * 0.62))
    assert out.height == round(H * 1.45), (out.height, round(H * 1.45))


def test_fisheye_center_expanded_edges_compressed():
    # gradiente suave: o perfil de saída p(x) ≈ 220 * x_fonte/W, então dp/dx mede
    # a magnificação — pequeno no centro (expandido), grande nas pontas (comprimido).
    out = _apply_fisheye(make_gradient(), TEXT_FISHEYE_PRESETS["fisheye"])
    op = out.load()
    ow, oh = out.size
    profile = []
    for x in range(ow):
        ys = [y for y in range(oh) if op[x, y][3] > 100]
        if not ys:
            profile.append(0.0)
            continue
        r, g, b, _ = op[x, sum(ys) // len(ys)]
        profile.append((r + g + b) / 3)
    deriv = []
    for x in range(ow):
        a = profile[max(0, x - 3)]
        b = profile[min(ow - 1, x + 3)]
        deriv.append((b - a) / (min(ow - 1, x + 3) - max(0, x - 3)))
    center_slope = deriv[ow // 2]
    edge_slope = max(deriv[int(ow * 0.78):])
    assert edge_slope > center_slope * 1.5, (center_slope, edge_slope)
    # conteúdo preservado: o gradiente inteiro continua visível
    assert profile[0] < 20 and profile[ow - 1] > MAXV - 20, (profile[0], profile[ow - 1])


def test_curve_edges_go_down():
    out = _apply_fisheye(make_flat_text(), TEXT_FISHEYE_PRESETS["curve"])
    op = out.load()
    ow, oh = out.size

    def top(x):
        return next((y for y in range(oh) if op[x, y][3] > 0), None)

    meio, e1, e2 = top(ow // 2), top(ow // 4), top(3 * ow // 4)
    assert meio < min(e1, e2), (meio, e1, e2)


def test_all_presets_render_with_content():
    for pid, cfg in TEXT_FISHEYE_PRESETS.items():
        out = _apply_fisheye(make_flat_text(), cfg)
        assert out.getbbox() is not None, f"{pid} saiu vazio"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"OK {name}")
    print(">>> DISTORÇÃO FISHEYE OK")
