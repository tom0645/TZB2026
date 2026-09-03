"""精确实体层 —— 维护所有已被态势层感知实体的状态副本（EntityState）。

与仿真器真值严格分离：只接收传感器探测结果，不驱动任何实体，不修改实体状态。
"""

from dataclasses import dataclass, field


@dataclass
class EntityState:
    """态势层中单个实体的认知副本。"""

    entity_id: int                              # 全局唯一标识
    entity_type: str                            # "uav" / "ugv" / "victim" / "intruder" / "aerial" / "vehicle" / "facility" / ...
    position: tuple[float, float] = (0.0, 0.0)  # 最新已知位置 (x, y)
    velocity: tuple[float, float] = (0.0, 0.0)  # 最新已知速度 (vx, vy)
    timestamp: float = 0.0                      # 该状态对应的仿真时刻
    discovered: bool = False                    # 是否已被态势层首次感知

    # 类型特定的状态字段
    extra: dict = field(default_factory=dict)   # 例: {"injured": True, "rescued": False, "battery": 0.8, ...}


class EntityStateLayer:
    """精确实体层：维护已发现实体的状态副本"""

    def __init__(self):
        self.entities: dict[int, EntityState] = {}   # entity_id → EntityState

    def update_entity(self, entity_id: int, pos: tuple[float, float],
                      vel: tuple[float, float], time: float, **extra):
        """由仿真层每帧调用，更新实体状态。

        首次调用时自动设置 discovered = True（如果之前不存在）。
        已标记 rescued / neutralized 且 enabled=False 的实体不再更新。
        """
        if entity_id in self.entities:
            state = self.entities[entity_id]
            # 已 rescue 或 neutralized 且已 disabled 的实体不再更新位置
            if state.extra.get("rescued") or state.extra.get("neutralized"):
                if not self._is_enabled_in_world(entity_id):
                    return
        else:
            state = EntityState(
                entity_id=entity_id,
                entity_type=extra.pop("entity_type", "unknown"),
            )
            self.entities[entity_id] = state

        state.position = pos
        state.velocity = vel
        state.timestamp = time
        if not state.discovered:
            state.discovered = True
        state.extra.update(extra)

    def _is_enabled_in_world(self, entity_id: int) -> bool:
        """辅助：检查实体在 World 中是否仍 enabled。需要 world 引用时通过外部注入。"""
        return True  # 默认假设 enabled，由外部调用方控制

    def get_entity(self, entity_id: int) -> EntityState | None:
        """获取指定实体的态势认知"""
        return self.entities.get(entity_id)

    def get_all_entities(self) -> dict[int, EntityState]:
        """获取所有已发现实体的态势认知"""
        return self.entities

    def get_entities_by_type(self, entity_type: str) -> list[EntityState]:
        """按类型筛选实体"""
        return [e for e in self.entities.values() if e.entity_type == entity_type]

    def get_platforms(self) -> list[EntityState]:
        """获取所有己方平台（uav / ugv）的状态"""
        return [e for e in self.entities.values()
                if e.entity_type in ("uav", "ugv")]

    def get_targets(self) -> list[EntityState]:
        """获取所有已发现目标实体的状态"""
        return [e for e in self.entities.values()
                if e.entity_type not in ("uav", "ugv", "cue")]

    def forget_entity(self, entity_id: int):
        """从态势层移除实体认知（仅仿真测试用）。"""
        self.entities.pop(entity_id, None)
