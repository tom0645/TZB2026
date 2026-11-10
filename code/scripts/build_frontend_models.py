"""生成前端三维预览使用的自制低面数模型。

全部几何由标准库构造，不下载外部素材。模型单位为米，遵循 glTF 的
Y 轴向上和本项目的 +X 向前约定；地面模型脚下为 Y=0。
"""

from __future__ import annotations

import json
import math
from pathlib import Path
import struct


PALETTE = {
    "uav": (0.21, 0.38, 0.50, 1.0),
    "uav_edge": (0.54, 0.68, 0.74, 1.0),
    "metal": (0.23, 0.28, 0.31, 1.0),
    "dark": (0.07, 0.11, 0.13, 1.0),
    "glass": (0.13, 0.24, 0.28, 1.0),
    "ugv": (0.32, 0.41, 0.32, 1.0),
    "ugv_edge": (0.55, 0.61, 0.48, 1.0),
    "rubber": (0.12, 0.15, 0.15, 1.0),
    "bark": (0.31, 0.27, 0.20, 1.0),
    "leaves": (0.31, 0.43, 0.31, 1.0),
    "leaves_light": (0.42, 0.52, 0.36, 1.0),
    "cloth": (0.58, 0.40, 0.34, 1.0),
    "skin": (0.76, 0.64, 0.49, 1.0),
    "vehicle": (0.47, 0.43, 0.36, 1.0),
    "facility": (0.63, 0.65, 0.58, 1.0),
    "signal": (0.79, 0.57, 0.28, 1.0),
}


def add(a, b):
    return tuple(x + y for x, y in zip(a, b))


def sub(a, b):
    return tuple(x - y for x, y in zip(a, b))


def mul(a, factor):
    return tuple(x * factor for x in a)


def dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0])


def unit(a):
    length = math.sqrt(dot(a, a))
    return mul(a, 1.0 / length) if length > 1e-12 else (0.0, 1.0, 0.0)


