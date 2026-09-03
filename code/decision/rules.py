"""态势反应规则：只读取态势和活动任务，返回新的 Task。"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from math import floor

from task.tasks import (
    ChargeTask,
    ClearTask,
    InterceptTask,
    MedicalDeliveryTask,
    ReconTask,
    RepairTask,
    RescueTask,
    get_area_bounds,
    get_platform_battery_ratio,
)


def _has_task_for(entity_id: int, active_tasks: list, task_type: type) -> bool:
    """检查是否已有同目标、同类型的 pending/active 任务。"""
    return any(
        isinstance(task, task_type)
        and getattr(task, "target_entity_id", None) == entity_id
        for task in active_tasks
    )


def _area_overlap_ratio(first, second) -> float:
    """返回 first 被 second 覆盖的面积比例。"""
    ax0, ay0, ax1, ay1 = get_area_bounds(first)
    bx0, by0, bx1, by1 = get_area_bounds(second)
    area = max(0.0, ax1 - ax0) * max(0.0, ay1 - ay0)
    if area == 0.0:
        return 0.0
    intersection = max(0.0, min(ax1, bx1) - max(ax0, bx0)) * max(
        0.0, min(ay1, by1) - max(ay0, by0)
    )
    return intersection / area


def _overlaps_existing_recon(area, active_tasks: list) -> bool:
    """局部侦察任务互相去重，但不受大范围基础巡检压制。"""
    candidate = get_area_bounds(area)
    cx0, cy0, cx1, cy1 = candidate
    candidate_area = (cx1 - cx0) * (cy1 - cy0)

    for task in active_tasks:
        if not isinstance(task, ReconTask):
            continue
        existing = get_area_bounds(task.area)
        ex0, ey0, ex1, ey1 = existing
        existing_area = (ex1 - ex0) * (ey1 - ey0)
        is_base_patrol = (
            task.trigger_key is None
            and existing_area > candidate_area * 4.0
        )
        if is_base_patrol:
            continue
        if _area_overlap_ratio(candidate, existing) >= 0.5:
            return True
    return False


def _mark_task(task, key: str, reason: str):
    """记录任务来源，便于去重、日志和节点检查。"""
    task.trigger_key = key
    task.trigger_reason = reason
    return task


@dataclass(frozen=True)
class ReconTrigger:
    """局部侦察触发结果。"""

    entity_type: str
    area: tuple[float, float, float, float]
    score: float


class ReactionRule(ABC):
    """反应规则基类。"""

    @abstractmethod
    def find_triggered(self, situation, active_tasks: list) -> list:
        """返回满足条件的态势对象或触发描述。"""
        raise NotImplementedError

    @abstractmethod
    def generate(self, triggered: list, situation) -> list:
        """将触发结果转换为任务列表。"""
        raise NotImplementedError


class PersonDiscoveredRule(ReactionRule):
    """发现未救援人员后生成救援及必要的医疗任务。"""

    def find_triggered(self, situation, active_tasks):
        triggered = []
        for state in situation.get_entities_all().values():
            if state.entity_type not in ("victim", "person"):
                continue
            if state.entity_type == "person" and state.extra.get("role") not in (None, "victim"):
                continue
            if not state.discovered or state.extra.get("rescued", False):
                continue
            if (_has_task_for(state.entity_id, active_tasks, RescueTask)
                    or _has_task_for(state.entity_id, active_tasks, MedicalDeliveryTask)):
                continue
            triggered.append(state)
        return triggered

    def generate(self, triggered, situation):
        tasks = []
        for state in triggered:
            entity_id = state.entity_id
            tasks.append(_mark_task(
                RescueTask(entity_id, priority=30, last_known_position=state.position),
                f"rescue:{entity_id}",
                "发现未救援人员",
            ))
            if state.extra.get("injured", False):
                tasks.append(_mark_task(
                    MedicalDeliveryTask(
                        entity_id, priority=40, last_known_position=state.position,
                    ),
                    f"medical:{entity_id}",
                    "发现受伤人员",
                ))
        return tasks


class HostileTargetRule(ReactionRule):
    """发现明确敌对的人员、车辆或飞行器后生成拦截任务。"""

    def find_triggered(self, situation, active_tasks):
        triggered = []
        for state in situation.get_entities_all().values():
            role = state.extra.get("role")
            direct_hostile = state.entity_type in (
                "intruder", "hostile_uav", "aerial", "vehicle",
            )
            person_hostile = state.entity_type == "person" and role in (
                "intruder", "suspect",
            )
            if not (direct_hostile or person_hostile):
                continue
            if not state.discovered or state.extra.get("neutralized", False):
                continue
            if _has_task_for(state.entity_id, active_tasks, InterceptTask):
                continue
            triggered.append(state)
        return triggered

    def generate(self, triggered, situation):
        tasks = []
        for state in triggered:
            entity_type = (
                "person"
                if state.entity_type in ("person", "intruder")
                else state.entity_type
            )
            tasks.append(_mark_task(
                InterceptTask(
                    state.entity_id,
                    priority=5,
                    last_known_position=state.position,
                    target_entity_type=entity_type,
                ),
                f"intercept:{state.entity_id}",
                f"发现未处置{entity_type}目标",
            ))
        return tasks


class FacilityAnomalyRule(ReactionRule):
    """发现未修复设施后生成维修任务。"""

    def find_triggered(self, situation, active_tasks):
        return [
            state
            for state in situation.get_entities_all().values()
            if state.entity_type == "facility"
            and state.discovered
            and not state.extra.get("repaired", False)
            and not _has_task_for(state.entity_id, active_tasks, RepairTask)
        ]

    def generate(self, triggered, situation):
        return [
            _mark_task(
                RepairTask(
                    state.entity_id,
                    priority=60,
                    last_known_position=state.position,
                ),
                f"repair:{state.entity_id}",
                "发现设施异常",
            )
            for state in triggered
        ]


class LowBatteryRule(ReactionRule):
    """UAV 剩余电量不高于阈值时生成充电任务。"""

    def __init__(self, threshold: float = 0.2):
        if not 0.0 <= threshold <= 1.0:
            raise ValueError("threshold 必须位于 [0, 1]")
        self.threshold = float(threshold)

    def find_triggered(self, situation, active_tasks):
        triggered = []
        for state in situation.get_platforms():
            if state.entity_type != "uav":
                continue
            ratio = get_platform_battery_ratio(situation, state.entity_id)
            if ratio is None or ratio > self.threshold:
                continue
            if _has_task_for(state.entity_id, active_tasks, ChargeTask):
                continue
            triggered.append(state)
        return triggered

    def generate(self, triggered, situation):
        ordered = sorted(
            triggered,
            key=lambda state: get_platform_battery_ratio(
                situation, state.entity_id,
            ) or 0.0,
        )
        return [
            _mark_task(
                ChargeTask(state.entity_id, priority=25),
                f"charge:{state.entity_id}",
                "UAV 剩余电量低于安全阈值",
            )
            for state in ordered
        ]


class LandingSiteRule(ReactionRule):
    """发现未清理的已处置飞行器后生成残骸清理任务。"""

    def find_triggered(self, situation, active_tasks):
        return [
            state
            for state in situation.get_entities_all().values()
            if state.entity_type == "aerial"
            and state.extra.get("neutralized", False)
            and not state.extra.get("debris_cleared", False)
            and not _has_task_for(state.entity_id, active_tasks, ClearTask)
        ]

    def generate(self, triggered, situation):
        return [
            _mark_task(
                ClearTask(
                    state.entity_id,
                    priority=60,
                    last_known_position=state.position,
                ),
                f"clear:{state.entity_id}",
                "发现未清理残骸",
            )
            for state in triggered
        ]


class SearchPriorityReconRule(ReactionRule):
    """为当前最高风险且未被局部任务覆盖的区域生成 ReconTask。"""

    def __init__(self, entity_types: tuple[str, ...] | list[str] | None = None,
                 threshold: float = 0.3, region_size: float = 2000.0,
                 max_regions_per_type: int = 1,
                 required_coverage: float = 0.9, priority: int = 90):
        if not 0.0 <= threshold <= 1.0:
            raise ValueError("threshold 必须位于 [0, 1]")
        if region_size <= 0:
            raise ValueError("region_size 必须大于 0")
        if max_regions_per_type < 1:
            raise ValueError("max_regions_per_type 必须至少为 1")
        if not 0.0 <= required_coverage <= 1.0:
            raise ValueError("required_coverage 必须位于 [0, 1]")

        self.entity_types = tuple(entity_types) if entity_types is not None else None
        self.threshold = float(threshold)
        self.region_size = float(region_size)
        self.max_regions_per_type = int(max_regions_per_type)
        self.required_coverage = float(required_coverage)
        self.priority = int(priority)

    def find_triggered(self, situation, active_tasks):
        active_dynamic = sum(
            isinstance(task, ReconTask)
            and (task.trigger_key or "").startswith("search_priority:")
            for task in active_tasks
        )
        slots = max(0, self.max_regions_per_type - active_dynamic)
        if slots == 0:
            return []

        current_time = getattr(situation.world, "time", 0.0)
        entity_types = self.entity_types
        if entity_types is None:
            entity_types = tuple(
                getattr(situation.world.config, "erosion_speeds", {})
            )
        erosion_speeds = getattr(
            situation.world.config, "erosion_speeds", {},
        )
        entity_types = tuple(sorted(
            entity_types,
            key=lambda name: erosion_speeds.get(name, 0.0),
            reverse=True,
        ))

        maps = {
            entity_type: situation.get_search_priority(
                current_time, entity_type,
            ).copy()
            for entity_type in entity_types
        }
        maps = {key: value for key, value in maps.items() if value.size}

        triggered = []
        while maps and len(triggered) < slots:
            best = self._best_candidate(maps)
            if best is None or best[0] <= self.threshold:
                break
            score, entity_type, gy, gx = best
            center = (
                (gx + 0.5) * situation.resolution,
                (gy + 0.5) * situation.resolution,
            )
            area = self._region_around(center, situation)
            for priority_map in maps.values():
                self._suppress_region(priority_map, area, situation.resolution)
            if _overlaps_existing_recon(area, active_tasks):
                continue
            triggered.append(ReconTrigger(entity_type, area, score))
        return triggered

    def generate(self, triggered, situation):
        tasks = []
        erosion_speeds = getattr(
            situation.world.config, "erosion_speeds", {},
        )
        for trigger in triggered:
            boost = max(1, int(round(trigger.score * 20.0)))
            task_priority = max(1, self.priority - boost)
            required_platforms = (
                2 if erosion_speeds.get(trigger.entity_type, 0.0) >= 10.0 else 1
            )
            area_key = ":".join(str(int(round(value))) for value in trigger.area)
            tasks.append(_mark_task(
                ReconTask(
                    area=trigger.area,
                    required_coverage=self.required_coverage,
                    priority=task_priority,
                    target_entity_type=trigger.entity_type,
                    priority_threshold=self.threshold,
                    required_platforms=required_platforms,
                ),
                f"search_priority:{trigger.entity_type}:{area_key}",
                f"{trigger.entity_type}搜索优先级={trigger.score:.2f}",
            ))
        return tasks

    @staticmethod
    def _best_candidate(priority_maps):
        best = None
        for entity_type, priority_map in priority_maps.items():
            flat_index = int(priority_map.argmax())
            score = float(priority_map.flat[flat_index])
            gy, gx = divmod(flat_index, priority_map.shape[1])
            candidate = (score, entity_type, gy, gx)
            if best is None or score > best[0]:
                best = candidate
        return best

    def _region_around(self, center, situation):
        half = self.region_size / 2.0
        return (
            max(0.0, center[0] - half),
            max(0.0, center[1] - half),
            min(float(situation.scene_width), center[0] + half),
            min(float(situation.scene_height), center[1] + half),
        )

    @staticmethod
    def _suppress_region(priority_map, area, resolution: float):
        xmin, ymin, xmax, ymax = area
        gx_min = max(0, floor(xmin / resolution))
        gy_min = max(0, floor(ymin / resolution))
        gx_max = min(priority_map.shape[1], floor(xmax / resolution) + 1)
        gy_max = min(priority_map.shape[0], floor(ymax / resolution) + 1)
        priority_map[gy_min:gy_max, gx_min:gx_max] = 0.0
