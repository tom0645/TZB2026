"""线索实体 —— 代表来自固定感知节点、传感器网络或人工报告的模糊信息。

线索不参与运动更新，不直接生成任务，始终通过 ValueMap → 优先级图 → 决策系统的路径
间接影响搜索行为。

通过 discovered 字段区分两种类型：
- 外部注入（discovered=True）：生成即生效
- 物理发现（discovered=False）：需平台传感器探测后标记
"""

from entity.base_entity import BaseEntity


class CueEntity(BaseEntity):
    """线索实体：模糊信息，用于引导搜索方向。"""

    def __init__(self, position: tuple[float, float],
                 radius: float = 500.0,
                 confidence: float = 0.5,
                 source: str = "fixed_sensor",
                 target_entity_type: str = "person",
                 discovered: bool = False,
                 directional: bool = False,
                 direction: float = 0.0,
                 expire_time: float | None = None):
        """
        Args:
            position: 参考位置 (x, y)
            radius: ValueMap 热源的影响半径（米）
            confidence: 置信度 [0, 1]
            source: 来源标识 "fixed_sensor" / "manual" / "historical"
            target_entity_type: 线索指向的目标实体类型
            discovered: 初始 discovered 状态
            directional: 是否方向性线索
            direction: 指向（弧度）
            expire_time: 线索失效时刻，None 为永久有效
        """
        super().__init__(position=position)
        self.entity_type = "cue"
        self.radius = radius
        self.confidence = confidence
        self.source = source
        self.target_entity_type = target_entity_type
        self.discovered = discovered
        self.directional = directional
        self.direction = direction
        self.expire_time = expire_time

    def update_state(self, dt: float):
        """仅检查过期，不做独立的探测逻辑——discovered 标记由态势层传感器探测流程统一处理。"""
        if self.expire_time is not None and self.world is not None:
            if self.world.time >= self.expire_time:
                self.enabled = False
