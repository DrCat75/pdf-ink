# Generates images/icon.png (128px): VS Code-like window, PDF page left, code right, stylus writing.
import math
from PIL import Image, ImageDraw, ImageFilter

S = 8; N = 128 * S
def P(*v): return [x * S for x in v]

im = Image.new('RGBA', (N, N), (0, 0, 0, 0))
d = ImageDraw.Draw(im)

# window
d.rounded_rectangle(P(0, 0, 127.9, 127.9), radius=24 * S, fill='#1e1e1e')
mask = Image.new('L', (N, N), 0); ImageDraw.Draw(mask).rounded_rectangle(P(0, 0, 127.9, 127.9), radius=24 * S, fill=255)
d.rectangle(P(0, 0, 128, 15), fill='#2d2d2d')                       # title bar
for i, c in enumerate(['#ff5f57', '#febc2e', '#28c840']):          # traffic lights
    x = 13 + i * 8; d.ellipse(P(x - 2.6, 7.5 - 2.6, x + 2.6, 7.5 + 2.6), fill=c)
d.rectangle(P(0, 116, 128, 128), fill='#007acc')                   # status bar
d.rectangle(P(0, 15, 63, 116), fill='#2a2a2c')                     # left pane bg
d.rectangle(P(63, 15, 64.2, 116), fill='#3c3c3c')                  # split

# PDF page
d.rounded_rectangle(P(8, 21, 57, 110), radius=2 * S, fill='white')
d.rectangle(P(13, 40, 44, 47), fill='#ffe14d')                     # highlight
d.rounded_rectangle(P(13, 27, 47, 31.5), radius=2 * S, fill='#3a3a3a')   # heading
for y, w in [(42, 30), (52, 38), (60, 34), (68, 25)]:
    d.rounded_rectangle(P(13, y, 13 + w, y + 2.6), radius=1.3 * S, fill='#a9b0bb')

# handwriting "pdf-ink": hand-defined single-line glyphs (y up, x-height 1),
# Catmull-Rom smoothed, slanted, drawn with tapered width. The pen tip sits at the end.
G = {
    'p': (0.85, [[(0.06, 1.0), (0.05, 0.3), (0.04, -0.8)],
                 [(0.05, 0.7), (0.3, 1.0), (0.62, 0.95), (0.78, 0.6), (0.7, 0.18), (0.42, 0.0), (0.18, 0.06), (0.05, 0.3)]]),
    'd': (0.95, [[(0.66, 0.78), (0.42, 1.0), (0.14, 0.88), (0.0, 0.5), (0.1, 0.1), (0.36, 0.0), (0.6, 0.18), (0.68, 0.5)],
                 [(0.72, 1.8), (0.7, 0.9), (0.68, 0.25), (0.75, 0.0), (0.9, 0.06)]]),
    'f': (0.7,  [[(0.72, 1.62), (0.52, 1.8), (0.32, 1.68), (0.26, 1.2), (0.25, 0.5), (0.24, 0.0)],
                 [(0.0, 1.0), (0.62, 1.02)]]),
    '-': (0.62, [[(0.08, 0.5), (0.5, 0.52)]]),
    'i': (0.42, [[(0.16, 1.0), (0.14, 0.4), (0.15, 0.06), (0.3, 0.0)],
                 [(0.17, 1.42), (0.2, 1.46)]]),
    'n': (0.88, [[(0.06, 1.0), (0.05, 0.0)],
                 [(0.06, 0.62), (0.26, 0.95), (0.5, 1.0), (0.66, 0.82), (0.67, 0.4), (0.68, 0.0)]]),
    'k': (0.75, [[(0.06, 1.8), (0.05, 0.9), (0.04, 0.0)],
                 [(0.62, 1.0), (0.3, 0.68), (0.07, 0.45)],
                 [(0.24, 0.6), (0.48, 0.28), (0.7, 0.0)]]),
}
def catmull(ps, n=24):
    if len(ps) < 3: return [(ps[0][0] + (ps[-1][0] - ps[0][0]) * t / n, ps[0][1] + (ps[-1][1] - ps[0][1]) * t / n) for t in range(n + 1)]
    q = [ps[0]] + ps + [ps[-1]]; out = []
    for i in range(1, len(q) - 2):
        p0, p1, p2, p3 = q[i - 1], q[i], q[i + 1], q[i + 2]
        for k in range(n):
            t = k / n; t2, t3 = t * t, t * t * t
            out.append(tuple(0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3) for j in (0, 1)))
    out.append(ps[-1]); return out

