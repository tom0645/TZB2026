"""算法对比模块（组员 C）。

归属：组员 C —— 分配算法与算法对比
来源：自 decision-c/compare_algorithms.py 迁移，适配仓库 Task / PlatformEntity 对象。
职责：在同一批任务/平台上对比
  1. 固定规则分配 fixed_rule
  2. 最近距离优先 nearest_first
  3. 多目标评分 multi_objective（主算法 PlatformAllocator）
供汇报说明多目标评分更适合边境巡检异构协同场景。

不依赖 A 主流程；不写 metrics.json（由 A 负责最终指标文件）。
"""

from __future__ import annotations

import statistics
from typing import Any

from decision.cost_model import battery_pct, get_distance
from decision.platform_allocator import (
    BATTERY_THRESHOLD,
    DEFAULT_BATTERY_THRESHOLD,
    PlatformAllocator,
)

# 仓库任务类型 → 平台类型（无固定翼，V0 仅 uav / ugv）
FIXED_RULES: dict[str, str] = {
    "ReconTask": "uav",
    "DiscoverTask": "uav",
    "ArriveTask": "uav",
    "InterceptTask": "uav",
    "MedicalDeliveryTask": "uav",
    "OccupyTask": "ugv",
    "RescueTask": "ugv",
    "RepairTask": "ugv",
    "ClearTask": "ugv",
    "ChargeTask": "ugv",
    "GuardTask": "ugv",
}


def _battery_ok(platform) -> bool:
    threshold = BATTERY_THRESHOLD.get(
        getattr(platform, "platform_type", ""), DEFAULT_BATTERY_THRESHOLD
    )
    return battery_pct(platform) >= threshold


def _capability_ok(task, platform) -> bool:
    required = getattr(task, "required_capabilities", []) or []
    return all(platform.has_available_capability(c) for c in required)


def _is_idle(platform) -> bool:
    return getattr(platform, "current_task", None) is None


def _sort_tasks(tasks: list) -> list:
    return sorted(
        tasks,
        key=lambda t: (
            t.priority,
            t.deadline if getattr(t, "deadline", None) is not None else float("inf"),
        ),
    )


def _clone_task_assignment_state(tasks: list) -> None:
    """对比前清空分配字段，避免污染调用方对象。"""
    for task in tasks:
        task.assigned_platform_ids = []
        if hasattr(task, "charger_platform_id"):
            task.charger_platform_id = None


def fixed_rule_allocate(tasks: list, platforms: list) -> list[dict]:
    """组员 C：固定规则 baseline —— 按任务类型映射平台类型，取第一个 idle 可用平台。"""
    _clone_task_assignment_state(tasks)
    used: set[int] = set()
    decisions: list[dict] = []

    for task in _sort_tasks(tasks):
        required_type = FIXED_RULES.get(task.task_type)
        if required_type is None:
            caps = getattr(task, "required_capabilities", []) or []
            if any(c in ("charger", "maintenance", "debris_clear", "rescue", "cargo") for c in caps):
                required_type = "ugv"
            else:
                required_type = "uav"

        selected = None
        for platform in platforms:
            if platform.id in used:
                continue
            if platform.platform_type != required_type:
                continue
            if not _is_idle(platform) or not _battery_ok(platform):
                continue
            if not _capability_ok(task, platform):
                continue
            selected = platform
            break

        if selected is None:
            continue

        task.assigned_platform_ids.append(selected.id)
        used.add(selected.id)
        decisions.append({
            "task_id": task.task_id,
            "task_type": task.task_type,
            "selected_platform_ids": [selected.id],
            "preempted_task_ids": [],
            "score": 0.0,
            "reason": f"固定规则：{task.task_type} -> {required_type}，选择平台#{selected.id}",
        })

    return decisions


