"""场景配置数据类 —— 定义场景参数、实体生成时间表、决策配置、全局目标等。"""

from dataclasses import dataclass, field
from typing import Any

from decision.rules import ReactionRule
from entity.base_entity import BaseEntity
from task.tasks import Task


@dataclass
class Obstacle:
    """障碍物定义"""
    center: tuple[float, float]      # 中心坐标 (x, y)
    radius: float                     # 障碍物半径（米）


@dataclass
class Road:
    """道路定义"""
    waypoints: list[tuple[float, float]]  # 道路航点序列


@dataclass
class ValuePriorConfig:
    """价值图静态先验配置"""
    prior_type: str = "uniform"       # "uniform" / "border_decay" / "perimeter_decay"
    params: dict = field(default_factory=dict)  # 各类型所需参数


@dataclass
class GlobalGoal:
    """全局目标（效能评估判定依据）"""
    goal_type: str = ""               # 目标类型标识
    params: dict = field(default_factory=dict)  # 目标参数


@dataclass
class SceneConfig:
    """场景定义，包含 World 初始化所需的一切参数。

    构建场景时直接实例化实体、配置参数，不需要模板或工厂方法。
    """

    # === 世界参数 ===
    name: str = ""                              # 场景名称
    width: float = 10000.0                      # 区域宽度（米）
    height: float = 10000.0                     # 区域高度（米）
    resolution: float = 50.0                    # 网格分辨率（米）
    dt: float = 1.0                             # 仿真步长（秒）
    max_duration: float = 7200.0                # 最大仿真时间（秒）

    # === 侵蚀速度表：实体类型 → 最大速度(m/s) ===
    # 决策系统按实体类型分别查询新鲜度/优先级图
    erosion_speeds: dict[str, float] = field(default_factory=dict)

    # === 静态先验配置 ===
    value_prior: ValuePriorConfig = field(default_factory=ValuePriorConfig)

    # === 可通行图数据 ===
    obstacles: list[Obstacle] = field(default_factory=list)
    roads: list[Road] = field(default_factory=list)

    # === 生成时间表：(时刻(秒), 实体) 列表 ===
    # 实体在创建时不持有 world 引用，也不分配 ID
    # World.tick() 按时刻将实体加入世界时才赋值 ID 并注入 world 引用
    spawn_schedule: list[tuple[float, BaseEntity]] = field(default_factory=list)

    # === 决策配置 ===
    reaction_rules: list[ReactionRule] = field(default_factory=list)

    # === 任务日程表：(时刻(秒), Task) 列表 ===
    # 与 spawn_schedule 模式一致，T=0 即初始任务，后续时刻为模拟人工干预
    # World.tick() 在对应时刻自动注入 TaskTracker
    task_schedule: list[tuple[float, Task]] = field(default_factory=list)

    # === 全局目标（效能评估用） ===
    global_goal: GlobalGoal | None = None
