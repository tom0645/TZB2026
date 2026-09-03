"""任务类型定义 —— 所有任务类型的基类和具体实现。

TaskTracker 是纯生命周期管理器，不生成任务。任务由决策系统或人工注入。
任务不包含控制指令。分配信息通过 assigned_platform_ids 统一管理。
"""

from enum import Enum, auto
from abc import ABC, abstractmethod
from math import floor


def get_area_bounds(area) -> tuple[float, float, float, float]:
    """将矩形元组或带 ``bounds`` 属性的几何对象统一为边界元组。"""
    bounds = getattr(area, "bounds", area)
    if not isinstance(bounds, (tuple, list)) or len(bounds) != 4:
        raise TypeError("area 必须是 (xmin, ymin, xmax, ymax) 或带 bounds 属性的几何对象")
    xmin, ymin, xmax, ymax = (float(value) for value in bounds)
    if xmax < xmin or ymax < ymin:
        raise ValueError("area 边界必须满足 xmin <= xmax 且 ymin <= ymax")
    return xmin, ymin, xmax, ymax


def get_platform_battery_ratio(situation, platform_id: int) -> float | None:
    """从态势快照或平台注册表读取剩余电量比例。"""
    state = situation.get_entity(platform_id)
    if state is not None:
        ratio = state.extra.get("battery_ratio")
        if ratio is not None:
            return max(0.0, min(1.0, float(ratio)))

        battery = state.extra.get("battery")
        max_battery = state.extra.get("max_battery")
        if battery is not None and max_battery:
            return max(0.0, min(1.0, float(battery) / float(max_battery)))

    platform = situation.get_platform_by_id(platform_id)
    if platform is not None:
        max_battery = getattr(platform, "max_battery", 0.0)
        if max_battery:
            return max(0.0, min(1.0, float(platform.battery) / float(max_battery)))

    # 兼容真实部署直接上报 [0, 1] 比例、但未附带 max_battery 的快照。
    if state is not None:
        battery = state.extra.get("battery")
        if battery is not None and 0.0 <= float(battery) <= 1.0:
            return float(battery)
    return None


class TaskStatus(Enum):
    """任务状态枚举"""
    PENDING = auto()       # 已注入，等待分配
    ACTIVE = auto()        # 已分配，正在执行
    COMPLETED = auto()     # 已完成
    FAILED = auto()        # 已失败（超时 / 目标消失）
    CANCELLED = auto()     # 已取消（人工）


# === 任务基类 ===

class Task(ABC):
    """任务抽象基类。

    分配信息通过 assigned_platform_ids 统一管理，由决策系统写入、TaskTracker 在任务终态时释放。
    规则：
    - 决策系统可读写
    - TaskTracker 在完成/失败/取消时释放
    - 其他系统只读
    - ChargeTask 约定：assigned_platform_ids 中是需要充电的 UAV ID 列表，每个 UAV 一个独立 ChargeTask
    """

    _next_id: int = 0      # 自增 ID 计数器

    def __init__(self, priority: int = 80, deadline: float | None = None):
        if not isinstance(priority, int) or priority < 0:
            raise ValueError("priority 必须是非负整数")
        if deadline is not None and deadline < 0:
            raise ValueError("deadline 必须是非负的绝对时刻")
        self.task_id = Task._next_id
        Task._next_id += 1
        self.task_type: str = self.__class__.__name__
        self.priority: int = priority
        self.status: TaskStatus = TaskStatus.PENDING
        self.created_time: float = 0.0       # 注入时由 TaskTracker 设置
        self.deadline: float | None = deadline
        self.required_capabilities: list[str] = []
        self.required_platforms: int = 1
        self.assigned_platform_ids: list[int] = []   # 执行此任务的平台 ID 列表，空列表 = 未分配
        self.trigger_key: str | None = None
        self.trigger_reason: str = ""
        self.parent_task_id: int | None = None

    @abstractmethod
    def is_completed(self, situation: "SituationManager") -> bool:  # type: ignore[name-defined]
        """检查任务是否满足完成条件（查询态势层，由 TaskTracker 裁判系统调用）。"""
        pass

    def brief(self) -> str:
        """返回任务的简要描述，供打印日志使用。子类可覆盖以提供更详细的信息。"""
        return f"{self.task_type}#{self.task_id}"


