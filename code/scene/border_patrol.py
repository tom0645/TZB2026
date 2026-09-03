"""边境巡检场景构建 —— 山区边境异构空地协同巡检与异常处置。

12km × 12km 山区边境段，UAV 广域巡逻 + 目标拦截，UGV 地面核查 + 充电 + 维修。
"""

import random
import math

from scene.scene_config import SceneConfig, Obstacle, Road, ValuePriorConfig, GlobalGoal
from entity.platform_entity import PlatformEntity
from entity.target_entity import PersonTarget, VehicleTarget, FacilityTarget
from entity.cue_entity import CueEntity
from entity.capabilities import (
    SensorCapability, EffectorCapability, ChargerCapability,
    MaintenanceCapability,
)
from task.tasks import ReconTask, ArriveTask
from decision.rules import (
    HostileTargetRule, FacilityAnomalyRule, LowBatteryRule,
)


def build_border_patrol_scene() -> SceneConfig:
    """构建边境巡检场景配置"""
    width, height = 12000.0, 12000.0

    config = SceneConfig(
        name="边境巡检",
        width=width, height=height,
        resolution=50.0, dt=1.0,
        max_duration=7200.0,  # 120 分钟

        # 侵蚀速度表：人员慢、车辆快 → 对车辆需持续巡逻
        erosion_speeds={"person": 2.0, "vehicle": 15.0},

        # 价值图：沿边境线 Y=0 距离衰减
        value_prior=ValuePriorConfig(
            prior_type="border_decay",
            params={"border_y": 0.0, "max_dist": 12000.0},
        ),

        # 地形：山地林区 + 巡逻道路
        obstacles=[
            Obstacle(center=(4000.0, 3000.0), radius=600.0),
            Obstacle(center=(9000.0, 5000.0), radius=500.0),
            Obstacle(center=(6000.0, 8000.0), radius=400.0),
        ],
        roads=[
            Road(waypoints=[
                (500.0, 500.0), (3000.0, 1000.0), (6000.0, 2000.0),
                (9000.0, 3000.0), (11000.0, 5000.0),
            ]),
        ],

        # 任务日程表（T=0 初始任务 + 后续人工干预）
        # 优先级体系：Guard(0) > Intercept(5) > Charge(25) > 反应EntityTask(30~60)
        #            > ArriveTask(65,硬编码搜索引导) > Discover(70) > Recon(90)
        task_schedule=[
            # === T=0: 场景基本任务 ===
            (0.0, ReconTask(
                area=(0.0, 0.0, width, 3000.0),  # 边境线附近区域
                required_coverage=0.95,
                priority=90,
            )),
            # === 硬编码搜索引导：指挥 UAV 沿边境线飞行覆盖关键区域 ===
            # intruder spawn(8000,100) T=300 | vehicle spawn(2000,200) T=600 | facility(5500,50)
            (10.0, ArriveTask(target_pos=(2000.0, 500.0), priority=65, required_capabilities=["sensor"])),
            (20.0, ArriveTask(target_pos=(5500.0, 500.0), priority=65, required_capabilities=["sensor"])),
            (30.0, ArriveTask(target_pos=(8000.0, 500.0), priority=65, required_capabilities=["sensor"])),
        ],

        # 反应规则
        reaction_rules=[
            HostileTargetRule(),
            FacilityAnomalyRule(),
            LowBatteryRule(threshold=0.2),
        ],

        # 全局目标
        global_goal=GlobalGoal(
            goal_type="border_patrol",
            params={},
        ),
    )

    # === 生成时间表 ===
    schedule: list[tuple[float, object]] = []

    # 平台
    for i in range(4):
        schedule.append((
            0.0,
            PlatformEntity(
                platform_type="uav",
                position=(500.0 + i * 300, 500.0),
                # 维持相对可疑车辆（15 m/s）的速度优势，保证 effector UAV
                # 能够进入 15m 近距处置范围，而非长期等速追逐。
                max_speed=20.0,
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
                position=(600.0 + i * 400, 300.0),
                max_speed=8.0,
                max_battery=10800.0,
                capabilities=[
                    SensorCapability(range_=200.0),
                    ChargerCapability(battery_stock=4),
                    MaintenanceCapability(stock=3),
                ],
            )
        ))

    # 越境人员（T=300s, 5min）
    schedule.append((
        300.0,
        PersonTarget(
            role="intruder",
            position=(8000.0, 100.0),  # 边境线附近
            survival_time=float("inf"),
        )
    ))

    # 可疑车辆（T=600s, 10min）
    schedule.append((
        600.0,
        VehicleTarget(
            position=(2000.0, 200.0),
            max_speed=15.0,
            route=[(2000, 200), (4000, 1500), (7000, 3000), (10000, 5000)],
        )
    ))

    # 设施异常（T=0, 围栏破损）
    schedule.append((
        0.0,
        FacilityTarget(
            position=(5500.0, 50.0),
            facility_type="fence",
        )
    ))

    # 线索：围栏勾挂衣物（T=300s, discovered=False 需传感器发现）
    schedule.append((
        300.0,
        CueEntity(
            position=(8000.0, 500.0),
            radius=500.0,
            confidence=0.7,
            source="fixed_sensor",
            target_entity_type="person",
            discovered=False,
        )
    ))

    config.spawn_schedule = schedule
    return config
