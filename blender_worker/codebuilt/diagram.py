"""Legible on-screen diagrams (V1, claude-pro lane, 2026-11-15).

WHY THIS EXISTS. In the persisted M4 Everest run (job mwhu3xfu-a118b6) the same visual finding came back in rounds 2, 3 and 4:
"the triangle is small and thin and does not read as a diagram" (shot 3), then "the bent ray, correction arrow and layers of air
are not readable" (shot 4). The fixes asked for each round ("thicker lines", "move the camera closer") were different numbers
for the same wrong diagnosis. The diagram was drawn IN the landscape at world scale: a 48 m baseline of 1.4 m bars, a ray of 0.5 m
bars and layer lines of 0.22 m, seen from 40 to 85 m at 4 to 10 degrees of elevation. At 85 m with a 35 mm lens the frame is 87 m
tall and 49 m wide, so a 0.22 m line is 0.45 percent of the frame width (under 5 px of 1080), and a ground-level line seen at 4 degrees is edge-on.
The Eratosthenes cards (job mwhqjwfx-4fbbb9) had the same cause: 0.5 m text on 5.8 m cards, about 1.3 percent of the frame height,
reported unreadable in rounds 3, 4 and 7. Nothing in the kit sized a diagram in FRAME terms, so the numbers were chosen in metres
and only the (expensive) look review could notice.

WHAT IT DOES. A Board is a flat panel facing -Y, placed in a place's collection. A diagram is drawn on it in board coordinates
(u and v from -1 to 1). Stroke width, arrow head, dot and text size are DERIVED from where the camera will stand, so the least
legible element is a known share of the frame: strokes at least MIN_STROKE of the frame width, capital letters at least MIN_CAP
of the frame height, arrow heads 3.2 strokes wide. The pure functions (visible_size, share, plan, ...) need no Blender, so the
numbers can be checked on any CPU before anything renders. Board.require() raises DiagramError with the reasons when a label does not
fit or the palette has too little contrast; it is a build-time check and never touches shotcheck.

Board.camera(cam, ...) aims the scene camera (it calls cam.set, so shot variety still sees the pose) at the board from the
distance that fills the planned share of the frame, with the board in the upper middle, clear of the caption band.
"""
import math

from . import shotcheck

SENSOR_MM = shotcheck.SENSOR_MM       # sensor length on the long (vertical) side
ASPECT = 9 / 16                       # frame width / height
FRAME_PX = (1080, 1920)               # final render
MIN_STROKE = 0.014                    # least stroke width, share of the frame WIDTH (about 15 px of 1080)
MIN_CAP = 0.026                       # least capital-letter height, share of the frame HEIGHT (about 50 px of 1920)
HEAD_W = 3.2                          # arrow head width in strokes
MAX_LABELS = 6                        # more than this is a wall of text on a phone
MAX_FILL = 0.84                       # a board never spans more than this share of the frame width
DEFAULT_FILL = 0.70                   # and starts at the readout/plate limit of the visual check
BOARD_TOP, BOARD_BOTTOM = 0.10, 0.62  # the board lives between these shares of the height from the top (captions sit lower)
INNER = 0.90                          # drawing area share of the board; keeps ink off the edge of the panel
MIN_CONTRAST = 4.5                    # label ink against the panel (relative luminance ratio)
MIN_ACCENT = 3.0                      # a coloured stroke against the panel
CAP_RATIO = 0.70                      # capital height / font size; Board measures the real font when Blender is present
PALETTE = {
    'panel': (0.96, 0.94, 0.88), 'ink': (0.07, 0.09, 0.15),
    'blue': (0.08, 0.30, 0.78), 'orange': (0.78, 0.30, 0.02), 'red': (0.78, 0.08, 0.08), 'green': (0.04, 0.45, 0.22),
}


class DiagramError(ValueError):
    """The diagram cannot be legible as designed; the message lists every reason."""


