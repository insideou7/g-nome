"""G-Nome 3D formats: models (MODL/MPRT), animations (FRME) and object
definitions (OB3D/OPRT), plus OBJ and glTF export.

The formats are documented in docs/formats/g-nome-bin.md (models) and
docs/formats/animation.md (FRME, OB3D/OPRT and the animation system).
Used by tools/gnome_extract.py; only the standard library is needed.
"""
import base64
import json
import math
import struct
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Matrices: 16 floats, row-major, for row vectors (v' = v * M), translation in
# the last row. This is RenderWare's layout. Read column-major, the same 16
# floats are the column-vector matrix glTF expects.
# ---------------------------------------------------------------------------

IDENTITY = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]


def matmul(a: list, b: list) -> list:
    """a then b, for row vectors: v * a * b."""
    return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4))
            for r in range(4) for c in range(4)]


def transform_point(m: list, x: float, y: float, z: float) -> tuple:
    return (x * m[0] + y * m[4] + z * m[8] + m[12],
            x * m[1] + y * m[5] + z * m[9] + m[13],
            x * m[2] + y * m[6] + z * m[10] + m[14])


def from_3x4(rows: tuple) -> list:
    """12 floats (3 rotation rows then the translation row) -> 16 floats."""
    return [*rows[0:3], 0.0, *rows[3:6], 0.0, *rows[6:9], 0.0, *rows[9:12], 1.0]


def decompose(m: list) -> tuple:
    """Split a row-vector matrix into glTF translation, rotation (x, y, z, w
    quaternion for column vectors) and scale."""
    t = (m[12], m[13], m[14])
    rows = [m[0:3], m[4:7], m[8:11]]
    s = [math.sqrt(sum(c * c for c in r)) or 1.0 for r in rows]
    a = [[rows[i][j] / s[i] for j in range(3)] for i in range(3)]
    det = (a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
           - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
           + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]))
    if det < 0:  # a mirror: fold it into the scale
        s[0] = -s[0]
        a[0] = [-c for c in a[0]]
    # Column-vector rotation R = a transposed, so R[i][j] = a[j][i].
    r = [[a[j][i] for j in range(3)] for i in range(3)]
    tr = r[0][0] + r[1][1] + r[2][2]
    if tr > 0:
        k = math.sqrt(tr + 1.0) * 2
        q = ((r[2][1] - r[1][2]) / k, (r[0][2] - r[2][0]) / k,
             (r[1][0] - r[0][1]) / k, 0.25 * k)
    elif r[0][0] > r[1][1] and r[0][0] > r[2][2]:
        k = math.sqrt(1.0 + r[0][0] - r[1][1] - r[2][2]) * 2
        q = (0.25 * k, (r[0][1] + r[1][0]) / k, (r[0][2] + r[2][0]) / k,
             (r[2][1] - r[1][2]) / k)
    elif r[1][1] > r[2][2]:
        k = math.sqrt(1.0 + r[1][1] - r[0][0] - r[2][2]) * 2
        q = ((r[0][1] + r[1][0]) / k, 0.25 * k, (r[1][2] + r[2][1]) / k,
             (r[0][2] - r[2][0]) / k)
    else:
        k = math.sqrt(1.0 + r[2][2] - r[0][0] - r[1][1]) * 2
        q = ((r[0][2] + r[2][0]) / k, (r[1][2] + r[2][1]) / k, 0.25 * k,
             (r[1][0] - r[0][1]) / k)
    n = math.sqrt(sum(c * c for c in q)) or 1.0
    return t, tuple(c / n for c in q), tuple(s)


# ---------------------------------------------------------------------------
# Models (types 7 MODL and 8 MPRT)
# ---------------------------------------------------------------------------

