"""平台实体 —— 己方可控的执行单元（UAV 多旋翼 / UGV 无人车）。

平台通过挂载不同能力（Capability）区分角色。
每帧经历三步：
    1. update_control(dt) — 根据 current_task 决定意图（target_position, desired_speed）
    2. update_movement(dt) — 根据意图计算位移（仅 Python 后端）
    3. update_state(dt)   — 传感器探测 + 电量消耗 + 状态变更
"""

import math

from entity.base_entity import BaseEntity
from entity.capabilities import Capability


class PlatformEntity(BaseEntity):
    """己方可控平台实体。"""

    def __init__(self, platform_type: str, position: tuple[float, float] = (0.0, 0.0),
                 max_speed: float = 15.0, max_battery: float = 3600.0,
                 capabilities: list[Capability] | None = None):
        """
        Args:
            platform_type: "uav" 或 "ugv"
            position: 初始位置 (x, y)
            max_speed: 最大速度（m/s）
            max_battery: 最大电量（秒续航）
            capabilities: 搭载的能力组件列表
        """
        super().__init__(position=position)
        self.entity_type = platform_type
        self.platform_type = platform_type

        # 运动属性
        self.can_fly: bool = (platform_type == "uav")
        self.max_speed: float = max_speed

        # 电量属性（battery 和 dt 单位均为秒）
        self.battery: float = max_battery
        self.max_battery: float = max_battery

        # 能力组件
        self.capabilities: list[Capability] = capabilities or []

        # 任务相关
        self.current_task = None         # 当前被分配的任务，由 TaskTracker 统一同步

        # 充电/停靠相关（UAV 专用）
        self.landed_on: int | None = None   # 当前停靠的平台 ID
        self.charge_timer: float = 0.0      # 换电倒计时（秒）

        # === 控制意图字段 ===
        self.target_position: tuple[float, float] | None = None
        self.desired_speed: float = 0.0

    # === 能力管理 ===

    def get_capability(self, type_: str) -> Capability | None:
        """获取指定类型的能力组件"""
        for cap in self.capabilities:
            if cap.type == type_:
                return cap
        return None

    def has_capability(self, type_: str) -> bool:
        """检查是否拥有某类能力"""
        return self.get_capability(type_) is not None

    def has_available_capability(self, type_: str) -> bool:
        """检查某类能力是否可用（库存>0 且 电量足够）"""
        cap = self.get_capability(type_)
        if cap is None:
            return False
        return cap.is_available() and self.battery > 0

    # === 控制与运动 ===

    def set_target(self, pos: tuple[float, float] | None, speed: float = 0.0):
        """设置移动目标。仅在目标变化时发送网络指令，避免每帧全量广播。

        Python 后端：仅修改字段值，无网络开销。
        UE / 实机后端：目标变化时立即调用 Bridge 下发指令。
        """
        changed = (self.target_position != pos or self.desired_speed != speed)
        self.target_position = pos
        self.desired_speed = speed

        if changed and self.world is not None and self.world._bridge is not None:
            if pos is not None:
                self.world._bridge.send_move_command(self.id, pos, speed)
            else:
                self.world._bridge.send_stop_command(self.id)

    def update_control(self, dt: float):
        """控制决策：根据 current_task 决定意图（所有后端统一调用）。

        通过 set_target() 设定目标坐标和速度。
        Python 后端由 update_movement 读 target_position 计算位移；
        UE / 实机后端由 set_target 内部直接下发网络指令。
        """
        if self.landed_on is not None:
            # 停靠/充电中，不移动
            self.set_target(None)
            return

        task = self.current_task
        if task is None:
            self.set_target(None)
            return

        # 根据任务类型决定目标位置
        from task.tasks import (ReconTask, MedicalDeliveryTask, RescueTask,
                                InterceptTask, RepairTask, ChargeTask,
                                ArriveTask, OccupyTask, DiscoverTask, ClearTask)

        if isinstance(task, (ReconTask, DiscoverTask)):
            # 侦察/搜索：按搜索优先级图选择航点
            wp = self._next_scan_waypoint(task)
            if wp is not None:
                self.set_target(wp, self.max_speed)

        elif isinstance(task, (MedicalDeliveryTask, RescueTask,
                                 InterceptTask, RepairTask)):
            # 实体类任务 → 以目标坐标为 target_position
            target = self.world.situation.get_entity(task.target_entity_id)
            if target is not None:
                self.set_target(target.position, self.max_speed)

        elif isinstance(task, ClearTask):
            # 残骸清理：以目标坐标为 target_position
            target = self.world.situation.get_entity(task.target_entity_id)
            if target is not None:
                self.set_target(target.position, self.max_speed)

        elif isinstance(task, ChargeTask):
            # 充电任务
            if self.platform_type == "uav" and task.target_entity_id == self.id:
                # 我是需要充电的 UAV，飞向充电平台
                charger_id = task.charger_platform_id
                if charger_id is not None:
                    charger = self.world.situation.get_platform_by_id(charger_id)
                    if charger is not None:
                        self.set_target(charger.get_position(), self.max_speed)
                        # 抵达充电平台附近触发降落
                        if self.distance_to(charger) < 5.0:
                            self.landed_on = charger.id
                            self.charge_timer = 300.0  # 换电耗时 300 秒（5分钟）
            elif task.charger_platform_id == self.id:
                # 我是充电 UGV：不需要移动（UAV 来找我）
                self.set_target(None)

        elif isinstance(task, (ArriveTask, OccupyTask)):
            # 平台只需导航到目标位置，完成判定由 TaskTracker 裁判系统负责
            self.set_target(task.target_pos, self.max_speed)

    def update_movement(self, dt: float):
        """运动执行：根据控制意图计算位移（仅 Python 后端调用）。

        UAV：向 target_position 匀速直线飞行，忽略地形。
        UGV：向 target_position 行驶，受可通行图约束（简化直线，后续可替换为 A*）。
        """
        if self.target_position is None:
            return
        if self.desired_speed <= 0:
            return

        dx = self.target_position[0] - self.position[0]
        dy = self.target_position[1] - self.position[1]
        dist = math.sqrt(dx * dx + dy * dy)
        if dist < 1.0:
            return  # 已到达

        step = min(self.desired_speed * dt, dist)
        # 更新位置
        new_x = self.position[0] + dx / dist * step
        new_y = self.position[1] + dy / dist * step

        # UGV 受可通行图约束（简化：不可通行则原地等待）
        if not self.can_fly and self.world is not None:
            if not self.world.situation.is_passable((new_x, new_y)):
                return

        self.position = (new_x, new_y)

    def update_state(self, dt: float):
        """状态逻辑：换电倒计时、传感器探测、电量消耗。

        所有后端统一调用。
        """
        # === 换电逻辑（仅 UAV） ===
        if self.landed_on is not None:
            self.charge_timer -= dt
            if self.charge_timer <= 0:
                charger = self.world.situation.get_platform_by_id(self.landed_on)
                if charger is not None:
                    charger_cap = charger.get_capability("charger")
                    if charger_cap is not None and charger_cap.is_available():
                        charger_cap.on_use()   # battery_stock--
                        self.battery = self.max_battery
                self.landed_on = None  # 换电完成，起飞
            return  # 停靠期间跳过传感器探测和电量消耗

        # === 传感器探测 ===
        sensor = self.get_capability("sensor")
        if sensor is not None and self.world is not None:
            # 给 sensor 注入 owner 信息用于 self-exclusion
            sensor._owner_id = self.id
            detected = sensor.detect(self.world)
            for target in detected:
                self.world.situation.inject_entity(target, time=self.world.time)
            self.world.situation.mark_scan(self.position, sensor.range, self.world.time)

        # === 电量消耗（battery 和 dt 单位均为秒） ===
        # 无人车不耗电，仅 UAV 消耗电量
        if self.platform_type != "ugv":
            self.battery = max(0.0, self.battery - dt)

    # === 扫描航点规划 ===

    def _next_scan_waypoint(self, task) -> tuple[float, float] | None:
        """根据搜索优先级图计算下一个扫描航点。

        当前为简化实现：读取对应实体类型优先级图，选取最高优先级网格中心。
        后续可扩展为 lawnmower / spiral 等覆盖算法。
        """
        if self.world is None:
            return None

        # 根据任务确定目标实体类型
        entity_type = "person"
        from task.tasks import DiscoverTask
        if isinstance(task, DiscoverTask):
            entity_type = task.target_entity_type

        try:
            priority = self.world.situation.get_search_priority(self.world.time, entity_type)
            if priority.max() <= 0:
                return None
            # 取最高优先级网格中心
            max_idx = priority.argmax()
            gy, gx = divmod(max_idx, priority.shape[1])
            resolution = self.world.situation.resolution
            return (gx * resolution + resolution / 2, gy * resolution + resolution / 2)
        except Exception:
            return None
