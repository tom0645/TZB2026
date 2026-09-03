"""实体基类 —— 所有实体的公共基类，定义基本属性和接口。"""

import math


class BaseEntity:
    """实体基类。

    实体在创建时不持有 world 和 id，由 World.add_entity() 注入。
    每帧经历三个步骤：
        1. update_control(dt) — 控制决策（所有后端统一）
        2. update_movement(dt) — 运动执行（仅 Python 后端）
        3. update_state(dt)   — 状态逻辑（所有后端统一）
    """

    def __init__(self, position: tuple[float, float] = (0.0, 0.0)):
        # World.add_entity() 注入的字段
        self.id: int = -1
        self.world: "World | None" = None  # type: ignore[name-defined]

        # 基本状态
        self.position: tuple[float, float] = position
        self.velocity: tuple[float, float] = (0.0, 0.0)
        self.heading: float = 0.0
        self.enabled: bool = True

    # === 每帧接口 ===

    def update_control(self, dt: float):
        """控制决策。所有后端统一调用。

        根据 current_task 和态势决定意图：目标坐标、期望速度、悬停/降落等。
        在 Python 后端，update_movement 读取这些意图执行位移；
        在 UE / 实机后端，Bridge 读取这些意图下发指令。
        """
        pass

    def update_movement(self, dt: float):
        """运动执行。仅在 Python 后端调用。

        读取 update_control 设定的目标坐标、期望速度等，计算实际位移。
        UE / 实机后端下位置由 Bridge 同步，此方法为空。
        """
        pass

    def update_state(self, dt: float):
        """状态逻辑。所有后端统一调用。

        感知周围实体、修改自身状态字段、调用传感器探测等。
        """
        pass

    # === 工具方法 ===

    def get_position(self) -> tuple[float, float]:
        """返回当前位置"""
        return self.position

    def distance_to(self, other: "BaseEntity") -> float:
        """计算到另一个实体的欧氏距离"""
        dx = self.position[0] - other.position[0]
        dy = self.position[1] - other.position[1]
        return math.sqrt(dx * dx + dy * dy)

    def distance_to_pos(self, pos: tuple[float, float]) -> float:
        """计算到指定坐标的欧氏距离"""
        dx = self.position[0] - pos[0]
        dy = self.position[1] - pos[1]
        return math.sqrt(dx * dx + dy * dy)
