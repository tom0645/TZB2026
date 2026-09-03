"""目标实体 —— 场景中需要被搜索、跟踪、拦截、维修或救援的对象。

关键设计：目标实体在自己的 update_state() 中感知周围平台和能力，
自主修改自身状态字段。TaskTracker 通过读取这些字段判定任务完成。
"""

import math
import random

from entity.base_entity import BaseEntity


# 人员与车辆采用和空中目标一致的单机处置门槛：
# effector UAV 进入近距范围并持续锁定后，目标才会被标记为已处置。
EFFECTOR_NEUTRALIZE_RANGE_M = 15.0
EFFECTOR_LOCK_DURATION_S = 5.0


class TargetEntity(BaseEntity):
    """目标实体基类"""

    def __init__(self, entity_type: str, position: tuple[float, float] = (0.0, 0.0)):
        super().__init__(position=position)
        self.entity_type = entity_type
        self.discovered: bool = False        # 是否已被态势层感知
        self.neutralized: bool = False       # 是否已被处置/拦截
        # 人员与车辆共用的近距 effector 连续锁定计时；离开处置距离后归零。
        self._effector_lock_timer: float = 0.0

    def _try_neutralize_by_effector(self, dt: float) -> bool:
        """由目标实体自行判定是否被 effector UAV 处置。

        该方法只由人员和车辆在 ``update_state`` 中调用：决策层负责把
        InterceptTask 分给 UAV，目标实体负责感知近距平台、消耗能力并写入
        自身 ``neutralized`` 真值，从而保持任务、实体和裁判层的职责边界。
        """
        if self.world is None or self.neutralized:
            return self.neutralized

        from entity.platform_entity import PlatformEntity

        nearby = self.world.get_entities_in_range(
            self.position, EFFECTOR_NEUTRALIZE_RANGE_M,
        )
        effectors = [
            entity
            for entity in nearby
            if isinstance(entity, PlatformEntity)
            and entity.platform_type == "uav"
            and entity.has_available_capability("effector")
            and entity.distance_to(self) < EFFECTOR_NEUTRALIZE_RANGE_M
        ]

        if not effectors:
            # 锁定不连续时不能累计，避免 UAV 掠过目标即完成处置。
            self._effector_lock_timer = 0.0
            return False

        self._effector_lock_timer += dt
        if self._effector_lock_timer < EFFECTOR_LOCK_DURATION_S:
            return False

        # 处置生效时只消耗一次能力；之后目标不再移动，也不会重复扣减库存。
        effector = effectors[0]
        capability = effector.get_capability("effector")
        if capability is not None:
            capability.on_use()
        self.neutralized = True
        return True


class PersonTarget(TargetEntity):
    """人员目标：用于表示越境人员、失踪人员或可疑人员。

    行为：
    - victim: 静止，消耗 survival_time，感知医疗投送和救援
    - intruder: 从边境向纵深随机游走，感知跟踪时转向
    - suspect: 沿预设路径或随机游走，感知跟踪时加速或转向
    """

    def __init__(self, role: str, position: tuple[float, float] = (0.0, 0.0),
                 survival_time: float = 7200.0, injured: bool = False):
        """
        Args:
            role: "victim" / "intruder" / "suspect"
            position: 初始位置
            survival_time: 剩余可坚持时间（秒，仅 victim 有效）
            injured: 是否受伤（victim 专用）
        """
        super().__init__(entity_type="person", position=position)
        self.role = role
        self.survival_time: float = survival_time
        self.injured: bool = injured
        self.received_supply: bool = False
        self.rescued: bool = False

        # intruder/suspect 行为参数
        self._wander_counter: float = 0.0
        self._wander_interval: float = random.uniform(30.0, 120.0)
        self._wander_target: tuple[float, float] | None = None

    def update_state(self, dt: float):
        if self.world is None or not self.enabled:
            return

        if self.role == "victim":
            self._update_victim(dt)
        elif self.role in ("intruder", "suspect"):
            if self.neutralized:
                return
            self._update_hostile(dt)

    def update_movement(self, dt: float):
        if self.world is None or not self.enabled:
            return
        if self.role in ("intruder", "suspect") and not self.neutralized:
            self._move_wander(dt)

    def _update_victim(self, dt: float):
        """失踪人员状态更新：生存时间消耗、感知医疗投送和救援"""
        # 生存时间消耗（受伤者 2 倍速）
        rate = 2.0 if self.injured else 1.0
        self.survival_time -= dt * rate
        if self.survival_time <= 0:
            self.enabled = False
            return

        # 感知周围平台
        nearby = self.world.get_entities_in_range(self.position, 2.0)

        for entity in nearby:
            from entity.platform_entity import PlatformEntity
            if not isinstance(entity, PlatformEntity):
                continue

            # 医疗投送检测：有携带 medical 能力的平台在 2m 内
            if self.injured and not self.received_supply:
                med = entity.get_capability("medical")
                if med is not None and med.is_available():
                    med.on_use()   # stock--
                    self.injured = False
                    self.survival_time += 7200.0  # 额外延长 7200 秒（2小时）
                    self.received_supply = True

            # 救援检测：有携带 rescue 能力的 UGV 在 2m 内
            if not self.rescued and entity.platform_type == "ugv":
                rescue = entity.get_capability("rescue")
                if rescue is not None and rescue.is_available():
                    self.rescued = True
                    self.enabled = False

    def _update_hostile(self, dt: float):
        """越境人员/可疑人员状态更新"""
        # 先检查近距 effector 处置；成功后本帧不再执行规避行为。
        if self._try_neutralize_by_effector(dt):
            return

        # 感知周围平台
        nearby = self.world.get_entities_in_range(self.position, 500.0)
        tracked = False
        for entity in nearby:
            from entity.platform_entity import PlatformEntity
            if isinstance(entity, PlatformEntity) and entity.platform_type == "uav":
                tracked = True
                break

        # 被跟踪时更频繁改变方向
        if tracked:
            self._wander_interval = random.uniform(10.0, 30.0)

    def _move_wander(self, dt: float):
        """随机游走移动"""
        self._wander_counter += dt
        if self._wander_target is None or self._wander_counter >= self._wander_interval:
            self._wander_counter = 0.0
            self._wander_interval = random.uniform(30.0, 120.0)
            # 生成随机目标点
            angle = random.uniform(0, 2 * math.pi)
            dist = random.uniform(100.0, 500.0)
            self._wander_target = (
                self.position[0] + math.cos(angle) * dist,
                self.position[1] + math.sin(angle) * dist,
            )

        if self._wander_target is None:
            return

        speed = 1.5 if self.role == "intruder" else 1.0
        dx = self._wander_target[0] - self.position[0]
        dy = self._wander_target[1] - self.position[1]
        dist = math.sqrt(dx * dx + dy * dy)
        if dist < 1.0:
            self._wander_target = None
            return

        step = min(speed * dt, dist)
        self.position = (
            self.position[0] + dx / dist * step,
            self.position[1] + dy / dist * step,
        )