# === 不绑定具体实体的任务 ===

class ReconTask(Task):
    """侦察覆盖任务：对指定区域或路径进行扫描覆盖。"""

    def __init__(self, area, required_coverage: float = 0.95, priority: int = 90,
                 target_entity_type: str | None = None,
                 priority_threshold: float | None = None,
                 source_task_id: int | None = None,
                 required_platforms: int = 1):
        """
        Args:
            area: 需要覆盖的区域（Polygon / tuple of (xmin, ymin, xmax, ymax)）
            required_coverage: 覆盖率阈值，默认 0.95
            target_entity_type: 搜索优先级图对应的目标类型
            priority_threshold: 非 None 时表示覆盖恢复任务；区域内低于该优先级的
                网格占比达到 required_coverage 即完成
            source_task_id: 由任务分解器生成时记录父任务 ID，用于去重
            required_platforms: 协同执行该侦察任务的平台数量
        """
        super().__init__(priority=priority)
        if not 0.0 <= required_coverage <= 1.0:
            raise ValueError("required_coverage 必须位于 [0, 1]")
        if priority_threshold is not None and not 0.0 <= priority_threshold <= 1.0:
            raise ValueError("priority_threshold 必须位于 [0, 1]")
        if required_platforms < 1:
            raise ValueError("required_platforms 必须至少为 1")
        xmin, ymin, xmax, ymax = get_area_bounds(area)
        if xmax == xmin or ymax == ymin:
            raise ValueError("ReconTask.area 必须具有正面积")
        self.area = area
        self.required_coverage = float(required_coverage)
        self.target_entity_type = target_entity_type
        self.priority_threshold = priority_threshold
        self.source_task_id = source_task_id
        self.required_platforms = int(required_platforms)
        self._initial_priority_mask = None
        self._refreshed_priority_mask = None
        self.required_capabilities = ["sensor"]

    @property
    def target_pos(self) -> tuple[float, float]:
        """返回区域中心，供分配器进行距离排序。"""
        xmin, ymin, xmax, ymax = get_area_bounds(self.area)
        return (xmin + xmax) / 2.0, (ymin + ymax) / 2.0

    def is_completed(self, situation) -> bool:
        """按首次覆盖率或搜索优先级恢复比例判定完成。"""
        bounds = get_area_bounds(self.area)
        if self.priority_threshold is None:
            return situation.get_coverage_ratio(bounds) >= self.required_coverage

        current_time = situation.world.time
        priority_map = situation.get_search_priority(
            current_time, self.target_entity_type or "person",
        )
        resolution = float(situation.resolution)
        xmin, ymin, xmax, ymax = bounds
        gx_min = max(0, floor(xmin / resolution))
        gy_min = max(0, floor(ymin / resolution))
        gx_max = min(priority_map.shape[1], floor(xmax / resolution) + 1)
        gy_max = min(priority_map.shape[0], floor(ymax / resolution) + 1)
        if gx_max <= gx_min or gy_max <= gy_min:
            return False

        region = priority_map[gy_min:gy_max, gx_min:gx_max]
        if self._initial_priority_mask is None:
            self._initial_priority_mask = region > self.priority_threshold
            self._refreshed_priority_mask = self._initial_priority_mask.copy()
            self._refreshed_priority_mask[:] = False
        if not self._initial_priority_mask.any():
            return True

        refreshed = (region <= self.priority_threshold) & self._initial_priority_mask
        self._refreshed_priority_mask |= refreshed
        refreshed_ratio = (
            float(self._refreshed_priority_mask.sum())
            / float(self._initial_priority_mask.sum())
        )
        return refreshed_ratio >= self.required_coverage

    def brief(self) -> str:
        target = self.target_entity_type or "all"
        return (
            f"{self.task_type}#{self.task_id}"
            f"(area={get_area_bounds(self.area)}, target={target})"
        )