# ---- pure arithmetic (no Blender) ------------------------------------------------------------------------------------------------

def visible_height(dist, lens):
    """Metres of frame height at dist metres with a lens of `lens` mm (the sensor length is on the vertical side)."""
    return dist * SENSOR_MM / lens


def visible_width(dist, lens):
    return visible_height(dist, lens) * ASPECT


def share(size, dist, lens, axis='h'):
    """Share of the frame height ('h') or width ('w') a flat object of `size` metres facing the camera covers."""
    return size / (visible_height(dist, lens) if axis == 'h' else visible_width(dist, lens))


def distance_for_share(size, frac, lens, axis='h'):
    return size * lens / (SENSOR_MM * (1.0 if axis == 'h' else ASPECT) * frac)


def px(frac, axis='h', frame=FRAME_PX):
    return frac * (frame[1] if axis == 'h' else frame[0])


def luminance(rgb):
    def lin(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (lin(min(1.0, max(0.0, c))) for c in rgb[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def edge_scale(half_width, az, dist):
    """Least on-screen width of a unit-wide stroke across the drawing area, relative to the same stroke facing the camera at the board centre.

    The camera aims at the board centre from az degrees off the board's normal at dist metres. A point x metres from the centre is
    projected by a pinhole to u = f * x*cos(az) / (dist - x*sin(az)), so a stroke there is du/dx = f*cos(az)*dist / (dist - x*sin(az))^2 wide:
    foreshortened by cos(az) at the centre, and further thinned at the far edge, which is both farther away and seen more obliquely.
    Returns the value at the far edge (the centre value cos(az) when the view is straight on).
    """
    a = math.radians(abs(az))
    return math.cos(a) / (1.0 + half_width * math.sin(a) / dist) ** 2


def plan(width, height, lens=35.0, fill=DEFAULT_FILL, az=0.0, el=0.0):
    """Where the camera stands and how big strokes and text must be so a board of width x height metres is legible.

    az and el are the camera's angle off the board's normal, in degrees (the board is foreshortened by their cosines).
    fill is the wanted share of the frame width; it is lowered when the board would run into the caption band.
    Returns distance, the real fill, visible sizes, and the stroke, capital height, font size and head width in metres.
    """
    ca, ce = math.cos(math.radians(abs(az))), math.cos(math.radians(abs(el)))
    if ca < 0.5 or ce < 0.5:
        raise DiagramError('the camera is more than 60 degrees off the board: text would be foreshortened by half or more')
    w_eff, h_eff = width * ca, height * ce
    fill = min(max(fill, 0.2), MAX_FILL * ca)   # at the straight-on view the board spans fill / ca, which must stay under MAX_FILL
    dist = distance_for_share(w_eff, fill, lens, 'w')
    dist = max(dist, distance_for_share(h_eff, BOARD_BOTTOM - BOARD_TOP, lens, 'h'))
    vh, vw = visible_height(dist, lens), visible_width(dist, lens)
    stroke = MIN_STROKE * vw / edge_scale(width / 2 * INNER, az, dist)   # across the line's width, at the thinnest place on the board
    cap = MIN_CAP * vh / ce
    return {
        'distance': dist, 'lens': lens, 'fill': w_eff / vw, 'height_share': h_eff / vh,
        'visible_w': vw, 'visible_h': vh, 'stroke': stroke, 'cap': cap, 'font': cap / CAP_RATIO, 'head': HEAD_W * stroke,
        'stroke_px': px(MIN_STROKE, 'w'), 'cap_px': px(MIN_CAP, 'h'),
    }


def max_chars(font, avail_width):
    """Longest line of text that fits avail_width metres (the same glyph width estimate shotcheck uses, which is wide on purpose)."""
    return int(avail_width // (font * shotcheck.CHAR_W))


def frame_extent(points, pos, target, lens=35.0):
    """Where world points land in the frame: (xmin, xmax, ymin, ymax) shares (y up), the points outside the text safe area, the
    nearest depth. Uses the same projection as shotcheck, so it agrees with Blender's world_to_camera_view."""
    pr = [shotcheck.project_point(tuple(p), tuple(pos), tuple(target), lens) for p in points]
    xs, ys = [q[0] for q in pr], [q[1] for q in pr]
    x0, x1, y0, y1 = shotcheck.TEXT_SAFE
    outside = [i for i, q in enumerate(pr) if q[2] <= 0.05 or not (x0 <= q[0] <= x1 and y0 <= q[1] <= y1)]
    return {'box': (min(xs), max(xs), min(ys), max(ys)), 'outside': outside, 'depth': min(q[2] for q in pr)}


def diagnose(points, pos, target, lens=35.0, stroke=None, cap=None):
    """Reasons a diagram drawn directly in the world (not on a Board) is not legible from this camera pose. `points` are the world
    positions of its corners and ends; `stroke` and `cap` are the line width and capital height in metres. [] means legible.
    This is the check that was missing in job mwhu3xfu-a118b6: its triangle corners projected at x = -0.02 and 1.08 (outside the
    frame) and the loop kept asking for a closer camera."""
    why = []
    ext = frame_extent(points, pos, target, lens)
    x0, x1, y0, y1 = ext['box']
    if ext['outside']:
        why.append('%d of %d diagram points lie outside the text safe area or behind the camera (box x %.2f..%.2f, y %.2f..%.2f): pull back or shrink it'
                   % (len(ext['outside']), len(points), x0, x1, y0, y1))
    elif x1 - x0 < 0.45 and y1 - y0 < 0.30:
        why.append('the diagram fills only %.0f%% of the frame width and %.0f%% of its height: move closer or enlarge it' % ((x1 - x0) * 100, (y1 - y0) * 100))
    d = max(ext['depth'], 1e-6)
    if stroke is not None and stroke / visible_width(d, lens) < MIN_STROKE * 0.98:
        why.append('strokes of %.2f m are %.0f px of 1080 at %.0f m (need %.0f): thicken them' % (stroke, px(stroke / visible_width(d, lens), 'w'), d, px(MIN_STROKE, 'w')))
    if cap is not None and cap / visible_height(d, lens) < MIN_CAP * 0.98:
        why.append('capital letters of %.2f m are %.0f px of 1920 at %.0f m (need %.0f): enlarge the text' % (cap, px(cap / visible_height(d, lens), 'h'), d, px(MIN_CAP, 'h')))
    return why


def legibility(stroke, cap, dist, lens, az=0.0, el=0.0):
    """Frame shares of a stroke (of the width) and a capital letter (of the height) as the camera will see them."""
    ca, ce = math.cos(math.radians(abs(az))), math.cos(math.radians(abs(el)))
    s = share(stroke * ca, dist, lens, 'w')
    k = share(cap * ce, dist, lens, 'h')
    return {'stroke_share': s, 'stroke_px': px(s, 'w'), 'cap_share': k, 'cap_px': px(k, 'h'),
            'stroke_ok': s >= MIN_STROKE * 0.98, 'cap_ok': k >= MIN_CAP * 0.98}


def pose_segment(a, b, k, head_len=0.0):
    """Pose of a stroke from a to b (points in the XZ plane of a board, y kept from a) drawn k of the way, with an optional arrow head
    of head_len metres at the tip. None when nothing shows. Returns loc and len of the shaft, ang (radians, in the XZ plane), the head
    location and whether the head is shown."""
    k = max(0.0, min(1.0, k))
    dx, dz = b[0] - a[0], b[2] - a[2]
    length = math.hypot(dx, dz)
    if k <= 0.001 or length < 1e-6:
        return None
    ang = math.atan2(dz, dx)
    tip = length * k
    body = max(tip - head_len, 0.0)
    c, s = math.cos(ang), math.sin(ang)
    return {'ang': ang, 'len': body, 'loc': (a[0] + c * body / 2, a[1], a[2] + s * body / 2),
            'head': (a[0] + c * (tip - head_len), a[1], a[2] + s * (tip - head_len)), 'head_shown': head_len > 0 and tip >= head_len}


# ---- the board (Blender) -------------------------------------------------------------------------------------------------------

_MAT = {}
_CAP = [None]


def _mat(name, rgb, strength=1.0):
    from . import materials
    key = (name, tuple(rgb), strength)
    if key not in _MAT:
        _MAT[key] = materials.emit('dg_' + name, rgb, strength)
    return _MAT[key]


def reset_cache():
    """Call after stage.reset_scene() if a script resets the scene a second time."""
    _MAT.clear()
    _CAP[0] = None


def _cap_ratio():
    """Capital height over font size of the font that will really render (Impact on the host, Blender's own in the container)."""
    if _CAP[0] is None:
        import bpy
        from . import stage
        cu = bpy.data.curves.new('dg_cap', 'FONT')
        cu.body, cu.font, cu.size = 'HEH', stage.load_font(), 1.0
        ob = bpy.data.objects.new('dg_cap', cu)
        bpy.context.scene.collection.objects.link(ob)
        bpy.context.view_layer.update()
        ratio = ob.dimensions.y if ob.dimensions.y > 0.05 else CAP_RATIO
        bpy.data.objects.remove(ob)
        bpy.data.curves.remove(cu)
        _CAP[0] = ratio
    return _CAP[0]


class Board:
    """A flat diagram board in place collection `c`, centred at `center`, width x height metres, facing -Y.

    b = diagram.Board(c, 'wave', center=(0, 0, 6), width=10, height=8, lens=35)
    ln = b.line((-1, -0.6), (0.8, -0.6), 'ink'); ar = b.arrow((-0.8, -0.6), (0.6, 0.5), 'orange'); t = b.label('170 KM', (0, -0.8))
    b.require()                       # once, after drawing: raises DiagramError when something cannot be legible
    in a shot function:  b.camera(cam, u)  then  b.draw(ln, k)  (k from 0 hidden, to 1 fully drawn)  or  b.draw(t, 1)
    Elements are created hidden (scale 0); draw() shows and poses them as a pure function of the k you pass.
    """

    def __init__(self, c, name, center, width, height, lens=35.0, fill=DEFAULT_FILL, az_max=0.0, el_max=0.0, palette=None):
        from . import meshes
        self.c, self.name, self.center = c, name, tuple(center)
        self.width, self.height = float(width), float(height)
        self.pal = dict(PALETTE, **(palette or {}))
        self.fill = fill
        self.az_max, self.el_max = abs(az_max), abs(el_max)
        self.plan = plan(self.width, self.height, lens, fill, self.az_max, self.el_max)   # sized for the most slanted view the shots use
        self.items, self.labels = [], []
        self.problems = []
        self._meshes = meshes
        self.panel = meshes.box(name + '_panel', c, _mat('panel', self.pal['panel'], 1.0), self.center,
                                (self.width / 2, 0.04, self.height / 2), bevel=0)
        self.panel['codebuilt_board'] = True
        self.hw, self.hh = self.width / 2 * INNER, self.height / 2 * INNER

    # board coordinates u, v in -1..1 -> world, in front of the panel
    def at(self, p, depth=0.0):
        return (self.center[0] + p[0] * self.hw, self.center[1] - 0.05 - depth, self.center[2] + p[1] * self.hh)

    def _color(self, color):
        rgb = self.pal.get(color, color) if isinstance(color, str) else color
        if len(rgb) != 3:
            raise DiagramError('a colour is a palette name or an (r, g, b) tuple')
        if contrast(rgb, self.pal['panel']) < MIN_ACCENT:
            self.problems.append('colour %s has contrast %.1f against the panel, under %.1f' % (color, contrast(rgb, self.pal['panel']), MIN_ACCENT))
        return rgb

    def line(self, a, b, color='ink', width=1.0):
        """A stroke from a to b (board coordinates). width scales the minimum stroke (1.0 to 2.0)."""
        t = self.plan['stroke'] * min(2.0, max(1.0, width))
        o = self._meshes.box(self.name + '_ln', self.c, _mat('c%s' % (color,), self._color(color), 1.0), (0, 0, 0), (0.5, t / 2, t / 2), bevel=0)
        o.scale = (0, 0, 0)
        o['dg'] = [float(a[0]), float(a[1]), float(b[0]), float(b[1]), 0.0]
        self.items.append(o)
        return o

    def arrow(self, a, b, color='ink', width=1.0):
        """A stroke from a to b with an arrow head at b. Returns a dict that draw() poses."""
        t = self.plan['stroke'] * min(2.0, max(1.0, width))
        m = _mat('c%s' % (color,), self._color(color), 1.0)
        shaft = self._meshes.box(self.name + '_sh', self.c, m, (0, 0, 0), (0.5, t / 2, t / 2), bevel=0)
        hl = HEAD_W * t * 0.9
        head = self._meshes.lathe(self.name + '_hd', [(0.001, 0), (HEAD_W * t / 2, 0), (0.001, hl)], m, self.c, n=12, subsurf=0)
        head.rotation_mode = 'XYZ'
        shaft.scale = head.scale = (0, 0, 0)
        arrow = {'shaft': shaft, 'head': head, 'a': tuple(a), 'b': tuple(b), 'head_len': hl}
        self.items.append(arrow)
        return arrow

    def dot(self, p, color='ink', r=1.6):
        """A round marker of r strokes (a point, a station, a hinge)."""
        rad = self.plan['stroke'] * r
        o = self._meshes.ball(self.name + '_dot', rad, _mat('c%s' % (color,), self._color(color), 1.0), self.c, nu=16, nv=8)
        o.scale = (0, 0, 0)
        o['dg'] = [float(p[0]), float(p[1]), float(p[0]), float(p[1]), 1.0]
        self.items.append(o)
        return o

    def label(self, body, p, color='ink'):
        """Text of the minimum legible size (never smaller), centred at p. Keep it to a few short words: see max_chars."""
        from . import stage
        font = self.plan['cap'] / _cap_ratio()
        o = stage.text(self.c, self.name + '_tx', body, font, _mat('c%s' % (color,), self._color(color), 1.0), self.at(p, 0.02))
        o.scale = (0, 0, 0)
        o['dg'] = [float(p[0]), float(p[1]), float(p[0]), float(p[1]), 2.0]
        o['dg_body'] = body
        o['dg_font'] = font
        self.labels.append(o)
        return o

    def check(self):
        """Reasons the diagram cannot be legible: labels too long for the board, too many labels, palette contrast."""
        why = list(self.problems)
        if contrast(self.pal['ink'], self.pal['panel']) < MIN_CONTRAST:
            why.append('ink against panel has contrast %.1f, under %.1f' % (contrast(self.pal['ink'], self.pal['panel']), MIN_CONTRAST))
        if len(self.labels) > MAX_LABELS:
            why.append('%d labels; more than %d is a wall of text on a phone: cut words or split the diagram over two shots' % (len(self.labels), MAX_LABELS))
        for o in self.labels:
            body, font = o['dg_body'], o['dg_font']
            w, h = shotcheck.text_extent(body, font)
            u, v = o['dg'][0], o['dg'][1]
            if abs(u) * self.hw + w / 2 > self.width / 2 or abs(v) * self.hh + h / 2 > self.height / 2:
                why.append('label %r (%.1f x %.1f m) leaves the board at (%.2f, %.2f); shorten it, split it in lines, or move it inward (about %d characters fit a line)'
                           % (body, w, h, u, v, max_chars(font, self.width * INNER)))
        return why

    def require(self):
        why = self.check()
        if why:
            raise DiagramError('diagram %s: %s' % (self.name, '; '.join(why)))
        return self

    def draw(self, item, k=1.0):
        """Show and pose one element as a function of k: 0 hides it, 0..1 grows a line or arrow from its start, a label or dot pops in."""
        if type(item) is dict:      # an arrow (plain dict); Blender objects and their stand-ins are not
            ax, ay = self.at(item['a']), self.at(item['b'])
            self._pose_line(item['shaft'], ax, ay, k, item['head_len'], item['head'])
            return
        u0, v0, u1, v1, kind = (float(x) for x in item['dg'])    # list(): Blender's ID property arrays are not guaranteed to slice
        if kind == 0.0:
            self._pose_line(item, self.at((u0, v0)), self.at((u1, v1)), k)
        else:
            s = max(0.0, min(1.0, k))
            item.location = self.at((u0, v0), 0.02 if kind == 2.0 else 0.0)
            item.scale = (s, s, s)

    def _pose_line(self, o, a, b, k, head_len=0.0, head=None):
        pose = pose_segment(a, b, k, head_len if head is not None else 0.0)
        if pose is None:
            o.scale = (0, 0, 0)
            if head is not None:
                head.scale = (0, 0, 0)
            return
        o.location, o.rotation_euler, o.scale = pose['loc'], (0, -pose['ang'], 0), (pose['len'], 1, 1) if pose['len'] > 0 else (0, 0, 0)
        if head is not None:
            head.location, head.rotation_euler = pose['head'], (0, math.pi / 2 - pose['ang'], 0)
            head.scale = (1, 1, 1) if pose['head_shown'] else (0, 0, 0)

    def camera(self, cam, u=0.0, push=0.05, az=0.0, el=0.0, lens=None):
        """Aim the scene camera at the board with cam.set (never cam.obj directly) and return (pos, target, lens).

        u (0..1) pushes in by `push` (a fraction of the distance), so the shot is not static. az and el are degrees off the board's
        normal (side and height); they are limited to the az_max and el_max the board was sized for, because a slanted view thins
        strokes and text by the cosine. The distance keeps the board's width share, so legibility does not depend on the lens.
        """
        a = max(-self.az_max, min(self.az_max, az))
        e = max(-self.el_max, min(self.el_max, el))
        ln = self.plan['lens'] if lens is None else float(lens)
        d0 = plan(self.width, self.height, ln, self.fill, self.az_max, self.el_max)['distance']
        d = d0 * max(1.0 - push * max(0.0, min(1.0, u)), self.plan['fill'] / MAX_FILL)
        ra, re = math.radians(a), math.radians(e)
        pos = (self.center[0] + d * math.sin(ra) * math.cos(re), self.center[1] - d * math.cos(ra) * math.cos(re), self.center[2] + d * math.sin(re))
        vh = visible_height(d, ln)
        target = (self.center[0], self.center[1], self.center[2] - vh * (0.5 - (BOARD_TOP + BOARD_BOTTOM) / 2))
        cam.set(pos, target, lens=ln)
        return pos, target, ln

    def report(self):
        """Numbers for a probe or a log: planned sizes and what each stroke and capital is in pixels at 1080 x 1920 and at the 540 x 960 preview."""
        p = self.plan
        leg = legibility(p['stroke'], p['cap'], p['distance'], p['lens'], self.az_max, self.el_max)
        return {'board': [self.width, self.height], 'center': list(self.center), 'plan': p, 'legibility': leg,
                'preview_px': {'stroke': leg['stroke_px'] / 2, 'cap': leg['cap_px'] / 2},
                'labels': [{'body': o['dg_body'], 'font': o['dg_font']} for o in self.labels], 'problems': self.check()}
