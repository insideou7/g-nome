"""Real-ESRGAN super-resolution models as ONNX, without PyTorch.

Reads a Real-ESRGAN .pth checkpoint (a PyTorch zip: data.pkl plus raw
tensor storages) with a small unpickler, and writes the network as an ONNX
graph that onnxruntime runs on the CPU (or onnxruntime-web in a browser).

Two architectures, by the checkpoint's keys:
  SRVGGNetCompact  realesr-animevideov3.pth, realesr-general-x4v3.pth
                   (conv + PReLU stack, pixel shuffle, plus nearest-upscaled
                   input; fast)
  RRDBNet          RealESRGAN_x4plus.pth, RealESRGAN_x4plus_anime_6B.pth
                   (ESRGAN's residual-in-residual dense blocks; slow, best)

Weights: https://github.com/xinntao/Real-ESRGAN/releases (BSD-3-Clause).
"""
import collections
import pickle
import zipfile

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

DTYPES = {"FloatStorage": np.float32, "HalfStorage": np.float16, "DoubleStorage": np.float64,
          "LongStorage": np.int64, "IntStorage": np.int32}


def load_pth(path):
    """State dict of a PyTorch zip checkpoint as {name: numpy array}."""
    z = zipfile.ZipFile(path)
    pkl = next(n for n in z.namelist() if n.endswith("data.pkl"))
    prefix = pkl[: -len("data.pkl")]

    def rebuild(storage, offset, size, stride, *_):
        dtype, key = storage
        flat = np.frombuffer(z.read(f"{prefix}data/{key}"), dtype=dtype)
        if not size:
            return flat[offset:offset + 1].reshape(()).copy()
        item = flat.itemsize
        return np.lib.stride_tricks.as_strided(flat[offset:], tuple(size), tuple(s * item for s in stride)).astype(np.float32)

    class Unpickler(pickle.Unpickler):
        def find_class(self, mod, name):
            if mod == "torch._utils" and name in ("_rebuild_tensor_v2", "_rebuild_tensor"):
                return rebuild
            if mod == "torch" and name in DTYPES:
                return DTYPES[name]
            if mod == "collections" and name == "OrderedDict":
                return collections.OrderedDict
            if mod == "torch._utils" and name == "_rebuild_parameter":
                return lambda data, *_: data
            raise pickle.UnpicklingError(f"unexpected {mod}.{name} in checkpoint")

        def persistent_load(self, pid):
            # ('storage', storage type, key, location, numel)
            return (pid[1], pid[2])

    sd = Unpickler(z.open(pkl)).load()
    for k in ("params_ema", "params"):
        if isinstance(sd, dict) and k in sd:
            return sd[k]
    return sd


class Graph:
    def __init__(self):
        self.nodes, self.inits, self.n = [], [], 0

    def name(self, base):
        self.n += 1
        return f"{base}_{self.n}"

    def const(self, arr, base="c"):
        n = self.name(base)
        self.inits.append(numpy_helper.from_array(np.asarray(arr), n))
        return n

    def op(self, kind, inputs, **attrs):
        out = self.name(kind)
        self.nodes.append(helper.make_node(kind, inputs, [out], **attrs))
        return out

    def conv(self, x, sd, key):
        w = sd[key + ".weight"]
        k = w.shape[-1]
        return self.op("Conv", [x, self.const(w, "w"), self.const(sd[key + ".bias"], "b")],
                       kernel_shape=[k, k], pads=[k // 2] * 4)

    def lrelu(self, x):
        return self.op("LeakyRelu", [x], alpha=0.2)

    def up(self, x, s):
        return self.op("Resize", [x, "", self.const(np.array([1, 1, s, s], np.float32), "scales")], mode="nearest")

    def add(self, a, b):
        return self.op("Add", [a, b])

    def scale(self, x, f):
        return self.op("Mul", [x, self.const(np.array(f, np.float32), "f")])

    def model(self, x, out):
        g = helper.make_graph(self.nodes, "sr", [helper.make_tensor_value_info(x, TensorProto.FLOAT, [1, 3, None, None])],
                              [helper.make_tensor_value_info(out, TensorProto.FLOAT, [1, 3, None, None])], self.inits)
        m = helper.make_model(g, opset_imports=[helper.make_opsetid("", 13)])
        m.ir_version = 8
        return m


def compact(sd, scale=4):
    g = Graph()
    x = "input"
    convs = sorted({int(k.split(".")[1]) for k in sd if k.startswith("body.")})
    h = x
    for i in convs:
        key = f"body.{i}"
        if key + ".bias" in sd:
            h = g.conv(h, sd, key)
        else:  # PReLU
            h = g.op("PRelu", [h, g.const(sd[key + ".weight"].reshape(-1, 1, 1), "slope")])
    h = g.op("DepthToSpace", [h], blocksize=scale, mode="CRD")
    return g.model(x, g.add(h, g.up(x, scale)))


def rrdb(sd):
    g = Graph()
    x = "input"
    fea = g.conv(x, sd, "conv_first")
    nblocks = len({k.split(".")[1] for k in sd if k.startswith("body.")})
    h = fea
    for b in range(nblocks):
        r_in = h
        for r in range(1, 4):
            p = f"body.{b}.rdb{r}"
            feats = [h]
            for c in range(1, 5):
                cat = feats[0] if len(feats) == 1 else g.op("Concat", feats, axis=1)
                feats.append(g.lrelu(g.conv(cat, sd, f"{p}.conv{c}")))
            x5 = g.conv(g.op("Concat", feats, axis=1), sd, f"{p}.conv5")
            h = g.add(g.scale(x5, 0.2), h)
        h = g.add(g.scale(h, 0.2), r_in)
    fea = g.add(fea, g.conv(h, sd, "conv_body"))
    fea = g.lrelu(g.conv(g.up(fea, 2), sd, "conv_up1"))
    fea = g.lrelu(g.conv(g.up(fea, 2), sd, "conv_up2"))
    return g.model(x, g.conv(g.lrelu(g.conv(fea, sd, "conv_hr")), sd, "conv_last"))


def to_onnx(pth):
    """ONNX model (onnx.ModelProto) for a Real-ESRGAN x4 checkpoint."""
    sd = load_pth(pth)
    m = rrdb(sd) if "conv_first.weight" in sd else compact(sd)
    onnx.checker.check_model(m)
    return m


if __name__ == "__main__":
    import sys
    if len(sys.argv) != 3:
        sys.exit("usage: sr_onnx.py MODEL.pth OUT.onnx")
    onnx.save(to_onnx(sys.argv[1]), sys.argv[2])
