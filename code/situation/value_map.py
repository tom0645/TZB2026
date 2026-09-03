"""搜索价值图 —— 静态先验 + 动态线索高斯热源叠加，表达"目标更可能出现在哪里"。"""

import numpy as np
from dataclasses import dataclass


@dataclass
class CueSource:
    """动态线索热源"""
    grid_pos: tuple[int, int]        # 线索参考位置（网格坐标）
    sigma: float                      # 高斯分布 sigma（网格单位）
    peak: float                       # 置信度峰值 [0, 1]
    born_time: float                  # 线索注入时刻
    half_life: float                  # 半衰期（秒）


class ValueMap:
    """搜索价值图：静态先验 + 动态线索热源"""

    def __init__(self, scene_width: float, scene_height: float, resolution: float = 50.0):
        self.resolution = resolution
        self.width = int(scene_width / resolution)
        self.height = int(scene_height / resolution)
        self.base: np.ndarray = np.zeros((self.height, self.width))   # 静态先验
        self.sources: list[CueSource] = []                             # 动态线索热源列表

    def set_static_prior(self, prior_type: str, **params):
        """设置场景静态先验分布。

        Args:
            prior_type:
                "uniform"        — 全图均匀（搜救）
                "border_decay"   — 沿边境线距离衰减（边境巡检）
                "perimeter_decay"— 从外围向内衰减（区域封控）
            **params: 各类型所需的参数
        """
        if prior_type == "uniform":
            # 全图均匀分布
            self.base = np.ones((self.height, self.width))

        elif prior_type == "border_decay":
            # 价值沿边境线 Y 坐标距离线性衰减
            border_y = params.get("border_y", 0.0)
            max_dist = params.get("max_dist", 12000.0)

            for gy in range(self.height):
                world_y = gy * self.resolution
                dist = abs(world_y - border_y)
                self.base[gy, :] = max(0.0, 1.0 - dist / max_dist)

        elif prior_type == "perimeter_decay":
            # 价值从外边界向内衰减（距离中心越远，价值越高）
            center_x = params.get("center_x", self.width * self.resolution / 2)
            center_y = params.get("center_y", self.height * self.resolution / 2)
            max_radius = params.get("max_radius", 3000.0)

            for gy in range(self.height):
                for gx in range(self.width):
                    world_x = gx * self.resolution
                    world_y = gy * self.resolution
                    dist_to_center = np.sqrt((world_x - center_x) ** 2 + (world_y - center_y) ** 2)
                    self.base[gy, gx] = min(1.0, dist_to_center / max_radius)

    def inject_cue(self, position: tuple[float, float], radius: float,
                   confidence: float, time: float, half_life: float = 300.0):
        """注入动态线索，在价值图上叠加一个高斯热源。

        Args:
            position: 线索参考位置 (x, y)，米制坐标
            radius: 线索影响半径，米
            confidence: 置信度 [0, 1]
            time: 线索注入时刻
            half_life: 线索半衰期，秒（默认 5 分钟）
        """
        self.sources.append(CueSource(
            grid_pos=self._world_to_grid(position),
            sigma=radius / (2.0 * self.resolution),  # 半径映射到 2σ
            peak=confidence,
            born_time=time,
            half_life=half_life,
        ))

    def evaluate(self, current_time: float) -> np.ndarray:
        """评估当前时刻全图价值分布，返回归一化到 [0, 1] 的网格。

        静态先验 + 所有动态热源（含指数衰减）。
        """
        value = self.base.copy().astype(np.float64)

        for src in self.sources:
            age = current_time - src.born_time
            if age < 0:
                continue
            decay = 0.5 ** (age / src.half_life)
            if decay < 0.01:
                continue  # 衰减到可忽略

            # 在热源位置叠加高斯分布
            gx, gy = src.grid_pos
            sigma = src.sigma
            y_indices, x_indices = np.ogrid[:self.height, :self.width]
            gaussian = np.exp(-((x_indices - gx) ** 2 + (y_indices - gy) ** 2) / (2 * sigma ** 2))
            value += gaussian * src.peak * decay

        return np.clip(value, 0.0, 1.0)

    def _world_to_grid(self, pos: tuple[float, float]) -> tuple[int, int]:
        """世界坐标 → 网格坐标"""
        return int(pos[0] / self.resolution), int(pos[1] / self.resolution)