# After the 4 byte tag and a u32 part count, a model is a stream of u32
# opcodes, each followed by fixed arguments. It mirrors RenderWare's RWX
# script commands. Argument kinds: f float, i int, P count-prefixed int list,
# s texture path (only present when the preceding int is not 0;
# NUL-terminated, padded to 4).
MODEL_OPS = {
    0x1A: ("modelbegin", ""), 0x1B: ("modelend", ""),
    0x06: ("clumpbegin", ""), 0x07: ("clumpend", ""),
    0x35: ("transformbegin", ""), 0x36: ("transformend", ""),
    0x34: ("transform", "f" * 16),
    0x3B: ("vertex", "fff"), 0x3C: ("vertexext", "fff"),
    0x12: ("uv", "ff"), 0x14: ("vertexend", ""),
    0x39: ("triangle", "iii"), 0x23: ("quad", "iiii"), 0x1D: ("polygon", "P"),
    # Op n is entry n - 1 of RENDER.R32's RWX table (FUN_100025e5): 0x08 is
    # RwSetSurfaceColor, 0x2C RwSetSurface (ambient, diffuse, specular).
    0x08: ("color", "fff"), 0x2C: ("surface", "fff"), 0x1C: ("opacity", "f"),
    0x2E: ("texture", "is"),
    # 0x2D is RWX "Tag": the clump's part number. FRME animations and
    # RENDER.R32's clump externs find clumps by it.
    0x2D: ("tag", "i"),
    # Int settings: RwSetAxisAlignment, RwSetSurfaceGeometrySampling,
    # RwSetHints, RwSetSurfaceLightSampling, RwSetSurfaceMaterialModes and
    # RwSetSurfaceTextureModes.
    0x04: ("op04", "i"), 0x0D: ("op0d", "i"), 0x0F: ("op0f", "i"),
    0x16: ("op16", "i"), 0x19: ("op19", "i"), 0x32: ("op32", "i"),
}


def model_ops(data: bytes) -> list:
    """Split a MODL/MPRT resource into (name, args) tuples."""
    p, ops = 8, []
    while p < len(data):
        (op,) = struct.unpack_from("<I", data, p)
        p += 4
        if op not in MODEL_OPS:
            raise ValueError(f"unknown model opcode {op:#x} at {p - 4:#x}")
        name, kinds = MODEL_OPS[op]
        args = []
        for k in kinds:
            if k == "f":
                args.append(struct.unpack_from("<f", data, p)[0])
                p += 4
            elif k == "i":
                args.append(struct.unpack_from("<i", data, p)[0])
                p += 4
            elif k == "P":
                (n,) = struct.unpack_from("<I", data, p)
                args.append(list(struct.unpack_from(f"<{n}I", data, p + 4)))
                p += 4 + 4 * n
            elif k == "s" and args[-1]:
                z = data.index(b"\0", p)
                args.append(data[p:z].decode("latin-1"))
                p = (z + 4) & ~3
        ops.append((name, args))
    if p != len(data):
        raise ValueError("model stream overruns the resource")
    return ops


def bmp_name(path: str) -> str:
    return path.replace("\\", "/").rsplit("/", 1)[-1]


@dataclass
class Clump:
    parent: int          # index of the parent clump, -1 for a root
    tag: int             # part number (1-based), 0 if untagged
    matrix: list         # joint transform relative to the parent (bind pose)
    verts: list = field(default_factory=list)   # (x, y, z, (u, v) or None)
    faces: list = field(default_factory=list)   # ([0-based vertex indices], material)


@dataclass(frozen=True)
class Material:
    color: tuple
    opacity: float
    texture: str         # .BMP file name, "" for none


@dataclass
class Model:
    parts: int           # the u32 after the tag: number of tagged clumps
    clumps: list

    def by_tag(self) -> dict:
        return {c.tag: i for i, c in enumerate(self.clumps) if c.tag}