class VehicleTarget(TargetEntity):
    """载具目标：用于边境巡检场景中的可疑车辆。"""

    def __init__(self, position: tuple[float, float] = (0.0, 0.0),
                 max_speed: float = 15.0, route: list[tuple[float, float]] | None = None):
        super().__init__(entity_type="vehicle", position=position)
        self.max_speed: float = max_speed
        self.route: list[tuple[float, float]] = route or []
        self.current_waypoint_idx: int = 0
        self._current_speed: float = max_speed * 0.6  # 默认巡航速度

    def update_state(self, dt: float):
        if self.world is None or not self.enabled:
            return

        # 车辆由自身确认近距连续锁定后写入 neutralized，
        # 不能由 DecisionSystem 或 PlatformEntity 跨层直接修改该真值。
        if self.neutralized or self._try_neutralize_by_effector(dt):
            return

        # 感知被跟踪时加速
        nearby = self.world.get_entities_in_range(self.position, 500.0)
        tracked = False
        for entity in nearby:
            from entity.platform_entity import PlatformEntity
            if isinstance(entity, PlatformEntity) and entity.platform_type == "uav":
                tracked = True
                break
        if tracked:
            self._current_speed = min(self._current_speed + 1.0, self.max_speed)
        else:
            self._current_speed = max(self._current_speed - 0.5, self.max_speed * 0.6)

    def update_movement(self, dt: float):
        # 已处置车辆停止沿道路行驶，保留实体以供态势和评估读取 neutralized。
        if self.neutralized:
            return
        if not self.route or self.current_waypoint_idx >= len(self.route):
            return
        target = self.route[self.current_waypoint_idx]
        dx = target[0] - self.position[0]
        dy = target[1] - self.position[1]
        dist = math.sqrt(dx * dx + dy * dy)
        if dist < 5.0:
            self.current_waypoint_idx = (self.current_waypoint_idx + 1) % len(self.route)
            return
        step = min(self._current_speed * dt, dist)
        self.position = (
            self.position[0] + dx / dist * step,
            self.position[1] + dy / dist * step,
        )