def nearest_first_allocate(tasks: list, platforms: list, situation=None) -> list[dict]:
    """组员 C：最近距离优先 baseline —— 硬约束后选距离最近平台。"""
    _clone_task_assignment_state(tasks)
    used: set[int] = set()
    decisions: list[dict] = []

    for task in _sort_tasks(tasks):
        required_n = int(getattr(task, "required_platforms", 1))
        candidates = [
            p for p in platforms
            if p.id not in used
            and _is_idle(p)
            and _battery_ok(p)
            and _capability_ok(task, p)
        ]
        if len(candidates) < required_n:
            continue

        selected = sorted(
            candidates, key=lambda p: get_distance(task, p, situation)
        )[:required_n]

        selected_ids = []
        for p in selected:
            task.assigned_platform_ids.append(p.id)
            used.add(p.id)
            selected_ids.append(p.id)

        dist = get_distance(task, selected[0], situation)
        decisions.append({
            "task_id": task.task_id,
            "task_type": task.task_type,
            "selected_platform_ids": selected_ids,
            "preempted_task_ids": [],
            "score": round(dist, 2),
            "reason": f"最近距离优先：距离 {dist:.1f}m，选择平台 {selected_ids}",
        })

    return decisions


def multi_objective_allocate(
    tasks: list, platforms: list, situation=None
) -> list[dict]:
    """组员 C：多目标评分主算法 —— 调用 PlatformAllocator。"""
    _clone_task_assignment_state(tasks)
    return PlatformAllocator().allocate(tasks, platforms, situation)


def compute_metrics(
    decisions: list[dict],
    tasks: list,
    before_decisions: list[dict] | None = None,
) -> dict[str, Any]:
    """组员 C：计算对比指标。"""
    pending_count = len(tasks)
    assigned_count = len(decisions)
    scores = [float(d.get("score", 0.0)) for d in decisions]

    load_count: dict[int, int] = {}
    for d in decisions:
        for pid in d.get("selected_platform_ids", []):
            load_count[pid] = load_count.get(pid, 0) + 1
    load_values = list(load_count.values()) if load_count else [0]
    load_std = statistics.pstdev(load_values) if len(load_values) > 1 else 0.0

    recovery = 0
    if before_decisions is not None:
        recovery = assigned_count - len(before_decisions)

    return {
        "assigned_task_count": assigned_count,
        "unassigned_task_count": max(0, pending_count - assigned_count),
        "average_score": round(statistics.mean(scores), 2) if scores else 0.0,
        "total_score": round(sum(scores), 2),
        "max_score": round(max(scores), 2) if scores else 0.0,
        "load_balance_std": round(load_std, 2),
        "recovery_task_count": recovery,
        "platform_load": {str(k): v for k, v in load_count.items()},
    }


def compare(
    tasks: list,
    platforms: list,
    situation=None,
    before_decisions: list[dict] | None = None,
) -> dict[str, Any]:
    """组员 C：运行三类算法并返回统一对比结果。

    注意：各算法会清空并重写 task.assigned_platform_ids，
    调用方应传入任务副本，或在对比后自行恢复。
    """
    # 深拷贝任务列表不够（对象嵌套）；按算法顺序各自先 clone 分配字段后运行
    # 为避免互相污染，每轮前重置分配字段（平台 current_task 保持只读）
    tasks_fixed = list(tasks)
    tasks_near = list(tasks)
    tasks_multi = list(tasks)

    fixed = fixed_rule_allocate(tasks_fixed, platforms)
    # 重置后再跑下一算法
    nearest = nearest_first_allocate(tasks_near, platforms, situation)
    multi = multi_objective_allocate(tasks_multi, platforms, situation)

    algorithms = {
        "fixed_rule": compute_metrics(fixed, tasks, before_decisions),
        "nearest_first": compute_metrics(nearest, tasks, before_decisions),
        "multi_objective": compute_metrics(multi, tasks, before_decisions),
    }

    best = max(
        algorithms.keys(),
        key=lambda k: (
            algorithms[k]["assigned_task_count"],
            -algorithms[k]["unassigned_task_count"],
            -algorithms[k]["average_score"],
            -algorithms[k]["load_balance_std"],
        ),
    )

    return {
        "scenario": "border_patrol_warehouse",
        "algorithms": algorithms,
        "decisions": {
            "fixed_rule": fixed,
            "nearest_first": nearest,
            "multi_objective": multi,
        },
        "summary": {
            "best_algorithm": best,
            "reason": (
                "多目标评分兼顾能力、电量、响应时间、通信和负载，"
                "更适合边境巡检异构协同场景"
                if best == "multi_objective"
                else f"{best} 在本场景指标最优"
            ),
        },
    }