def parse_model(data: bytes) -> Model:
    """Build the clump tree of a MODL/MPRT resource.

    A transform sets the current transformation matrix (CTM). When a clump
    begins, the CTM becomes that clump's joint transform, relative to its
    parent clump, and the CTM resets to identity inside it. The CTM is pushed
    and popped by transformbegin / transformend and restored at clumpend.
    Each clump has its own 1-based vertex list.
    """
    (parts,) = struct.unpack_from("<I", data, 4)
    clumps, stack = [], []
    ctm, ctm_stack = IDENTITY, []
    cur = -1
    color, opacity, texture = (0.8, 0.8, 0.8), 1.0, ""
    pending = None

    def flush():
        nonlocal pending
        if pending is not None:
            x, y, z, uv = pending
            if ctm is not IDENTITY:  # never happens in G-Nome's models
                x, y, z = transform_point(ctm, x, y, z)
            clumps[cur].verts.append((x, y, z, uv))
            pending = None

    for op, args in model_ops(data):
        if op in ("vertex", "vertexext"):
            flush()
            pending = [*args, None]
        elif op == "uv" and pending is not None:
            pending[3] = tuple(args)
        elif op == "vertexend":
            flush()
        elif op in ("triangle", "quad", "polygon"):
            flush()
            idx = args[0] if op == "polygon" else args
            n = len(clumps[cur].verts)
            if not all(1 <= i <= n for i in idx):
                raise ValueError(f"face uses a vertex outside 1..{n}")
            clumps[cur].faces.append(([i - 1 for i in idx],
                                      Material(color, opacity, texture)))
        elif op == "clumpbegin":
            flush()
            clumps.append(Clump(cur, 0, list(ctm)))
            stack.append((cur, ctm))
            cur, ctm = len(clumps) - 1, IDENTITY
        elif op == "clumpend":
            flush()
            cur, ctm = stack.pop()
        elif op == "tag":
            clumps[cur].tag = args[0]
        elif op == "transformbegin":
            ctm_stack.append(ctm)
        elif op == "transformend":
            ctm = ctm_stack.pop()
        elif op == "transform":
            ctm = list(args)
        elif op == "color":
            color = tuple(round(c, 4) for c in args)
        elif op == "opacity":
            opacity = round(args[0], 4)
        elif op == "texture":
            texture = bmp_name(args[1]) if args[0] else ""
    flush()
    return Model(parts, clumps)


def world_matrices(model: Model, pose: dict = None) -> list:
    """World matrix of every clump. pose maps a tag to a joint matrix that
    replaces the bind pose, the way RENDER.R32 applies an FRME frame."""
    out = []
    for c in model.clumps:
        local = pose.get(c.tag, c.matrix) if pose and c.tag else c.matrix
        out.append(matmul(local, out[c.parent]) if c.parent >= 0 else local)
    return out


def model_to_obj(model: Model, name: str, texture_pngs: dict,
                 pose: dict = None) -> tuple:
    """Wavefront OBJ and MTL text for a model, in its bind pose or in pose.

    texture_pngs maps an upper-case .BMP file name to a PNG path for the
    material file. OBJ texture v runs bottom-up, so v is written as 1 - v.
    """
    obj = [f"# {name}, converted by tools/gnome_extract.py", f"mtllib {name}.mtl"]
    mtl = [f"# materials for {name}"]
    materials, current = {}, None
    nv = nvt = 0
    for ci, (c, m) in enumerate(zip(model.clumps, world_matrices(model, pose))):
        obj.append(f"o clump{ci + 1}")
        refs = []
        for x, y, z, uv in c.verts:
            obj.append("v %.6f %.6f %.6f" % transform_point(m, x, y, z))
            nv += 1
            if uv is not None:
                obj.append(f"vt {uv[0]:.6f} {1 - uv[1]:.6f}")
                nvt += 1
                refs.append(f"{nv}/{nvt}")
            else:
                refs.append(str(nv))
        for idx, mat in c.faces:
            if mat not in materials:
                mname = materials[mat] = f"mat{len(materials)}"
                mtl.extend([f"newmtl {mname}", "Kd %.4f %.4f %.4f" % mat.color,
                            f"d {mat.opacity:.4f}"])
                if mat.texture:
                    png = texture_pngs.get(mat.texture.upper())
                    mtl.append(f"map_Kd {png}" if png
                               else f"# texture {mat.texture} not found")
            if materials[mat] != current:
                current = materials[mat]
                obj.append(f"usemtl {current}")
            obj.append("f " + " ".join(refs[i] for i in idx))
    return "\n".join(obj) + "\n", "\n".join(mtl) + "\n"