class Mesh:
    """按材质合批三角形，并为每个面生成明确的外法线。"""

    def __init__(self):
        self.parts = {}

    def triangle(self, a, b, c, material, center=None):
        normal = cross(sub(b, a), sub(c, a))
        if dot(normal, normal) < 1e-16:
            return
        if center is not None:
            middle = mul(add(add(a, b), c), 1.0 / 3.0)
            if dot(normal, sub(middle, center)) < 0:
                b, c = c, b
                normal = mul(normal, -1)
        normal = unit(normal)
        positions, normals = self.parts.setdefault(material, ([], []))
        for point in (a, b, c):
            positions.extend(point)
            normals.extend(normal)

    def box(self, center, size, material, yaw=0.0):
        cx, cy, cz = center
        sx, sy, sz = (value / 2.0 for value in size)
        points = []
        for x, y, z in ((-sx, -sy, -sz), (sx, -sy, -sz),
                        (sx, sy, -sz), (-sx, sy, -sz),
                        (-sx, -sy, sz), (sx, -sy, sz),
                        (sx, sy, sz), (-sx, sy, sz)):
            points.append((cx + x * math.cos(yaw) - z * math.sin(yaw),
                           cy + y,
                           cz + x * math.sin(yaw) + z * math.cos(yaw)))
        for face in ((0, 1, 2, 3), (4, 5, 6, 7),
                     (0, 4, 7, 3), (1, 5, 6, 2),
                     (0, 1, 5, 4), (3, 2, 6, 7)):
            a, b, c, d = (points[index] for index in face)
            self.triangle(a, b, c, material, center)
            self.triangle(a, c, d, material, center)

    def cylinder(self, start, end, radius, material, top_radius=None, segments=10):
        """生成可指定轴向的圆柱或圆锥，端点是两端截面的圆心。"""
        top_radius = radius if top_radius is None else top_radius
        axis = unit(sub(end, start))
        reference = (1.0, 0.0, 0.0) if abs(axis[1]) > 0.9 else (0.0, 1.0, 0.0)
        u = unit(cross(axis, reference))
        v = cross(axis, u)
        bottom, top = [], []
        for i in range(segments):
            angle = i * math.tau / segments
            radial = add(mul(u, math.cos(angle)), mul(v, math.sin(angle)))
            bottom.append(add(start, mul(radial, radius)))
            top.append(add(end, mul(radial, top_radius)))
        for i in range(segments):
            following = (i + 1) % segments
            self.triangle(bottom[i], bottom[following], top[following], material)
            self.triangle(bottom[i], top[following], top[i], material)
            self.triangle(start, bottom[following], bottom[i], material)
            self.triangle(end, top[i], top[following], material)

    def ellipsoid(self, center, radii, material, rings=6, segments=10):
        """生成具有平面法线的低面数椭球。"""
        def point(row, col):
            latitude = -math.pi / 2.0 + math.pi * row / rings
            longitude = math.tau * col / segments
            return (center[0] + radii[0] * math.cos(latitude) * math.cos(longitude),
                    center[1] + radii[1] * math.sin(latitude),
                    center[2] + radii[2] * math.cos(latitude) * math.sin(longitude))

        for row in range(rings):
            for col in range(segments):
                a, b = point(row, col), point(row, col + 1)
                c, d = point(row + 1, col + 1), point(row + 1, col)
                self.triangle(a, b, c, material, center)
                self.triangle(a, c, d, material, center)

    def ring(self, center, radius, thickness, material, segments=16):
        for i in range(segments):
            a, b = i * math.tau / segments, (i + 1) * math.tau / segments
            self.cylinder((center[0] + radius * math.cos(a), center[1], center[2] + radius * math.sin(a)),
                          (center[0] + radius * math.cos(b), center[1], center[2] + radius * math.sin(b)),
                          thickness, material, segments=4)

    def glb(self, name):
        """打包为无需纹理或外部缓冲的 glTF 2.0 二进制文件。"""
        data = bytearray()
        views, accessors, primitives, materials = [], [], [], []
        all_positions = []

        def accessor(values, include_bounds=False):
            offset = len(data)
            data.extend(struct.pack(f"<{len(values)}f", *values))
            views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(values) * 4,
                          "target": 34962})
            info = {"bufferView": len(views) - 1, "componentType": 5126,
                    "count": len(values) // 3, "type": "VEC3"}
            if include_bounds:
                info["min"] = [min(values[axis::3]) for axis in range(3)]
                info["max"] = [max(values[axis::3]) for axis in range(3)]
            accessors.append(info)
            return len(accessors) - 1

        for material, (positions, normals) in self.parts.items():
            position_index = accessor(positions, include_bounds=True)
            normal_index = accessor(normals)
            all_positions.extend(positions)
            color = list(PALETTE[material])
            materials.append({
                "name": material,
                "pbrMetallicRoughness": {"baseColorFactor": color,
                                         "metallicFactor": 0.08 if material == "metal" else 0.0,
                                         "roughnessFactor": 0.8},
            })
            primitives.append({"attributes": {"POSITION": position_index, "NORMAL": normal_index},
                               "material": len(materials) - 1, "mode": 4})
        bounds = {
            "min": [min(all_positions[axis::3]) for axis in range(3)],
            "max": [max(all_positions[axis::3]) for axis in range(3)],
        }
        document = {
            "asset": {"version": "2.0", "generator": "TZB2026 local geometric model builder"},
            "scene": 0, "scenes": [{"nodes": [0]}],
            "nodes": [{"name": name, "mesh": 0}],
            "meshes": [{"name": name, "primitives": primitives}],
            "materials": materials,
            "buffers": [{"byteLength": len(data)}],
            "bufferViews": views, "accessors": accessors,
            "extras": {"units": "m", "up_axis": "+Y", "forward_axis": "+X", "bounds": bounds},
        }
        text = json.dumps(document, separators=(",", ":")).encode("utf-8")
        text += b" " * (-len(text) % 4)
        data.extend(b"\0" * (-len(data) % 4))
        length = 12 + 8 + len(text) + 8 + len(data)
        result = (struct.pack("<4sII", b"glTF", 2, length)
                  + struct.pack("<I4s", len(text), b"JSON") + text
                  + struct.pack("<I4s", len(data), b"BIN\0") + data)
        return result, bounds, len(all_positions) // 9


def build_uav():
    mesh = Mesh()
    mesh.ellipsoid((0.0, 0.02, 0.0), (0.40, 0.15, 0.24), "uav")
    mesh.box((0.09, 0.13, 0.0), (0.37, 0.07, 0.24), "uav_edge")
    for x in (-0.73, 0.73):
        for z in (-0.73, 0.73):
            mesh.cylinder((0.0, 0.0, 0.0), (x, 0.02, z), 0.055, "metal", segments=6)
            mesh.cylinder((x, 0.0, z), (x, 0.14, z), 0.09, "uav_edge", segments=10)
            mesh.ring((x, 0.15, z), 0.39, 0.012, "metal")
            mesh.box((x, 0.16, z), (0.74, 0.022, 0.065), "dark", yaw=0.35 if x * z > 0 else -0.35)
            mesh.cylinder((x, 0.13, z), (x, 0.20, z), 0.045, "uav_edge", segments=8)
    for z in (-0.18, 0.18):
        mesh.cylinder((-0.23, -0.30, z), (0.28, -0.30, z), 0.023, "metal", segments=6)
        for x in (-0.19, 0.19):
            mesh.cylinder((x, -0.03, z * 0.7), (x, -0.30, z), 0.022, "metal", segments=6)
    mesh.cylinder((0.30, -0.07, 0.0), (0.30, -0.22, 0.0), 0.035, "metal", segments=6)
    mesh.ellipsoid((0.30, -0.23, 0.0), (0.09, 0.08, 0.09), "dark", rings=4, segments=8)
    mesh.cylinder((0.36, -0.23, 0.0), (0.40, -0.23, 0.0), 0.046, "glass", segments=8)
    return mesh


def wheels(mesh, xs, half_width, radius, center_y):
    for x in xs:
        for side in (-1, 1):
            start = (x, center_y, side * (half_width - 0.11))
            end = (x, center_y, side * (half_width + 0.12))
            mesh.cylinder(start, end, radius, "rubber", segments=12)
            mesh.cylinder((x, center_y, side * (half_width + 0.125)),
                          (x, center_y, side * (half_width + 0.14)),
                          radius * 0.46, "metal", segments=8)


def build_ugv():
    mesh = Mesh()
    wheels(mesh, (-0.98, 0.0, 0.98), 0.67, 0.32, 0.32)
    mesh.box((0.0, 0.48, 0.0), (2.62, 0.28, 1.10), "metal")
    mesh.box((0.0, 0.91, 0.0), (2.62, 0.72, 1.18), "ugv")
    mesh.box((0.74, 1.22, 0.0), (0.92, 0.35, 1.02), "ugv_edge")
    mesh.box((1.21, 1.23, 0.0), (0.025, 0.24, 0.86), "glass")
    mesh.box((-0.69, 1.30, 0.0), (0.93, 0.16, 0.99), "ugv_edge")
    mesh.box((-0.70, 1.39, 0.0), (0.70, 0.025, 0.76), "ugv")
    for x in (-1.44, 1.44):
        mesh.box((x, 0.64, 0.0), (0.20, 0.18, 1.26), "metal")
    for z in (-0.42, 0.42):
        mesh.box((1.325, 0.93, z), (0.025, 0.10, 0.13), "signal")
    mesh.cylinder((-0.22, 1.28, 0.0), (-0.22, 1.65, 0.0), 0.04, "metal", segments=8)
    mesh.cylinder((-0.22, 1.65, 0.0), (-0.22, 1.80, 0.0), 0.17, "dark", segments=12)
    mesh.cylinder((-0.22, 1.80, 0.0), (-0.22, 1.84, 0.0), 0.18, "ugv_edge", segments=12)
    mesh.cylinder((-0.98, 1.38, -0.36), (-0.98, 1.97, -0.36), 0.015, "metal", segments=4)
    return mesh


def build_tree():
    mesh = Mesh()
    mesh.cylinder((0.0, 0.0, 0.0), (0.0, 4.5, 0.0), 0.25, "bark", top_radius=0.12, segments=8)
    mesh.cylinder((0.0, 2.8, 0.0), (0.0, 9.4, 0.0), 2.65, "leaves", top_radius=0.0, segments=9)
    mesh.cylinder((0.0, 6.3, 0.0), (0.0, 12.0, 0.0), 1.85, "leaves_light", top_radius=0.0, segments=9)
    return mesh


def build_person():
    mesh = Mesh()
    for z in (-0.11, 0.11):
        mesh.box((0.07, 0.07, z), (0.30, 0.14, 0.15), "dark")
        mesh.cylinder((0.0, 0.13, z), (0.0, 0.82, z), 0.073, "metal", segments=7)
    mesh.box((0.0, 1.09, 0.0), (0.26, 0.58, 0.40), "cloth")
    mesh.cylinder((0.0, 1.35, 0.0), (0.0, 1.49, 0.0), 0.07, "skin", segments=7)
    mesh.ellipsoid((0.025, 1.65, 0.0), (0.145, 0.18, 0.14), "skin", rings=5, segments=8)
    for side in (-1, 1):
        mesh.cylinder((0.0, 1.30, side * 0.26), (0.01, 0.87, side * 0.29), 0.064, "cloth", segments=7)
        mesh.ellipsoid((0.01, 0.83, side * 0.29), (0.062, 0.085, 0.060), "skin", rings=4, segments=6)
    return mesh


def build_vehicle():
    mesh = Mesh()
    wheels(mesh, (-1.10, 1.10), 0.78, 0.34, 0.34)
    mesh.box((0.0, 0.68, 0.0), (3.35, 0.65, 1.42), "vehicle")
    mesh.box((-0.16, 1.13, 0.0), (1.73, 0.46, 1.22), "vehicle")
    mesh.box((0.72, 1.17, 0.0), (0.025, 0.29, 1.04), "glass")
    mesh.box((-1.04, 1.17, 0.0), (0.025, 0.29, 1.04), "glass")
    for z in (-0.62, 0.62):
        mesh.box((-0.16, 1.17, z), (1.53, 0.27, 0.018), "glass")
    for x in (-1.76, 1.76):
        mesh.box((x, 0.50, 0.0), (0.16, 0.18, 1.45), "metal")
    for z in (-0.53, 0.53):
        mesh.box((1.69, 0.83, z), (0.025, 0.12, 0.22), "signal")
    return mesh


def build_facility():
    mesh = Mesh()
    mesh.box((0.0, 0.13, 0.0), (2.60, 0.26, 2.10), "metal")
    mesh.box((0.0, 1.28, 0.0), (2.25, 2.05, 1.74), "facility")
    mesh.box((0.0, 2.34, 0.0), (2.52, 0.16, 2.00), "ugv")
    mesh.box((1.135, 1.19, 0.25), (0.025, 1.66, 0.73), "metal")
    mesh.box((1.155, 1.39, 0.25), (0.025, 0.43, 0.50), "glass")
    for y in (0.9, 1.1, 1.3, 1.5):
        mesh.box((0.0, y, -0.884), (1.30, 0.065, 0.025), "metal")
    mesh.cylinder((-0.67, 2.42, 0.0), (-0.67, 4.75, 0.0), 0.035, "metal", segments=6)
    mesh.cylinder((-0.67, 4.65, -0.47), (-0.67, 4.65, 0.47), 0.025, "metal", segments=6)
    mesh.ellipsoid((-0.67, 4.78, 0.0), (0.06, 0.06, 0.06), "signal", rings=4, segments=6)
    return mesh


def validate_glb(content):
    """校验打包长度、缓冲引用、顶点范围和法线。"""
    magic, version, length = struct.unpack_from("<4sII", content)
    assert (magic, version, length) == (b"glTF", 2, len(content))
    json_length, json_type = struct.unpack_from("<I4s", content, 12)
    assert json_type == b"JSON" and json_length % 4 == 0
    document = json.loads(content[20:20 + json_length])
    bin_offset = 20 + json_length
    bin_length, bin_type = struct.unpack_from("<I4s", content, bin_offset)
    assert bin_type == b"BIN\0" and bin_length % 4 == 0
    binary = content[bin_offset + 8:]
    assert len(binary) == bin_length == document["buffers"][0]["byteLength"]
    for accessor in document["accessors"]:
        view = document["bufferViews"][accessor["bufferView"]]
        offset = view.get("byteOffset", 0)
        assert offset % 4 == 0 and offset + view["byteLength"] <= len(binary)
        assert accessor["count"] * 12 == view["byteLength"]
        values = struct.unpack_from(f"<{accessor['count'] * 3}f", binary, offset)
        assert all(math.isfinite(value) for value in values)
        if "min" in accessor:
            for axis in range(3):
                assert abs(min(values[axis::3]) - accessor["min"][axis]) < 1e-5
                assert abs(max(values[axis::3]) - accessor["max"][axis]) < 1e-5
        else:
            for index in range(0, len(values), 3):
                assert abs(sum(value * value for value in values[index:index + 3]) - 1.0) < 1e-5
    return document


def main():
    destination = Path(__file__).resolve().parents[2] / "frontend" / "assets" / "models"
    destination.mkdir(parents=True, exist_ok=True)
    manifest = {"units": "m", "up_axis": "+Y", "forward_axis": "+X", "models": {}}
    builders = {"uav": build_uav, "ugv": build_ugv, "tree": build_tree,
                "person": build_person, "vehicle": build_vehicle, "facility": build_facility}
    for name, builder in builders.items():
        content, bounds, triangle_count = builder().glb(name)
        validate_glb(content)
        if name == "tree":
            assert bounds["min"][1] == 0.0 and bounds["max"][1] == 12.0
        elif name != "uav":
            assert abs(bounds["min"][1]) < 1e-9
        (destination / f"{name}.glb").write_bytes(content)
        manifest["models"][name] = {"uri": f"{name}.glb", "bounds": bounds,
                                     "triangles": triangle_count, "bytes": len(content)}
        print(f"{name}.glb: {triangle_count} triangles, {len(content)} bytes, bounds={bounds}")
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
