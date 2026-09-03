"""覆盖记录网格 —— 记录每个网格的最近传感器扫描时间，支持侵蚀模型新鲜度查询。

核心概念：
- last_scan_time: 每个网格存一个浮点数——最近一次被传感器扫描的仿真时刻
- 侵蚀模型：未扫描区域是威胁的源头。目标以 max_speed 移动，经过 Δt 后最多能从未扫描区向内推进 V×Δt。
- 新鲜度三值：0=未探索, 1=不确定(曾被扫描但可能已有目标进入), 2=安全
"""

import numpy as np


class CoverageGrid:
    """覆盖记录网格：记录每个网格的最近传感器扫描时间"""

    def __init__(self, scene_width: float, scene_height: float, resolution: float = 50.0):
        """
        Args:
            scene_width: 场景宽度（米）
            scene_height: 场景高度（米）
            resolution: 网格分辨率（米）
        """
        self.resolution = resolution
        self.scene_width = scene_width
        self.scene_height = scene_height
        self.width = int(scene_width / resolution)
        self.height = int(scene_height / resolution)
        # -inf = 从未被扫描；正值 = 扫描时刻
        self.last_scan_time: np.ndarray = np.full((self.height, self.width), -np.inf)

    def mark_scanned(self, position: tuple[float, float], sensor_range: float, time: float):
        """标记传感器覆盖范围内的网格为已扫描。

        Args:
            position: 传感器当前位置 (x, y)，米制坐标
            sensor_range: 传感器有效距离，米
            time: 当前仿真时刻
        """
        cx, cy = self._world_to_grid(position)
        radius_grid = int(sensor_range / self.resolution)

        # 对圆形区域写入当前时间
        y_start = max(0, cy - radius_grid)
        y_end = min(self.height, cy + radius_grid + 1)
        x_start = max(0, cx - radius_grid)
        x_end = min(self.width, cx + radius_grid + 1)

        for gy in range(y_start, y_end):
            for gx in range(x_start, x_end):
                if (gx - cx) ** 2 + (gy - cy) ** 2 <= radius_grid ** 2:
                    self.last_scan_time[gy, gx] = time

    def get_freshness(self, current_time: float, erosion_speed: float) -> np.ndarray:
        """查询当前新鲜度（侵蚀模型）。

        同一个 last_scan_time 网格，用不同的 erosion_speed 可得到不同的新鲜度结论。

        Args:
            current_time: 当前仿真时刻
            erosion_speed: 该实体类型的最大移动速度（m/s）

        Returns:
            三值网格（与 last_scan_time 同尺寸）：
                0 = 未探索 (never scanned)
                1 = 不确定 (eroded — 曾被扫描但可能已有目标进入)
                2 = 安全 (fresh — 曾被扫描且目标来不及抵达)
        """
        from scipy.ndimage import distance_transform_edt

        scanned = np.isfinite(self.last_scan_time)

        if not np.any(scanned):
            # 全未探索 → 全部标记为 0
            return np.zeros_like(self.last_scan_time, dtype=np.int32)

        if np.all(scanned):
            # 全区域已被扫描，无未探索威胁源 → 全部安全
            return np.full_like(self.last_scan_time, 2, dtype=np.int32)

        # 距离变换：每个已扫描网格到最近未扫描边界的距离（网格单位）
        dist_to_unscanned = distance_transform_edt(scanned.astype(np.float32))

        # 各网格的侵蚀半径（网格单位）：目标从最近一次扫描后最多能走多远
        # 注意：未扫描区域 last_scan_time = -inf，age 会很大但无关（已被 scanned 过滤）
        age = np.where(np.isfinite(self.last_scan_time),
                       np.maximum(current_time - self.last_scan_time, 0.0),
                       0.0)
        erosion_radius_cells = erosion_speed * age / self.resolution

        # 向量化安全判定：已扫描 且 到未扫描边界距离 > 侵蚀半径
        safe = scanned & (dist_to_unscanned > erosion_radius_cells)

        # 组装三值输出
        result = np.zeros_like(self.last_scan_time, dtype=np.int32)
        result[scanned & (~safe)] = 1   # 已扫描但不安全 → 不确定
        result[safe] = 2                # 安全
        return result

    def get_coverage_ratio(self, area_bounds: tuple[float, float, float, float]) -> float:
        """计算指定矩形区域内已扫描网格的占比。

        Args:
            area_bounds: (xmin, ymin, xmax, ymax) 米制坐标
        Returns:
            覆盖率 [0, 1]
        """
        xmin, ymin, xmax, ymax = area_bounds
        gx_min, gy_min = self._world_to_grid((xmin, ymin))
        gx_max, gy_max = self._world_to_grid((xmax, ymax))

        gx_min = max(0, gx_min)
        gy_min = max(0, gy_min)
        gx_max = min(self.width, gx_max + 1)
        gy_max = min(self.height, gy_max + 1)

        if gx_max <= gx_min or gy_max <= gy_min:
            return 0.0

        sub = self.last_scan_time[gy_min:gy_max, gx_min:gx_max]
        total = sub.size
        scanned = np.sum(np.isfinite(sub))
        return float(scanned) / float(total) if total > 0 else 0.0

    def _world_to_grid(self, pos: tuple[float, float]) -> tuple[int, int]:
        """世界坐标 → 网格坐标"""
        return int(pos[0] / self.resolution), int(pos[1] / self.resolution)

    def _grid_to_world(self, gx: int, gy: int) -> tuple[float, float]:
        """网格坐标 → 世界坐标（网格中心）"""
        return (gx + 0.5) * self.resolution, (gy + 0.5) * self.resolution
