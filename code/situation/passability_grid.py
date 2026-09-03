"""可通行图 —— 静态地形数据，供 UGV 路径规划使用。UAV 忽略此图（飞行无视地形障碍）。"""

import numpy as np


class PassabilityGrid:
    """静态可通行图：标记地形是否可通行"""

    GRID_PASSABLE = 0       # 可通过
    GRID_OBSTACLE = 1       # 障碍物（陡崖、水体、建筑等）
    GRID_ROAD = 2           # 道路（通行成本最低）

    def __init__(self, scene_width: float, scene_height: float, resolution: float = 50.0):
        self.resolution = resolution
        self.width = int(scene_width / resolution)
        self.height = int(scene_height / resolution)
        # 默认全可通行
        self.grid: np.ndarray = np.zeros((self.height, self.width), dtype=np.int32)

    def fill_obstacle_circle(self, center: tuple[float, float], radius: float):
        """用圆形障碍物填充可通行图"""
        cx, cy = self._world_to_grid(center)
        radius_grid = int(radius / self.resolution)
        for dy in range(-radius_grid, radius_grid + 1):
            for dx in range(-radius_grid, radius_grid + 1):
                if dx * dx + dy * dy <= radius_grid * radius_grid:
                    gx, gy = cx + dx, cy + dy
                    if 0 <= gx < self.width and 0 <= gy < self.height:
                        self.grid[gy, gx] = self.GRID_OBSTACLE

    def fill_road_waypoints(self, waypoints: list[tuple[float, float]], width: float = 10.0):
        """沿航点序列标记道路"""
        if len(waypoints) < 2:
            return
        half_width = int(width / self.resolution) + 1
        for i in range(len(waypoints) - 1):
            p1 = waypoints[i]
            p2 = waypoints[i + 1]
            gx1, gy1 = self._world_to_grid(p1)
            gx2, gy2 = self._world_to_grid(p2)
            # 简化的线段栅格化
            for gx in range(min(gx1, gx2) - half_width, max(gx1, gx2) + half_width + 1):
                for gy in range(min(gy1, gy2) - half_width, max(gy1, gy2) + half_width + 1):
                    if 0 <= gx < self.width and 0 <= gy < self.height:
                        if self.grid[gy, gx] != self.GRID_OBSTACLE:
                            self.grid[gy, gx] = self.GRID_ROAD

    def is_passable(self, pos: tuple[float, float]) -> bool:
        """判断指定世界坐标是否可通行"""
        gx, gy = self._world_to_grid(pos)
        if not (0 <= gx < self.width and 0 <= gy < self.height):
            return False
        return self.grid[gy, gx] != self.GRID_OBSTACLE

    def get_move_cost(self, pos: tuple[float, float]) -> float:
        """获取通行成本。道路成本最低，普通地形中等，障碍物不可通行。

        UAV 始终返回 1.0（忽略地形）。
        """
        gx, gy = self._world_to_grid(pos)
        if not (0 <= gx < self.width and 0 <= gy < self.height):
            return float('inf')
        if self.grid[gy, gx] == self.GRID_ROAD:
            return 1.0
        elif self.grid[gy, gx] == self.GRID_PASSABLE:
            return 3.0
        else:
            return float('inf')

    def _world_to_grid(self, pos: tuple[float, float]) -> tuple[int, int]:
        """世界坐标 → 网格坐标"""
        return int(pos[0] / self.resolution), int(pos[1] / self.resolution)