class AerialTarget(TargetEntity):
    """空中目标：区域封控场景中的非合作无人机（黑飞）。

    处置后坠落为地面残骸，需平台携带清理能力移除以确保机场运行安全。
    支持两种处置路径：
    1. 单机捕获：effector UAV 进入 15m 且持续锁定 ≥ 5s
    2. 多机合围：≥ 3 架 UAV 从不同方向（方位角差异 ≥ 60°）持续压制 ≥ 10s
    """

    def __init__(self, position: tuple[float, float] = (0.0, 0.0),
                 altitude: float = 100.0, intent_point: tuple[float, float] = (0.0, 0.0),
                 max_speed: float = 18.0):
        super().__init__(entity_type="aerial", position=position)
        self.altitude: float = altitude
        self.intent_point: tuple[float, float] = intent_point
        self.max_speed: float = max_speed
        self.debris_cleared: bool = False

        # 处置检测状态
        self._effector_lock_timer: float = 0.0   # effector UAV 锁定累计时间
        self._encircle_timer: float = 0.0         # 合围累计时间

    def update_state(self, dt: float):
        if self.world is None or not self.enabled:
            return

        if self.neutralized:
            self._update_debris(dt)
            return

        # 感知周围平台
        nearby = self.world.get_entities_in_range(self.position, 500.0)
        from entity.platform_entity import PlatformEntity
        uavs = [e for e in nearby if isinstance(e, PlatformEntity) and e.platform_type == "uav"]

        # 处置检测——方式一（单机捕获）
        nearby_uavs_effector = [u for u in uavs
                                if u.has_available_capability("effector")
                                and u.distance_to(self) < 15.0]
        if nearby_uavs_effector:
            self._effector_lock_timer += dt
            if self._effector_lock_timer >= 5.0:
                effector = nearby_uavs_effector[0]
                cap = effector.get_capability("effector")
                if cap is not None:
                    cap.on_use()
                self.neutralized = True
                return
        else:
            self._effector_lock_timer = 0.0

        # 处置检测——方式二（多机合围迫降）
        if len(uavs) >= 3:
            # 计算各 UAV 相对自身的方位角
            bearings = []
            for u in uavs:
                dx = u.position[0] - self.position[0]
                dy = u.position[1] - self.position[1]
                if dx == 0 and dy == 0:
                    continue
                bearing = math.atan2(dy, dx)
                bearings.append(bearing)
            if len(bearings) >= 3:
                # 检查是否有至少两个方向角差 ≥ 60°
                bearings.sort()
                max_gap = 0
                for i in range(len(bearings)):
                    gap = (bearings[(i + 1) % len(bearings)] - bearings[i]) % (2 * math.pi)
                    max_gap = max(max_gap, gap)
                if (2 * math.pi - max_gap) >= math.radians(60):
                    self._encircle_timer += dt
                    if self._encircle_timer >= 10.0:
                        self.neutralized = True
                        return
                else:
                    self._encircle_timer = 0.0
        else:
            self._encircle_timer = 0.0

    def _update_debris(self, dt: float):
        """neutralized 后：坠落地面，感知残骸清理"""
        self.altitude = 0.0  # 坠落
        if self.debris_cleared:
            self.enabled = False
            return

        nearby = self.world.get_entities_in_range(self.position, 10.0)
        from entity.platform_entity import PlatformEntity
        for entity in nearby:
            if isinstance(entity, PlatformEntity) and entity.platform_type == "ugv":
                cap = entity.get_capability("debris_clear")
                if cap is not None and cap.is_available():
                    # 简化：检测到直接清理（TODO: 实现持续停留计时）
                    self.debris_cleared = True
                    self.enabled = False
                    break

    def update_movement(self, dt: float):
        if self.neutralized:
            return  # 坠落地面后不再移动
        if self.world is None:
            return

        # 向 intent_point 飞行
        dx = self.intent_point[0] - self.position[0]
        dy = self.intent_point[1] - self.position[1]
        dist = math.sqrt(dx * dx + dy * dy)
        if dist < 10.0:
            return

        # 被跟踪时加速
        nearby = self.world.get_entities_in_range(self.position, 500.0)
        from entity.platform_entity import PlatformEntity
        tracked = any(isinstance(e, PlatformEntity) and e.platform_type == "uav"
                      for e in nearby)
        speed = self.max_speed if tracked else self.max_speed * 0.7
        step = min(speed * dt, dist)
        self.position = (
            self.position[0] + dx / dist * step,
            self.position[1] + dy / dist * step,
        )


class FacilityTarget(TargetEntity):
    """设施异常目标：用于表示边境围栏破损、通信节点失效等固定异常点。"""

    def __init__(self, position: tuple[float, float] = (0.0, 0.0),
                 facility_type: str = "fence"):
        super().__init__(entity_type="facility", position=position)
        self.facility_type: str = facility_type    # "fence" / "camera" / "comm_node"
        self.repaired: bool = False
        self.verified: bool = False
        self._repair_timer: float = 0.0            # 维修累计时间

    def update_state(self, dt: float):
        if self.world is None or not self.enabled:
            return
        if self.repaired:
            return

        # 感知周围平台
        nearby = self.world.get_entities_in_range(self.position, 5.0)
        from entity.platform_entity import PlatformEntity

        for entity in nearby:
            if not isinstance(entity, PlatformEntity):
                continue

            # 维修检测：有携带 maintenance 能力的平台在 5m 内
            cap = entity.get_capability("maintenance")
            if cap is not None and cap.is_available():
                self._repair_timer += dt
                if self._repair_timer >= 60.0:
                    cap.on_use()
                    self.repaired = True
                    break

            # 核查检测：有携带 sensor 能力的平台在 5m 内停留 ≥ 10s
            sensor = entity.get_capability("sensor")
            if sensor is not None:
                self.verified = True