class DiscoverTask(Task):
    """搜索发现任务：发现指定数量和类型的目标实体。不绑定具体实体。"""

    def __init__(self, target_entity_type: str, required_count: int = 1,
                 area=None, priority: int = 70):
        """
        Args:
            target_entity_type: 目标实体类型，如 "person" / "vehicle" / "aerial"
            required_count: 需要发现的数量
            area: 限定搜索区域，None 为全图
        """
        super().__init__(priority=priority)
        if not target_entity_type:
            raise ValueError("target_entity_type 不能为空")
        if required_count < 1:
            raise ValueError("required_count 必须至少为 1")
        if area is not None:
            xmin, ymin, xmax, ymax = get_area_bounds(area)
            if xmax == xmin or ymax == ymin:
                raise ValueError("DiscoverTask.area 必须具有正面积")
        self.target_entity_type = target_entity_type
        self.required_count = required_count
        self.area = area
        self.required_capabilities = ["sensor"]

    @property
    def target_pos(self) -> tuple[float, float]:
        """返回搜索区域中心；全图搜索由分配器使用默认原点。"""
        if self.area is None:
            return 0.0, 0.0
        xmin, ymin, xmax, ymax = get_area_bounds(self.area)
        return (xmin + xmax) / 2.0, (ymin + ymax) / 2.0

    def brief(self) -> str:
        return (
            f"{self.task_type}#{self.task_id}"
            f"(type={self.target_entity_type}, need={self.required_count})"
        )

    def is_completed(self, situation) -> bool:
        """逐帧查态势层精确实体层，该类型且 discovered == True 的实体数量 ≥ required_count。"""
        entities = list(situation.get_entities_by_type(self.target_entity_type))

        # PersonTarget 的统一 entity_type 是 person，具体角色放在 extra["role"]。
        # 兼容旧态势快照未上报 role 的搜救场景，此时 person 视作 victim。
        if self.target_entity_type in ("victim", "intruder", "suspect"):
            for state in situation.get_entities_by_type("person"):
                role = state.extra.get("role")
                if role == self.target_entity_type or (
                    role is None and self.target_entity_type == "victim"
                ):
                    entities.append(state)

        unique_entities = {state.entity_id: state for state in entities}
        if self.area is not None:
            xmin, ymin, xmax, ymax = get_area_bounds(self.area)
            unique_entities = {
                entity_id: state
                for entity_id, state in unique_entities.items()
                if xmin <= state.position[0] <= xmax and ymin <= state.position[1] <= ymax
            }
        discovered_count = sum(1 for e in unique_entities.values() if e.discovered)
        return discovered_count >= self.required_count


class GuardTask(Task):
    """区域守卫任务：标记战略要害区域，告知决策系统"哪里必须守住"。不绑定具体实体。

    始终不自行完成——场景终止时由效能评估器统一判定。
    """

    def __init__(self, area, hostile_entity_types: list[str] | None = None,
                 max_intrusions: int = 0, priority: int = 5):
        """
        Args:
            area: 需要守卫的区域（Polygon）
            hostile_entity_types: 需要防范的敌对实体类型
            max_intrusions: 允许的最大入侵次数，默认 0（零容忍）
        """
        super().__init__(priority=priority)
        self.area = area
        self.hostile_entity_types = hostile_entity_types or ["aerial"]
        self.max_intrusions = max_intrusions

    def is_completed(self, situation) -> bool:
        """守卫任务不自行完成，始终由场景终止条件统一结束。"""
        return False


