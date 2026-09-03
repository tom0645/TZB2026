"""态势管理器 —— 整合三层态势数据的统一入口。

仿真层通过 inject_entity() 推送探测结果，决策系统通过查询接口读取态势。
在真实部署中，平台传感器探测结果的推送方式与仿真完全一致。
"""

import numpy as np

from situation.entity_state_layer import EntityStateLayer
from situation.coverage_grid import CoverageGrid
from situation.value_map import ValueMap
from situation.passability_grid import PassabilityGrid


class SituationManager:
    """态势管理器：三层态势的统一入口。

    持有 World 引用以查询全局配置（侵蚀速度表等）。
    决策系统和 TaskTracker 只读态势层，不直接访问仿真真值。
    """

    def __init__(self, world: "World"):  # type: ignore[name-defined]
        self.world = world

        self.scene_width = world.config.width
        self.scene_height = world.config.height
        self.resolution = world.config.resolution

        # === 三层态势 ===
        self.entities = EntityStateLayer()
        self.coverage = CoverageGrid(self.scene_width, self.scene_height, self.resolution)
        self.value_map = ValueMap(self.scene_width, self.scene_height, self.resolution)
        self.passability = PassabilityGrid(self.scene_width, self.scene_height, self.resolution)

        # === 我方平台直接索引：platform_id → PlatformEntity（供快速查找） ===
        self.platforms: dict[int, "PlatformEntity"] = {}  # type: ignore[name-defined]

        # === 初始化可通行图（从场景配置加载障碍物和道路） ===
        for obstacle in world.config.obstacles:
            self.passability.fill_obstacle_circle(obstacle.center, obstacle.radius)
        for road in world.config.roads:
            self.passability.fill_road_waypoints(road.waypoints)

        # === 初始化价值图静态先验 ===
        prior_config = world.config.value_prior
        self.value_map.set_static_prior(prior_config.prior_type, **prior_config.params)

    # === 注入接口（仿真层 / 真实传感器调用） ===

    def inject_entity(self, entity, time: float):
        """将传感器探测到的实体推入态势层，根据实体类型自动分流处理。

        - TargetEntity / PlatformEntity → 更新精确实体层（坐标、速度、状态字段）
        - CueEntity            → 注入 ValueMap 高斯热源
        """
        from entity.cue_entity import CueEntity

        if isinstance(entity, CueEntity):
            # 线索实体 → 注入价值图热源
            if entity.discovered:   # 已被发现或外部注入，直接生效
                self.value_map.inject_cue(
                    position=entity.position,
                    radius=entity.radius,
                    confidence=entity.confidence,
                    time=time,
                )
        else:
            # 普通实体（平台、目标） → 更新精确实体层
            self.entities.update_entity(
                entity.id, entity.position, entity.velocity, time,
                entity_type=entity.entity_type,
                **self._extract_extra(entity),
            )

    def register_platform(self, platform):
        """World 在 add_entity 时调用：将己方平台注册到态势层直接索引中"""
        self.platforms[platform.id] = platform

    def unregister_platform(self, platform_id: int):
        """平台移除时从直接索引中删除"""
        self.platforms.pop(platform_id, None)

    def mark_scan(self, position: tuple[float, float], sensor_range: float, time: float):
        """仿真层调用：记录传感器空间覆盖。"""
        self.coverage.mark_scanned(position, sensor_range, time)

    def _extract_extra(self, entity) -> dict:
        """从实体真值中提取决策系统关心的状态字段（entity_type 在外层已单独传入）。

        ``role`` 是人员目标的身份标签：反应规则依靠它区分 victim、
        intruder 与 suspect。若不写入态势快照，决策层只能看到
        ``entity_type == "person"``，无法正确生成救援或拦截任务。
        """
        extra = {}
        for field in ("role", "injured", "neutralized", "repaired", "rescued",
                        "debris_cleared", "received_supply", "verified",
                        "battery", "stock"):
            if hasattr(entity, field):
                val = getattr(entity, field)
                if isinstance(val, (int, float, bool, str)):
                    extra[field] = val
                elif isinstance(val, (list, dict)):
                    extra[field] = val
        return extra

    def sync_discovered_entities(self):
        """仿真专用：对已发现的目标实体，每帧同步真值状态到态势快照。

        设计假设：已发现的目标可被持续跟踪，因此态势快照应保持最新。
        真实部署中此行为由传感器持续探测自然实现，无需显式同步。
        注意：不禁用 disabled 实体跳过 —— 救援/处置后实体 disabled，
        恰需此推送将 rescued=True / neutralized=True 写入快照，否则关联任务永远无法判定完成。
        """
        for entity_id in list(self.entities.entities.keys()):
            entity = self.world.entities.get(entity_id)
            if entity is None:
                continue
            # 不跳过 disabled 实体：其最终状态（rescued/neutralized）正是 TaskTracker 判定完成的依据
            self.inject_entity(entity, time=self.world.time)

    # === 查询接口（决策系统调用） ===

    def get_entity(self, entity_id: int):
        """获取指定实体的态势认知"""
        return self.entities.get_entity(entity_id)

    def get_all_targets(self) -> list:
        """获取所有已发现目标"""
        return self.entities.get_targets()

    def get_platforms(self) -> list:
        """获取所有己方平台状态"""
        return self.entities.get_platforms()

    def get_platform_by_id(self, platform_id: int):
        """通过 ID 直接获取平台实体实例（O(1)，比遍历快）"""
        return self.platforms.get(platform_id)

    def get_entities_all(self) -> dict[int, "EntityState"]:  # type: ignore[name-defined]
        """获取所有已发现实体的态势认知"""
        return self.entities.get_all_entities()

    def get_entities_by_type(self, entity_type: str) -> list:
        """按类型筛选实体"""
        return self.entities.get_entities_by_type(entity_type)

    # === 覆盖记录层 ===

    def get_search_priority(self, current_time: float, entity_type: str) -> np.ndarray:
        """决策系统调用：按实体类型获取搜索优先级图。

        Args:
            current_time: 当前仿真时刻
            entity_type: 实体类型，用于查询侵蚀速度
        Returns:
            归一化到 [0, 1] 的搜索优先级网格，安全区域优先级为 0
        """
        return self._compute_priority(current_time, entity_type)

    def get_coverage_ratio(self, area_bounds: tuple[float, float, float, float]) -> float:
        """获取指定区域的覆盖率"""
        return self.coverage.get_coverage_ratio(area_bounds)

    # === 可通行图 ===

    def is_passable(self, pos: tuple[float, float]) -> bool:
        """决策系统/平台调用：判断可通行性"""
        return self.passability.is_passable(pos)

    def get_move_cost(self, pos: tuple[float, float]) -> float:
        """决策系统/平台调用：获取通行成本"""
        return self.passability.get_move_cost(pos)

    # === 内部计算 ===

    def _compute_priority(self, current_time: float, entity_type: str) -> np.ndarray:
        """计算指定实体类型的搜索优先级图：value × unsafe_mask"""
        speed = self.world.config.erosion_speeds.get(entity_type, 0.0)
        freshness = self.coverage.get_freshness(current_time, speed)
        value = self.value_map.evaluate(current_time)
        # 安全区域（freshness == 2）优先级为 0
        unsafe_mask = (freshness != 2).astype(np.float64)
        priority = value * unsafe_mask
        return priority
