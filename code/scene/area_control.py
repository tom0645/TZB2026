"""区域封控场景构建 —— 机场周边重点区域反无人机协同防控。

6km × 6km 机场周边区域，外围预警区 → 围界管控区 → 核心禁入区三层防护。
UAV 搜索 + 跟踪 + 合围 + 处置，UGV 围界巡逻 + 残骸清理。
"""

import random
import math

from scene.scene_config import SceneConfig, Obstacle, Road, ValuePriorConfig, GlobalGoal
from entity.platform_entity import PlatformEntity
from entity.target_entity import AerialTarget
from entity.capabilities import (
    SensorCapability, EffectorCapability, ChargerCapability,
    DebrisClearCapability,
)
from task.tasks import ReconTask, GuardTask, ArriveTask
from decision.rules import (
    HostileTargetRule, LowBatteryRule, LandingSiteRule,
)


def build_area_control_scene() -> SceneConfig:
    """构建区域封控场景配置"""
    width, height = 6000.0, 6000.0
    center = (width / 2, height / 2)  # 核心区中心

    config = SceneConfig(
        name="区域封控",
        width=width, height=height,
        resolution=50.0, dt=1.0,
        max_duration=5400.0,  # 90 分钟

        # 侵蚀速度表：黑飞最快
        erosion_speeds={"aerial": 18.0},

        # 价值图：外围高价值、中心低价值
        value_prior=ValuePriorConfig(
            prior_type="perimeter_decay",
            params={
                "center_x": center[0],
                "center_y": center[1],
                "max_radius": 3000.0,
            },
        ),

        # 障碍物：机场围界、建筑
        obstacles=[
            Obstacle(center=(2800.0, 2800.0), radius=200.0),  # 建筑
            Obstacle(center=(3200.0, 3200.0), radius=200.0),
        ],
        roads=[
            Road(waypoints=[
                (500.0, 500.0), (3000.0, 500.0), (5500.0, 500.0),
                (5500.0, 3000.0), (5500.0, 5500.0),
                (3000.0, 5500.0), (500.0, 5500.0), (500.0, 3000.0),
                (500.0, 500.0),  # 围界道路
            ]),
        ],

        # 任务日程表（T=0 初始任务 + 后续人工干预）
        # 优先级体系：Guard(0) > Intercept(5) > Charge(25) > 反应EntityTask(30~60)
        #            > ArriveTask(65,硬编码搜索引导) > Discover(70) > Recon(90)
        task_schedule=[
            # === T=0: 场景基本任务 ===
            (0.0, ReconTask(
                area=(0.0, 0.0, width, height),  # 全区域搜索
                required_coverage=0.90,
                priority=90,
            )),
            (0.0, GuardTask(
                area=(2500.0, 2500.0, 3500.0, 3500.0),  # 核心禁入区 1km²
                hostile_entity_types=["aerial"],
                max_intrusions=0,
                priority=0,
            )),
            # === 硬编码搜索引导：指挥 UAV 飞向四周边界拦截点 ===
            # 第一波 aerial spawn(500,3000) T=120 → center(3000,3000)
            # 第二波 ~T=900 从各方向入侵
            (10.0, ArriveTask(target_pos=(500.0, 3000.0), priority=65, required_capabilities=["sensor"])),
            (20.0, ArriveTask(target_pos=(3000.0, 500.0), priority=65, required_capabilities=["sensor"])),
            (30.0, ArriveTask(target_pos=(5500.0, 3000.0), priority=65, required_capabilities=["sensor"])),
            (40.0, ArriveTask(target_pos=(3000.0, 5500.0), priority=65, required_capabilities=["sensor"])),
        ],

        # 反应规则
        reaction_rules=[
            HostileTargetRule(),
            LowBatteryRule(threshold=0.2),
            LandingSiteRule(),
        ],

        # 全局目标
        global_goal=GlobalGoal(
            goal_type="area_control",
            params={"max_intrusions": 0},
        ),
    )

    # === 生成时间表 ===
    schedule: list[tuple[float, object]] = []

    # 平台
    for i in range(5):
        schedule.append((
            0.0,
            PlatformEntity(
                platform_type="uav",
                position=(500.0 + i * 250, 500.0),
                max_speed=15.0,
                max_battery=3600.0,
                capabilities=[
                    SensorCapability(range_=500.0),
                    EffectorCapability(charges=3),
                ],
            )
        ))
    for i in range(2):
        schedule.append((
            0.0,
            PlatformEntity(
                platform_type="ugv",
                position=(400.0 + i * 300, 200.0),
                max_speed=8.0,
                max_battery=10800.0,
                capabilities=[
                    SensorCapability(range_=200.0),
                    ChargerCapability(battery_stock=4),
                    DebrisClearCapability(),
                ],
            )
        ))

    # 第一波：1 架黑飞（T=120s, 2min），从外围进入
    schedule.append((
        120.0,
        AerialTarget(
            position=(500.0, 3000.0),
            altitude=100.0,
            intent_point=(3000.0, 3000.0),  # 朝核心区飞行
            max_speed=18.0,
        )
    ))

    # 第二波：3~5 架黑飞（T=900s, 15min），从不同方向进入
    random.seed(42)
    second_wave_count = random.randint(3, 5)
    entry_sides = ["north", "south", "east", "west"]
    random.shuffle(entry_sides)
    for i in range(second_wave_count):
        side = entry_sides[i % 4]
        if side == "north":
            spawn_pos = (random.uniform(1000, 5000), 100.0)
        elif side == "south":
            spawn_pos = (random.uniform(1000, 5000), 5900.0)
        elif side == "east":
            spawn_pos = (5900.0, random.uniform(1000, 5000))
        else:
            spawn_pos = (100.0, random.uniform(1000, 5000))

        schedule.append((
            900.0,  # T=15min
            AerialTarget(
                position=spawn_pos,
                altitude=random.uniform(50, 150),
                intent_point=(3000.0, 3000.0),
                max_speed=random.uniform(12.0, 18.0),
            )
        ))

    config.spawn_schedule = schedule
    return config
