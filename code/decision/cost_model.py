"""多目标代价评分模块（组员 C）。

归属：组员 C —— 分配算法与算法对比
来源：自 decision-c/cost_model.py 迁移，适配仓库 Task / PlatformEntity 对象接口。
职责：计算平台执行任务的分项代价，供 PlatformAllocator 贪心选择使用。
不负责：任务生成、任务状态修改、JSON 读写。
"""

from __future__ import annotations

import math
from typing import Any

# 平台类型能耗系数（仓库 platform_type 为 "uav" / "ugv"）
ENERGY_RATE: dict[str, float] = {
    "uav": 0.0015,
    "ugv": 0.0010,
}

BASE_POSITION_M: tuple[float, float] = (1000.0, 1000.0)
COMM_RANGE_M: dict[str, float] = {
    "uav": 5000.0,
    "ugv": 3000.0,
}

COST_WEIGHTS: dict[str, float] = {
    "time": 1.0,
    "energy": 1.0,
    "communication": 1.0,
    "load": 1.0,
}

DEADLINE_PENALTY: float = 1000.0
COMM_PENALTY: float = 200.0
LOAD_PENALTY: float = 100.0
SHADOW_COMM_PENALTY: float = 200.0
PREEMPT_PENALTY: float = 150.0
TASK_COUNT_LOAD_FACTOR: float = 20.0
ESCAPE_VELOCITY_FACTOR: float = 0.5
RETURN_BASE_BATTERY_THRESHOLD: float = 40.0
RETURN_BASE_MARGIN_PCT: float = 0.15
RELAY_DISCOUNT_RADIUS_M: float = 5000.0
DEFAULT_ENERGY_RATE: float = 0.0010
DEFAULT_COMM_RANGE: float = 5000.0

# 跟踪/拦截类任务类型（仓库命名）
TRACK_TASK_TYPES: frozenset[str] = frozenset({
    "InterceptTask", "OccupyTask", "ArriveTask",
})


def battery_pct(platform) -> float:
    """组员 C：将仓库电量（秒续航）转换为剩余百分比。"""
    max_battery = float(getattr(platform, "max_battery", 0.0) or 0.0)
    if max_battery <= 0:
        return 0.0
    return 100.0 * float(platform.battery) / max_battery


def resolve_target(task, situation=None) -> tuple[float, float]:
    """组员 C：解析任务目标坐标。

    优先 target_pos；其次通过 situation / task.world 查 target_entity_id。
    """
    if hasattr(task, "target_pos") and task.target_pos is not None:
        pos = task.target_pos
        return float(pos[0]), float(pos[1])

    entity_id = getattr(task, "target_entity_id", None)
    if entity_id is not None:
        # situation 可能是 SituationManager，也可能是含 get_entity 的包装
        if situation is not None and hasattr(situation, "get_entity"):
            state = situation.get_entity(entity_id)
            if state is not None and hasattr(state, "position"):
                return float(state.position[0]), float(state.position[1])
        world = getattr(task, "world", None)
        if world is not None and hasattr(world, "situation"):
            state = world.situation.get_entity(entity_id)
            if state is not None and hasattr(state, "position"):
                return float(state.position[0]), float(state.position[1])

    return 0.0, 0.0


def _euclidean_distance(pos_a: tuple[float, float], pos_b: tuple[float, float]) -> float:
    dx = pos_a[0] - pos_b[0]
    dy = pos_a[1] - pos_b[1]
    return math.sqrt(dx * dx + dy * dy)


def get_distance(task, platform, situation=None) -> float:
    """组员 C：平台到任务点的欧氏距离（米）。"""
    task_pos = resolve_target(task, situation)
    return platform.distance_to_pos(task_pos)


def _get_base_position(situation) -> tuple[float, float]:
    """组员 C：基站位置；situation 为 dict 时可覆盖。"""
    if isinstance(situation, dict) and "base_position_m" in situation:
        base = situation["base_position_m"]
        return float(base[0]), float(base[1])
    return BASE_POSITION_M


def is_in_shadow_zone(position: tuple[float, float], situation) -> bool:
    """组员 C：判断位置是否处于通信遮蔽区域（仅 dict situation 支持）。"""
    if not isinstance(situation, dict):
        return False
    zones = situation.get("shadow_zones", [])
    for zone in zones:
        center = zone.get("center_m", [0.0, 0.0])
        radius = float(zone.get("radius_m", 0.0))
        cx, cy = float(center[0]), float(center[1])
        if _euclidean_distance(position, (cx, cy)) <= radius:
            return True
    return False