# ---------------------------------------------------------------------------
# FRME animations (type 4)
# ---------------------------------------------------------------------------

FRME_HDR = struct.Struct("<4sIII")  # "FRME", parts, frames, 0


@dataclass
class Frme:
    parts: int
    frames: list   # frames[f][k] = 16-float joint matrix of the clump tagged k + 1

    def pose(self, f: int) -> dict:
        return {k + 1: m for k, m in enumerate(self.frames[f])}


def parse_frme(data: bytes) -> Frme:
    """An FRME is a 16 byte header, then frames x parts joint matrices of 12
    floats (3 rotation rows, then the translation row). One resource (4733)
    lists one frame more than it holds, so the count is clamped to the data."""
    tag, parts, frames, _zero = FRME_HDR.unpack_from(data, 0)
    if tag != b"FRME":
        raise ValueError("not an FRME resource")
    if parts == 0:
        return Frme(0, [])
    frames = min(frames, (len(data) - FRME_HDR.size) // (48 * parts))
    out = []
    for f in range(frames):
        base = FRME_HDR.size + f * parts * 48
        out.append([from_3x4(struct.unpack_from("<12f", data, base + k * 48))
                    for k in range(parts)])
    return Frme(parts, out)


# ---------------------------------------------------------------------------
# Object definitions (types 9 OB3D and 10 OPRT)
# ---------------------------------------------------------------------------

@dataclass
class ObjectDef:
    slots: int       # number of 16 byte slots RENDER.R32 allocates
    entries: list    # (kind, values) records before the property list
    props: list      # property words; GetProperty(obj, n) reads props[n]
    prop_slot: int   # slot where the properties start
    prop_words: int  # words of property space (4 per remaining slot)


def parse_object(data: bytes) -> ObjectDef:
    """Parse an OB3D / OPRT resource the way RENDER.R32's loader (0x100043f0)
    does. Record kinds: 1 {a, b}; 2 {min, max distance floats, resource type
    (7 model or 19 script), resource id} = a level-of-detail band; 6 {a,
    script}; 8 {a}; 7 {words, n, n property words} which ends the list."""
    tag, slots = struct.unpack_from("<4sI", data, 0)
    if tag not in (b"OB3D", b"OPRT"):
        raise ValueError("not an OB3D/OPRT resource")
    p, entries = 8, []
    props, prop_slot, prop_words = [], slots, 0
    while p < len(data):
        (kind,) = struct.unpack_from("<I", data, p)
        if kind in (1, 6):
            entries.append((kind, struct.unpack_from("<ii", data, p + 4)))
            p += 12
        elif kind == 2:
            lo, hi, rtype, rid = struct.unpack_from("<ffii", data, p + 4)
            entries.append((kind, (lo, hi, rtype, rid)))
            p += 20
        elif kind == 8:
            entries.append((kind, struct.unpack_from("<i", data, p + 4)))
            p += 8
        elif kind == 7:
            prop_words, n = struct.unpack_from("<II", data, p + 4)
            props = list(struct.unpack_from(f"<{n}i", data, p + 12))
            prop_slot = len(entries)
            p += 12 + 4 * n
            break
        else:
            raise ValueError(f"unknown object record {kind} at {p:#x}")
    return ObjectDef(slots, entries, props, prop_slot, prop_words)


def find_animations(entries: list, read) -> dict:
    """Pair models with the FRME animations made for them.

    Nothing in the files links the two: scripts pass FRME ids to
    addAnimation at run time. But the resources of one game object are
    stored together: its models (one per level of detail and colour), their
    textures, the FRMEs, then the OB3D/OPRT whose properties list the model
    ids. So each FRME after a model and before the next OB3D/OPRT goes with
    the models whose part count it matches. Returns {model index: [FRME
    indices]}.
    """
    out, models, frmes = {}, [], []
    for e in entries:
        if e.type in (7, 8) and e.size:
            if frmes:  # a new group starts
                models, frmes = [], []
            models.append((e.index, struct.unpack_from("<I", read(e), 4)[0]))
        elif e.type == 4 and e.size >= FRME_HDR.size:
            parts = struct.unpack_from("<I", read(e), 4)[0]
            frmes.append(e.index)
            for mi, mparts in models:
                if parts and mparts == parts:
                    out.setdefault(mi, []).append(e.index)
        elif e.type in (9, 10):
            models, frmes = [], []
    return out


# ---------------------------------------------------------------------------
# glTF 2.0 export
# ---------------------------------------------------------------------------

def rest_pose(animations: list):
    """The pose to show a model in when nothing animates it: its first
    one-frame FRME (the idle "animation", type 11 in the scripts), else the
    first frame of its first FRME, else None (the bind pose)."""
    frmes = [f for _, f in animations if f.frames]
    still = [f for f in frmes if len(f.frames) == 1]
    if still or frmes:
        return (still or frmes)[0].pose(0)
    return None


def model_to_gltf(model: Model, name: str, texture_uris: dict,
                  animations: list = (), rest: dict = None,
                  fps: float = 15.0) -> str:
    """A self-contained .gltf (buffer embedded as base64) for a model.

    Every clump is a node holding its joint transform, so FRME animations
    become node animations: animations is a list of (name, Frme). The game
    advances frames by distance moved or by a script-set rate; fps is only
    used to give the exported clips a timeline. Nodes start in rest (a tag
    -> matrix pose) when given, else in the bind pose. Texture v needs no flip: glTF
    and RenderWare both put v = 0 at the top of the image.
    """
    buf = bytearray()
    views, accessors = [], []

    def add(data: bytes, target=None) -> int:
        while len(buf) % 4:
            buf.append(0)
        views.append({"buffer": 0, "byteOffset": len(buf), "byteLength": len(data),
                      **({"target": target} if target else {})})
        buf.extend(data)
        return len(views) - 1

    def accessor(values: list, ctype: str, comp: int = 5126, target=None,
                 minmax: bool = False) -> int:
        width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[ctype]
        flat = [v for item in values for v in (item if width > 1 else (item,))]
        fmt = "f" if comp == 5126 else "I"
        acc = {"bufferView": add(struct.pack(f"<{len(flat)}{fmt}", *flat), target),
               "componentType": comp, "count": len(values), "type": ctype}
        if minmax:
            cols = list(zip(*values)) if width > 1 else [values]
            acc["min"] = [min(c) for c in cols]
            acc["max"] = [max(c) for c in cols]
        accessors.append(acc)
        return len(accessors) - 1

    materials, images, textures, mat_index = [], [], [], {}

    def material(mat: Material) -> int:
        if mat in mat_index:
            return mat_index[mat]
        pbr = {"baseColorFactor": [*mat.color, mat.opacity],
               "metallicFactor": 0.0, "roughnessFactor": 1.0}
        m = {"name": mat.texture or "color", "pbrMetallicRoughness": pbr,
             "doubleSided": True}
        uri = texture_uris.get(mat.texture.upper()) if mat.texture else None
        if uri:
            pbr["baseColorFactor"] = [1.0, 1.0, 1.0, mat.opacity]
            if uri not in [i["uri"] for i in images]:
                images.append({"uri": uri})
                textures.append({"source": len(images) - 1, "sampler": 0})
            ti = [i["uri"] for i in images].index(uri)
            pbr["baseColorTexture"] = {"index": ti}
            m["alphaMode"] = "MASK"  # palette index 0 is transparent
        elif mat.opacity < 1:
            m["alphaMode"] = "BLEND"
        materials.append(m)
        mat_index[mat] = len(materials) - 1
        return mat_index[mat]

    nodes, meshes = [], []
    for ci, c in enumerate(model.clumps):
        node = {"name": f"part{c.tag}" if c.tag else f"clump{ci + 1}"}
        local = rest.get(c.tag, c.matrix) if rest and c.tag else c.matrix
        if local != IDENTITY:
            t, r, s = decompose(local)
            node.update(translation=list(t), rotation=list(r), scale=list(s))
        prims = {}
        for idx, mat in c.faces:
            prims.setdefault(mat, []).append(idx)
        primitives = []
        for mat, faces in prims.items():
            pos, uvs, tri, remap = [], [], [], {}
            for idx in faces:
                for i in idx:
                    if i not in remap:
                        remap[i] = len(pos)
                        x, y, z, uv = c.verts[i]
                        pos.append((x, y, z))
                        uvs.append(uv or (0.0, 0.0))
                for k in range(1, len(idx) - 1):  # fan; G-Nome's polygons are convex
                    tri.extend((remap[idx[0]], remap[idx[k]], remap[idx[k + 1]]))
            attrs = {"POSITION": accessor(pos, "VEC3", target=34962, minmax=True)}
            if mat.texture:
                attrs["TEXCOORD_0"] = accessor(uvs, "VEC2", target=34962)
            primitives.append({"attributes": attrs,
                               "indices": accessor(tri, "SCALAR", 5125, 34963),
                               "material": material(mat)})
        if primitives:
            meshes.append({"name": node["name"], "primitives": primitives})
            node["mesh"] = len(meshes) - 1
        nodes.append(node)
    roots = []
    for ci, c in enumerate(model.clumps):
        if c.parent >= 0:
            nodes[c.parent].setdefault("children", []).append(ci)
        else:
            roots.append(ci)

    anims = []
    tag_node = model.by_tag()
    for aname, frme in animations:
        if not frme.frames:
            continue
        n = len(frme.frames)
        # A one-frame clip still needs two keys to have a duration.
        times = [f / fps for f in range(max(n, 2))]
        inp = accessor(times, "SCALAR", minmax=True)
        samplers, channels = [], []
        for k in range(frme.parts):
            ni = tag_node.get(k + 1)
            if ni is None:
                continue
            trs = [decompose(frme.frames[min(f, n - 1)][k]) for f in range(len(times))]
            for path, j, ctype in (("translation", 0, "VEC3"),
                                   ("rotation", 1, "VEC4"), ("scale", 2, "VEC3")):
                vals = [v[j] for v in trs]
                if path == "rotation":  # keep neighbouring quaternions on one side
                    for f in range(1, len(vals)):
                        if sum(a * b for a, b in zip(vals[f], vals[f - 1])) < 0:
                            vals[f] = tuple(-c for c in vals[f])
                samplers.append({"input": inp, "output": accessor(vals, ctype),
                                 "interpolation": "LINEAR"})
                channels.append({"sampler": len(samplers) - 1,
                                 "target": {"node": ni, "path": path}})
        if channels:
            anims.append({"name": aname, "samplers": samplers, "channels": channels})

    gltf = {
        "asset": {"version": "2.0", "generator": "g-nome tools/gnome3d.py"},
        "scene": 0, "scenes": [{"name": name, "nodes": roots}],
        "nodes": nodes, "meshes": meshes, "materials": materials,
        "accessors": accessors, "bufferViews": views,
        "buffers": [{"byteLength": len(buf), "uri": "data:application/octet-stream;base64,"
                     + base64.b64encode(bytes(buf)).decode()}],
    }
    if images:
        gltf.update(images=images, textures=textures,
                    samplers=[{"magFilter": 9728, "minFilter": 9728}])
    if anims:
        gltf["animations"] = anims
    for k in ("meshes", "materials"):
        if not gltf[k]:
            del gltf[k]
    return json.dumps(gltf, separators=(",", ":"))