class ArriveTask(Task):
    """抵达到位任务 —— 人工干预专用。平台抵达指定位置。

    由 TaskTracker 裁判系统判定：至少 required_platforms 个已分配平台进入目标半径即完成。
    平台在 update_control 中只负责导航，不自行修改任务状态。
    """

    def __init__(self, target_pos: tuple[float, float], radius: float = 50.0,
                 priority: int = 10, required_capabilities: list[str] | None = None):
        super().__init__(priority=priority)
        self.target_pos = target_pos
        self.radius = radius
        if required_capabilities is not None:
            self.required_capabilities = required_capabilities

    def brief(self) -> str:
        return f"{self.task_type}#{self.task_id}(pos={self.target_pos})"

    def is_completed(self, situation) -> bool:
        """裁判系统判定：至少 required_platforms 个已分配平台到达目标半径内。"""
        arrived = 0
        for pid in self.assigned_platform_ids:
            platform = situation.get_platform_by_id(pid)
            if platform is not None:
                if platform.distance_to_pos(self.target_pos) < self.radius:
                    arrived += 1
        return arrived >= self.required_platforms


class OccupyTask(Task):
    """驻留任务 —— 人工干预专用。平台在目标位置连续停留指定时长。

    由 TaskTracker 裁判系统判定：至少 required_platforms 个已分配平台在目标半径内连续驻留 hold_time 秒即完成。
    平台离开半径则计时归零。平台在 update_control 中只负责导航，不自行修改任务状态。
    """

    def __init__(self, target_pos: tuple[float, float], radius: float = 50.0,
                 hold_time: float = 60.0, priority: int = 10,
                 required_capabilities: list[str] | None = None):
        super().__init__(priority=priority)
        self.target_pos = target_pos
        self.radius = radius
        self.hold_time = hold_time
        if required_capabilities is not None:
            self.required_capabilities = required_capabilities
        # 驻留计时：记录每个平台首次进入目标半径的时刻
        self._arrive_times: dict[int, float] = {}

    def brief(self) -> str:
        return f"{self.task_type}#{self.task_id}(pos={self.target_pos})"

    def is_completed(self, situation) -> bool:
        """裁判系统判定：至少 required_platforms 个已分配平台连续驻留 hold_time 秒。"""
        current_time = situation.world.time
        occupied = 0
        for pid in self.assigned_platform_ids:
            platform = situation.get_platform_by_id(pid)
            if platform is None:
                continue
            if platform.distance_to_pos(self.target_pos) < self.radius:
                if pid not in self._arrive_times:
                    self._arrive_times[pid] = current_time       # 记录首次进入时刻
                elif current_time - self._arrive_times[pid] >= self.hold_time:
                    occupied += 1
            else:
                self._arrive_times.pop(pid, None)                # 离开半径，计时归零
        return occupied >= self.required_platforms


# === 绑定具体实体的任务 ===

class EntityTask(Task, ABC):
    """实体任务基类：绑定已发现的目标实体，通过查询态势层中的实体状态字段判定完成。"""

    def __init__(self, target_entity_id: int, check_field: str, check_value,
                 priority: int = 50,
                 last_known_position: tuple[float, float] | None = None,
                 target_entity_type: str | None = None):
        super().__init__(priority=priority)
        self.target_entity_id = target_entity_id
        self.check_field = check_field          # 查询的实体状态字段名
        self.check_value = check_value          # 期望值
        self.last_known_position = last_known_position
        self.target_entity_type = target_entity_type

    @property
    def target_pos(self) -> tuple[float, float]:
        """返回最后已知位置，供分配器进行距离排序。"""
        return self.last_known_position or (0.0, 0.0)

    def brief(self) -> str:
        return f"{self.task_type}#{self.task_id}(entity={self.target_entity_id})"

    def is_completed(self, situation) -> bool:
        """查询态势层中目标实体的 extra 状态字段，达到期望值即完成。"""
        entity_state = situation.get_entity(self.target_entity_id)
        if entity_state is None:
            return False
        return entity_state.extra.get(self.check_field) == self.check_value