def _has_nearby_relay(task_pos: tuple[float, float], relay_platforms: list | None) -> bool:
    if not relay_platforms:
        return False
    for platform in relay_platforms:
        if platform.distance_to_pos(task_pos) <= RELAY_DISCOUNT_RADIUS_M:
            return True
    return False


def _escape_time_penalty(task, distance_m: float) -> float:
    """组员 C：拦截类任务的逃逸时间加成（有 velocity 时生效）。"""
    task_type = getattr(task, "task_type", "")
    if task_type not in TRACK_TASK_TYPES:
        return 0.0
    velocity = getattr(task, "velocity", None) or getattr(task, "velocity_mps", None)
    if not velocity or len(velocity) < 2:
        return 0.0
    speed = math.sqrt(float(velocity[0]) ** 2 + float(velocity[1]) ** 2)
    if speed <= 0:
        return 0.0
    return distance_m * speed * ESCAPE_VELOCITY_FACTOR / 15.0


def calculate_cost(
    task,
    platform,
    situation=None,
    *,
    is_preempt: bool = False,
    preempt_priority_gap: int = 0,
    relay_platforms: list | None = None,
    assignment_count: int = 0,
) -> dict[str, float]:
    """组员 C：计算单个平台执行单个任务的各项代价。

    Args:
        task: Task 对象
        platform: PlatformEntity 对象
        situation: SituationManager 或可选 dict（含 shadow_zones / base_position_m）
        is_preempt: 是否通过抢占获得该平台
        preempt_priority_gap: 优先级差（被抢占任务 priority - 新任务 priority）
        relay_platforms: 具备中继能力的平台列表（用于通信惩罚折扣）
        assignment_count: 本轮已分配给该平台的任务数（负载）

    Returns:
        time_cost / energy_cost / communication_cost / load_cost / total_cost
        （risk/preempt 分别并入 energy/communication 与 load，不新增返回字段）
    """
    task_pos = resolve_target(task, situation)
    distance_m = get_distance(task, platform, situation)

    speed_mps = float(getattr(platform, "max_speed", 1.0) or 1.0)
    if speed_mps <= 0:
        speed_mps = 1.0

    time_cost = distance_m / speed_mps
    time_cost += _escape_time_penalty(task, distance_m)

    # 仓库 deadline 为绝对时刻；无 created_time 时不做超时比例惩罚
    deadline = getattr(task, "deadline", None)
    created = getattr(task, "created_time", None)
    if deadline is not None and created is not None:
        remaining = float(deadline) - float(created)
        if remaining > 0:
            overrun = max(0.0, time_cost - remaining)
            if overrun > 0:
                overrun_ratio = overrun / remaining
                time_cost += DEADLINE_PENALTY * (1.0 + overrun_ratio)

    platform_type = getattr(platform, "platform_type", "")
    energy_rate = ENERGY_RATE.get(platform_type, DEFAULT_ENERGY_RATE)
    pct = battery_pct(platform)

    energy_cost = distance_m * energy_rate
    energy_cost += max(0.0, 50.0 - pct)

    if platform_type == "uav" and pct < RETURN_BASE_BATTERY_THRESHOLD:
        energy_cost += distance_m * 2.0 * energy_rate * RETURN_BASE_MARGIN_PCT

    comm_range = COMM_RANGE_M.get(platform_type, DEFAULT_COMM_RANGE)
    base_x, base_y = _get_base_position(situation)
    dist_to_base = _euclidean_distance(task_pos, (base_x, base_y))
    communication_cost = COMM_PENALTY if dist_to_base > comm_range else 0.0

    if is_in_shadow_zone(task_pos, situation):
        communication_cost += SHADOW_COMM_PENALTY

    if _has_nearby_relay(task_pos, relay_platforms) and communication_cost > 0:
        communication_cost *= 0.5

    load_cost = assignment_count * TASK_COUNT_LOAD_FACTOR
    if getattr(platform, "current_task", None) is not None and not is_preempt:
        load_cost += LOAD_PENALTY
    if is_preempt:
        load_cost += PREEMPT_PENALTY + preempt_priority_gap * 10.0

    total_cost = (
        COST_WEIGHTS["time"] * time_cost
        + COST_WEIGHTS["energy"] * energy_cost
        + COST_WEIGHTS["communication"] * communication_cost
        + COST_WEIGHTS["load"] * load_cost
    )

    return {
        "time_cost": round(time_cost, 2),
        "energy_cost": round(energy_cost, 2),
        "communication_cost": round(communication_cost, 2),
        "load_cost": round(load_cost, 2),
        "total_cost": round(total_cost, 2),
    }