SC, X0, BASE, SLANT = 6.9, 13.0, 99.0, 0.22    # glyph unit → icon units, start x, baseline y
strokes, x = [], 0.0
for ch in 'pdf-ink':
    adv, ss = G[ch]
    for st in ss:
        strokes.append([(X0 + (x + gx + SLANT * gy) * SC, BASE - gy * SC) for gx, gy in catmull(st)])
    x += adv + 0.08
tip = strokes[-1][-1]
for st in strokes:
    n = len(st)
    for k, (px, py) in enumerate(st):
        t = k / max(1, n - 1)
        w = 0.42 + 0.33 * math.sin(math.pi * t) ** 0.6       # tapered ends, like pressure
        d.ellipse(P(px - w, py - w, px + w, py + w), fill='#1a4fd6')

# code pane: syntax-colored lines (VS Code Dark+ palette)
code = [
    [(0, 9, '#c586c0'), (11, 14, '#9cdcfe')],
    [(4, 9, '#569cd6'), (11, 23, '#dcdcaa')],
    [(4, 7, '#9cdcfe'), (9, 22, '#ce9178')],
    [(8, 13, '#569cd6'), (15, 24, '#4ec9b0')],
    [(8, 20, '#6a9955')],
    [(4, 8, '#c586c0'), (10, 19, '#9cdcfe')],
    [(0, 6, '#d4d4d4')],
    [(0, 10, '#569cd6'), (12, 21, '#dcdcaa')],
    [(4, 15, '#ce9178')],
]
for i, segs in enumerate(code):
    y = 23 + i * 9.6
    d.rectangle(P(67, y, 69.5, y + 3), fill='#5a5a5a')             # line-number gutter
    for x0, x1, c in segs:
        d.rounded_rectangle(P(73 + x0 * 1.85, y, 73 + x1 * 1.85, y + 3.4), radius=1.7 * S, fill=c)

im.putalpha(Image.composite(im.getchannel('A'), Image.new('L', (N, N), 0), mask))

# stylus, drawn on its own layer with a soft shadow
pen = Image.new('RGBA', (N, N), (0, 0, 0, 0)); pd = ImageDraw.Draw(pen)
ang = math.radians(-52)                     # direction from tip towards the back end (up-right)
ux, uy = math.cos(ang), math.sin(ang); nx, ny = -uy, ux
def at(s, w): return (tip[0] + ux * s + nx * w, tip[1] + uy * s + ny * w)
def quad(s0, w0, s1, w1, fill):
    pd.polygon([tuple(v * S for v in at(s0, -w0)), tuple(v * S for v in at(s1, -w1)),
                tuple(v * S for v in at(s1, w1)), tuple(v * S for v in at(s0, w0))], fill=fill)
quad(0, 0.3, 4, 1.6, '#202020')           # nib
quad(4, 1.6, 15, 5.2, '#d9dde3')          # cone
quad(15, 5.2, 19, 5.2, '#8a96a8')         # ferrule
quad(19, 5.2, 76, 5.2, '#0e7ad4')         # body
quad(19, 1.6, 76, 1.6, '#3aa0f0')         # highlight stripe
quad(76, 5.2, 82, 4.4, '#0a5ea6')         # end cap
ex, ey = at(82, 0); r = 4.4
pd.ellipse(P(ex - r, ey - r, ex + r, ey + r), fill='#0a5ea6')
shadow = Image.new('RGBA', (N, N), (0, 0, 0, 0))
shadow.putalpha(pen.getchannel('A').point(lambda a: int(a * 0.45)))
shadow = shadow.transform((N, N), Image.AFFINE, (1, 0, -2.5 * S, 0, 1, -3 * S)).filter(ImageFilter.GaussianBlur(3 * S))
shadow.putalpha(Image.composite(shadow.getchannel('A'), Image.new('L', (N, N), 0), mask))
pen.putalpha(Image.composite(pen.getchannel('A'), Image.new('L', (N, N), 0), mask))
im = Image.alpha_composite(Image.alpha_composite(im, shadow), pen)

im.resize((128, 128), Image.LANCZOS).save('images/icon.png')
im.resize((512, 512), Image.LANCZOS).save('design/icon_512.png')