class MedicalDeliveryTask(EntityTask):
    """医疗投送任务：向受伤人员投送急救包。"""

    def __init__(self, target_entity_id: int, priority: int = 40,
                 last_known_position: tuple[float, float] | None = None):
        super().__init__(target_entity_id=target_entity_id,
                         check_field="injured", check_value=False,
                         priority=priority,
                         last_known_position=last_known_position,
                         target_entity_type="person")
        self.required_capabilities = ["medical"]

    def is_completed(self, situation) -> bool:
        """完成条件：人员伤情已处理 或 已被救援（不再需要医疗投送）。"""
        state = situation.get_entity(self.target_entity_id)
        if state is None:
            return False
        # 已被 UGV 救援 → 无需医疗，任务可结束
        if state.extra.get("rescued", False):
            return True
        # 原逻辑：injured 已变为 False
        return state.extra.get("injured", True) is False


class RescueTask(EntityTask):
    """救援任务：UGV 将人员接上车。"""

    def __init__(self, target_entity_id: int, priority: int = 30,
                 last_known_position: tuple[float, float] | None = None):
        super().__init__(target_entity_id=target_entity_id,
                         check_field="rescued", check_value=True,
                         priority=priority,
                         last_known_position=last_known_position,
                         target_entity_type="person")
        self.required_capabilities = ["rescue"]


class InterceptTask(EntityTask):
    """拦截处置任务：对非合作目标进行拦截处置。"""

    def __init__(self, target_entity_id: int, priority: int = 5,
                 last_known_position: tuple[float, float] | None = None,
                 target_entity_type: str | None = None):
        super().__init__(target_entity_id=target_entity_id,
                         check_field="neutralized", check_value=True,
                         priority=priority,
                         last_known_position=last_known_position,
                         target_entity_type=target_entity_type)
        self.required_capabilities = ["effector"]


class RepairTask(EntityTask):
    """维修任务：修复设施异常。"""

    def __init__(self, target_entity_id: int, priority: int = 60,
                 last_known_position: tuple[float, float] | None = None):
        super().__init__(target_entity_id=target_entity_id,
                         check_field="repaired", check_value=True,
                         priority=priority,
                         last_known_position=last_known_position,
                         target_entity_type="facility")
        self.required_capabilities = ["maintenance"]


class ClearTask(EntityTask):
    """残骸清理任务：清理被处置后坠落的目标残骸。"""

    def __init__(self, target_entity_id: int, priority: int = 60,
                 last_known_position: tuple[float, float] | None = None):
        super().__init__(target_entity_id=target_entity_id,
                         check_field="debris_cleared", check_value=True,
                         priority=priority,
                         last_known_position=last_known_position,
                         target_entity_type="aerial")
        self.required_capabilities = ["debris_clear"]


class ChargeTask(Task):
    """充电任务：目标平台电量恢复到阈值以上。

    独立于 EntityTask，因为检查的是己方平台（而非 TargetEntity）的状态字段。
    
    分配约定：
    - assigned_platform_ids = [target_entity_id]，即需要充电的平台 ID（单个）
    - charger_platform_id：执行充电的平台 ID，由决策系统在分配时填写
    - 每个需要充电的 UAV 生成一个独立的 ChargeTask（一个 charger 可同时有多个 ChargeTask）
    """

    def __init__(self, target_entity_id: int, battery_threshold: float = 0.9,
                 priority: int = 25):
        """
        Args:
            target_entity_id: 需要充电的平台 ID（如电量不足的 UAV）
            battery_threshold: 充电目标电量阈值，默认 0.9（90%）
        """
        if not 0.0 <= battery_threshold <= 1.0:
            raise ValueError("battery_threshold 必须是 [0, 1] 内的剩余电量比例")
        super().__init__(priority=priority)
        self.target_entity_id = target_entity_id        # 需要充电的平台
        self.charger_platform_id: int | None = None     # 执行充电的平台（决策系统分配时填写）
        self.battery_threshold = battery_threshold
        self.required_capabilities = ["charger"]

    def brief(self) -> str:
        return (
            f"{self.task_type}#{self.task_id}"
            f"(target={self.target_entity_id}, charger={self.charger_platform_id})"
        )

    def is_completed(self, situation) -> bool:
        """检查目标平台剩余电量比例是否已达阈值。"""
        ratio = get_platform_battery_ratio(situation, self.target_entity_id)
        return ratio is not None and ratio >= self.battery_threshold
