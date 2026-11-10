"""把自制三维模型合并为单个绘制批次，保留几何和各部件的基础颜色。

原资源保持不变；只处理本项目不含纹理、骨骼和节点变换的三角形模型。
原材质的基础颜色转存为逐顶点 COLOR_0，合并后共用白色粗糙材质。
"""

from __future__ import annotations

import json
import math
from pathlib import Path
import struct


MODEL_NAMES = ("uav", "ugv", "person", "vehicle", "facility", "tree")
COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_glb(path: Path) -> tuple[dict, bytes]:
    """读取 GLB 的 JSON 与内嵌二进制，并检查块边界。"""
    data = path.read_bytes()
    magic, version, length = struct.unpack_from("<4sII", data)
    assert magic == b"glTF" and version == 2 and length == len(data), path
    chunks = {}
    offset = 12
    while offset < len(data):
        size, kind = struct.unpack_from("<I4s", data, offset)
        assert size % 4 == 0 and offset + 8 + size <= len(data)
        chunks[kind] = data[offset + 8:offset + 8 + size]
        offset += 8 + size
    assert offset == len(data) and b"JSON" in chunks and b"BIN\0" in chunks
    return json.loads(chunks[b"JSON"]), chunks[b"BIN\0"]


def floats(document: dict, data: bytes, index: int) -> list[float]:
    """读取本项目使用的连续 Float32 属性，避免无意处理不支持的资源。"""
    accessor = document["accessors"][index]
    view = document["bufferViews"][accessor["bufferView"]]
    assert accessor["componentType"] == 5126 and not accessor.get("normalized", False)
    assert "sparse" not in accessor and view.get("buffer", 0) == 0
    components = COMPONENTS[accessor["type"]]
    stride = view.get("byteStride", components * 4)
    assert stride == components * 4
    count = accessor["count"] * components
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    assert offset % 4 == 0 and offset + count * 4 <= len(data)
    return list(struct.unpack_from(f"<{count}f", data, offset))


def unpack_geometry(document: dict, data: bytes) -> tuple[list[float], list[float], list[float]]:
    """按原部件顺序展开三角形，保留坐标、法线和不透明基础颜色。"""
    assert len(document["meshes"]) == 1 and len(document["nodes"]) == 1
    node = document["nodes"][0]
    assert node.get("mesh") == 0
    assert not any(key in node for key in ("matrix", "translation", "rotation", "scale"))
    assert not any(document.get(key) for key in ("animations", "skins", "textures", "images"))
    positions, normals, colors = [], [], []
    for primitive in document["meshes"][0]["primitives"]:
        assert primitive.get("mode", 4) == 4 and "indices" not in primitive
        attributes = primitive["attributes"]
        assert set(attributes) <= {"POSITION", "NORMAL", "COLOR_0"}
        part_positions = floats(document, data, attributes["POSITION"])
        part_normals = floats(document, data, attributes["NORMAL"])
        assert len(part_positions) == len(part_normals) and len(part_positions) % 9 == 0
        material = document["materials"][primitive.get("material", 0)]
        assert material.get("alphaMode", "OPAQUE") == "OPAQUE"
        color = material.get("pbrMetallicRoughness", {}).get("baseColorFactor", [1, 1, 1, 1])
        assert len(color) == 4 and color[3] == 1
        positions.extend(part_positions)
        normals.extend(part_normals)
        if "COLOR_0" in attributes:
            part_colors = floats(document, data, attributes["COLOR_0"])
            assert len(part_colors) == len(part_positions) // 3 * 4
            colors.extend(value * color[index % 4] for index, value in enumerate(part_colors))
        else:
            colors.extend(color * (len(part_positions) // 3))
    assert all(math.isfinite(value) for values in (positions, normals, colors) for value in values)
    assert all(0 <= value <= 1 for value in colors)
    return positions, normals, colors


def bounds(values: list[float]) -> dict:
    return {"min": [min(values[axis::3]) for axis in range(3)],
            "max": [max(values[axis::3]) for axis in range(3)]}


def optimize(name: str, source: Path, destination: Path) -> dict:
    """合并为单个三角形 primitive，输出后重新读取校验几何与颜色。"""
    original, original_data = read_glb(source)
    positions, normals, colors = unpack_geometry(original, original_data)
    binary = bytearray()
    accessors, views = [], []
    for attribute, values, kind in (("POSITION", positions, "VEC3"),
                                    ("NORMAL", normals, "VEC3"),
                                    ("COLOR_0", colors, "VEC4")):
        offset = len(binary)
        binary.extend(struct.pack(f"<{len(values)}f", *values))
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(values) * 4, "target": 34962})
        accessor = {"bufferView": len(views) - 1, "componentType": 5126,
                    "count": len(values) // COMPONENTS[kind], "type": kind}
        if attribute == "POSITION":
            accessor.update(bounds(values))
        accessors.append(accessor)
    document = {
        "asset": {"version": "2.0", "generator": "TZB2026 单批次顶点色模型优化器"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": name, "mesh": 0}],
        "meshes": [{"name": name, "primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "COLOR_0": 2},
                                                  "material": 0, "mode": 4}]}],
        "materials": [{"name": "vertex-colors", "alphaMode": "OPAQUE",
                       "pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1],
                                                "metallicFactor": 0, "roughnessFactor": 1}}],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(binary)}],
        "extras": {"units": "m", "upAxis": "+Y", "forwardAxis": "+X", "source": "../" + source.name},
    }
    encoded = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    encoded += b" " * (-len(encoded) % 4)
    binary.extend(b"\0" * (-len(binary) % 4))
    total = 12 + 8 + len(encoded) + 8 + len(binary)
    result = struct.pack("<4sII", b"glTF", 2, total)
    result += struct.pack("<I4s", len(encoded), b"JSON") + encoded
    result += struct.pack("<I4s", len(binary), b"BIN\0") + binary
    destination.write_bytes(result)

    checked, checked_data = read_glb(destination)
    new_positions, new_normals, new_colors = unpack_geometry(checked, checked_data)
    assert new_positions == positions, "坐标或三角形顺序被改变"
    assert new_normals == normals, "法线被改变"
    assert bounds(new_positions) == bounds(positions), "模型范围被改变"
    assert len(new_colors) == len(colors)
    assert all(abs(value - expected) < 1e-7 for value, expected in zip(new_colors, colors)), "基础颜色未保留"
    assert all(value == 1 for value in new_colors[3::4]), "模型必须保持不透明"
    assert len(checked["meshes"][0]["primitives"]) == len(checked["materials"]) == 1
    return {"uri": destination.name, "source_primitives": len(original["meshes"][0]["primitives"]),
            "primitives": 1, "triangles": len(positions) // 9, "vertices": len(positions) // 3,
            "bounds": bounds(positions), "source_bytes": source.stat().st_size,
            "bytes": len(result), "positions_exact": True, "normals_exact": True,
            "colors_preserved": True, "opaque": True}


def main() -> None:
    project = Path(__file__).resolve().parents[2]
    model_root = project / "frontend" / "assets" / "models"
    output = model_root / "optimized"
    output.mkdir(parents=True, exist_ok=True)
    entries = {name: optimize(name, model_root / f"{name}.glb", output / f"{name}.glb") for name in MODEL_NAMES}
    manifest = {"units": "m", "up_axis": "+Y", "forward_axis": "+X", "models": entries}
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "models": entries}, ensure_ascii=True))


if __name__ == "__main__":
    main()
