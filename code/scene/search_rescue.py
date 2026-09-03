"""搜救场景构建 —— 荒野多人失踪异构空地协同搜救。

5 名失踪人员独立随机分布于 10km × 10km 荒野区域。
UAV 广域搜索 + 急救包投送，UGV 移动充电站 + 人员救援。
"""

import random
import math

from scene.scene_config import SceneConfig, Obstacle, ValuePriorConfig, GlobalGoal
from entity.platform_entity import PlatformEntity
from entity.target_entity import PersonTarget
from entity.capabilities import (
    SensorCapability, MedicalCapability, ChargerCapability, CargoCapability,
    RescueCapability,
)
from task.tasks import ReconTask, DiscoverTask, ArriveTask
from decision.rules import (
    PersonDiscoveredRule, LowBatteryRule,
)


def build_search_rescue_scene() -> SceneConfig:
    """构建荒野搜救场景配置"""
    width, height = 10000.0, 10000.0

    config = SceneConfig(
        name="荒野搜救",
        width=width, height=height,
        resolution=50.0, dt=1.0,
        max_duration=7200.0,  # 120 分钟

        # 侵蚀速度表：搜救场景只关注人员（几乎静止）
        erosion_speeds={"person": 2.0},

        # 价值图：全图均匀分布（不知道人员在哪）
        value_prior=ValuePriorConfig(prior_type="uniform"),

        # 障碍物：陡崖和干涸沟壑
        obstacles=[
            Obstacle(center=(3000.0, 4000.0), radius=500.0),   # 陡崖区
            Obstacle(center=(7000.0, 2000.0), radius=400.0),   # 干涸沟壑
        ],

        # 任务日程表（T=0 初始任务 + 后续人工干预）
        # 优先级体系：Guard(0) > Intercept(5) > Charge(25) > 反应EntityTask(30~60)
        #            > ArriveTask(65,硬编码搜索引导) > Discover(70) > Recon(90)
        task_schedule=[
            # === T=0: 场景基本任务 ===
            (0.0, ReconTask(
                area=(0.0, 0.0, width, height),
                required_coverage=0.90,
                priority=90,
            )),
            (0.0, DiscoverTask(
                target_entity_type="victim",
                required_count=5,
                priority=70,
            )),
            # === 硬编码搜索引导：指挥 UAV 飞向遇险人员位置（暂代未实现的搜索算法） ===
            # 平台抵达后自动完成任务释放，发现目标后反应规则生成高优先级 EntityTask
            (10.0, ArriveTask(target_pos=(2000.0, 2000.0), priority=65, required_capabilities=["sensor"])),
            (20.0, ArriveTask(target_pos=(4000.0, 4000.0), priority=65, required_capabilities=["sensor"])),
            (30.0, ArriveTask(target_pos=(6000.0, 6000.0), priority=65, required_capabilities=["sensor"])),
            (40.0, ArriveTask(target_pos=(8000.0, 2000.0), priority=65, required_capabilities=["sensor"])),
            (50.0, ArriveTask(target_pos=(8000.0, 8000.0), priority=65, required_capabilities=["sensor"])),
        ],

        # 反应规则
        reaction_rules=[
            PersonDiscoveredRule(),
            LowBatteryRule(threshold=0.2),
        ],

        # 全局目标
        global_goal=GlobalGoal(
            goal_type="rescue",
            params={"min_rescued": 4},
        ),
    )

    # === 生成时间表 ===
    schedule: list[tuple[float, object]] = []

    # 平台：T=0 生成
    # 4 架 UAV（sensor + medical），基地附近起飞
    for i in range(4):
        schedule.append((
            0.0,
            PlatformEntity(
                platform_type="uav",
                position=(500.0 + i * 300, 500.0),
                max_speed=15.0,
                max_battery=3600.0,   # 60 分钟
                capabilities=[
                    SensorCapability(range_=500.0),
                    MedicalCapability(stock=3),
                ],
            )
        ))

    # 2 辆 UGV（charger + cargo），基地出发，仅负责充电和人员运输
    for i in range(2):
        schedule.append((
            0.0,
            PlatformEntity(
                platform_type="ugv",
                position=(600.0 + i * 400, 300.0),
                max_speed=8.0,
                max_battery=10800.0,  # 180 分钟（UGV 不耗电，此值仅作参考）
                capabilities=[
                    ChargerCapability(battery_stock=6),
                    CargoCapability(capacity=5),
                    RescueCapability(),
                ],
            )
        ))

    # 失踪人员：5 人硬编码位置（与 ArriveTask 目标点一致），前 2 人受伤
    # —— 原随机生成代码已注释，待搜索算法实现后恢复 ——
    # random.seed(42)
    # for i in range(5):
    #     while True:
    #         x = random.uniform(1000, 9000)
    #         y = random.uniform(1000, 9000)
    #         in_obstacle = False
    #         for obs in config.obstacles:
    #             dist = math.sqrt((x - obs.center[0]) ** 2 + (y - obs.center[1]) ** 2)
    #             if dist < obs.radius:
    #                 in_obstacle = True
    #                 break
    #         if not in_obstacle:
    #             break
    #     survival = random.uniform(7200, 18000)
    #     schedule.append((
    #         0.0,
    #         PersonTarget(
    #             role="victim",
    #             position=(x, y),
    #             survival_time=survival,
    #             injured=(i < 2),
    #         )
    #     ))

    # 硬编码人员位置（与 ArriveTask 目标点一一对应）
    victim_positions = [
        (2000.0, 2000.0),
        (4000.0, 4000.0),
        (6000.0, 6000.0),
        (8000.0, 2000.0),
        (8000.0, 8000.0),
    ]
    for i, pos in enumerate(victim_positions):
        schedule.append((
            0.0,
            PersonTarget(
                role="victim",
                position=pos,
                survival_time=14400.0,  # 240 分钟
                injured=(i < 2),        # 前 2 人受伤
            )
        ))

    config.spawn_schedule = schedule
    return config
