"""平台分配器（组员 C）。

归属：组员 C —— 分配算法与算法对比
来源：自 decision-c V1（allocator + cost_model）迁移，对齐仓库对象接口。
职责：
  - 能力 / 电量硬约束过滤
  - 多目标综合评分（时间、电量、通信、负载）
  - 高优先级任务对低优先级任务的抢占
  - ChargeTask 的 UAV/UGV 双角色分配
  - 返回结构化 decisions，并写入 task.assigned_platform_ids（兼容 A）

不负责：任务生成、修改 task.status、读写 JSON、底层路径规划。

对 A 兼容点：
  - DecisionSystem 调用 allocate(pending_tasks, platforms) 两参即可
  - 成功分配时原地写入 assigned_platform_ids（A 据此 activate）
  - 可选第三参 situation；可选返回 decisions（A 暂可忽略）
"""

from __future__ import annotations

from decision.cost_model import (
    battery_pct,
    calculate_cost,
    resolve_target,
)

# 电量硬约束阈值（剩余百分比）
BATTERY_THRESHOLD: dict[str, float] = {
    "uav": 25.0,
    "ugv": 20.0,
}
DEFAULT_BATTERY_THRESHOLD: float = 20.0


class PlatformAllocator:
    """组员 C：平台分配器 —— 能力过滤 + 多目标评分 + 贪心 + 抢占。

    仅操作 task.assigned_platform_ids，不直接写入 platform.current_task。
    platform.current_task 的同步由 TaskTracker.step() 统一负责。
    """

    def allocate(self, tasks: list, platforms: list, situation=None) -> list[dict]:
        """为待分配任务匹配平台。

        Args:
            tasks: 待分配 Task 列表（A 传入的 pending 任务）
            platforms: PlatformEntity 列表
            situation: 可选态势（SituationManager 或 dict）；A 当前可不传

        Returns:
            decisions 列表，每条含：
              task_id, task_type, selected_platform_ids,
              preempted_task_ids, score, reason
            （字段对齐 decision/README.md 冻结接口）

        副作用（兼容 A）：
            成功时写入 task.assigned_platform_ids；
            ChargeTask 另写 charger_platform_id。
        """
        decisions: list[dict] = []
        # 本轮已占用平台 ID，防止同一平台重复分配
        used_platform_ids: set[int] = set()
        # 本轮负载计数（供 load_cost）
        assignment_counts: dict[int, int] = {p.id: 0 for p in platforms}

        relay_platforms = [
            p for p in platforms
            if p.has_available_capability("relay") or p.has_capability("relay")
        ]

        sorted_tasks = sorted(
            tasks,
            key=lambda t: (
                t.priority,
                t.deadline if getattr(t, "deadline", None) is not None else float("inf"),
            ),
        )

        for task in sorted_tasks:
            from task.tasks import ChargeTask

            if isinstance(task, ChargeTask):
                decision = self._allocate_charge(
                    task, platforms, situation, used_platform_ids, relay_platforms
                )
                if decision is not None:
                    decisions.append(decision)
                continue

            required_n = int(getattr(task, "required_platforms", 1))
            candidates = self._collect_candidates(
                task, platforms, used_platform_ids
            )
            if len(candidates) < required_n:
                continue

            scored: list[tuple] = []
            for platform, is_preempt, old_task in candidates:
                priority_gap = 0
                if is_preempt and old_task is not None:
                    priority_gap = int(old_task.priority) - int(task.priority)
                cost = calculate_cost(
                    task,
                    platform,
                    situation,
                    is_preempt=is_preempt,
                    preempt_priority_gap=priority_gap,
                    relay_platforms=relay_platforms,
                    assignment_count=assignment_counts.get(platform.id, 0),
                )
                scored.append((platform, cost, is_preempt, old_task))

            scored.sort(key=lambda item: item[1]["total_cost"])
            selected = scored[:required_n]

            selected_ids: list[int] = []
            preempted_ids: list[int] = []
            best_platform, best_cost, _, _ = selected[0]

            for platform, cost, is_preempt, old_task in selected:
                if is_preempt and platform.current_task is not None:
                    preempted_ids.append(platform.current_task.task_id)
                    self._preempt_platform(platform)
                if platform.id not in task.assigned_platform_ids:
                    task.assigned_platform_ids.append(platform.id)
                selected_ids.append(platform.id)
                used_platform_ids.add(platform.id)
                assignment_counts[platform.id] = (
                    assignment_counts.get(platform.id, 0) + 1
                )

            reason = self._build_reason(
                task, best_platform, best_cost, len(candidates), preempted_ids
            )
            decisions.append({
                "task_id": task.task_id,
                "task_type": task.task_type,
                "selected_platform_ids": selected_ids,
                "preempted_task_ids": preempted_ids,
                "score": best_cost["total_cost"],
                "reason": reason,
            })

        return decisions

    # ------------------------------------------------------------------
    # 硬约束与候选收集（组员 C）
    # ------------------------------------------------------------------

    def _battery_ok(self, platform) -> bool:
        """组员 C：电量比例是否达到分配阈值。"""
        threshold = BATTERY_THRESHOLD.get(
            getattr(platform, "platform_type", ""), DEFAULT_BATTERY_THRESHOLD
        )
        return battery_pct(platform) >= threshold

    def _capability_ok(self, task, platform) -> bool:
        """组员 C：平台是否具备任务所需全部可用能力。"""
        required = getattr(task, "required_capabilities", []) or []
        return all(platform.has_available_capability(c) for c in required)

    def _can_preempt(self, task, platform) -> bool:
        """组员 C：高优先级任务是否可抢占该平台当前任务。"""
        old = platform.current_task
        if old is None:
            return False
        # 无 preemptible 字段时默认允许抢占
        if hasattr(old, "preemptible") and not old.preemptible:
            return False
        return old.priority > task.priority

    def _collect_candidates(
        self, task, platforms: list, used_platform_ids: set[int]
    ) -> list[tuple]:
        """组员 C：收集 idle 与可抢占候选。

        Returns:
            [(platform, is_preempt, old_task_or_None), ...]
        """
        results: list[tuple] = []
        for platform in platforms:
            if platform.id in used_platform_ids:
                continue
            if not getattr(platform, "enabled", True):
                continue
            if not self._battery_ok(platform):
                continue
            if not self._capability_ok(task, platform):
                continue

            if platform.current_task is None:
                results.append((platform, False, None))
            elif self._can_preempt(task, platform):
                results.append((platform, True, platform.current_task))
        return results

    def _build_reason(
        self,
        task,
        platform,
        cost: dict,
        candidate_count: int,
        preempted_ids: list[int],
    ) -> str:
        """组员 C：生成可解释 reason，供 A 写入 decision_history。"""
        pct = battery_pct(platform)
        parts = [
            f"能力匹配 {getattr(task, 'required_capabilities', [])}",
            f"电量 {pct:.0f}%",
            f"time={cost.get('time_cost', 0):.1f}",
            f"energy={cost.get('energy_cost', 0):.1f}",
            f"comm={cost.get('communication_cost', 0):.1f}",
            f"load={cost.get('load_cost', 0):.1f}",
            f"综合代价 {cost.get('total_cost', 0):.2f} 为候选最低（共 {candidate_count} 个候选）",
        ]
        if preempted_ids:
            parts.insert(1, f"抢占低优先级任务 {preempted_ids}")
        return "，".join(parts)

    # ------------------------------------------------------------------
    # 抢占与充电（保留仓库约定）
    # ------------------------------------------------------------------

    def _resolve_target(self, task, situation=None) -> tuple:
        """组员 C：解析任务目标坐标（委托 cost_model）。"""
        return resolve_target(task, situation)

    def _preempt_platform(self, platform):
        """抢占平台：从旧任务中移除该平台。

        仅操作 task.assigned_platform_ids，不写入 platform.current_task。
        状态变更由 TaskTracker.step() 统一处理。
        """
        old_task = platform.current_task
        if old_task is None:
            return
        if platform.id in old_task.assigned_platform_ids:
            old_task.assigned_platform_ids.remove(platform.id)

    def _allocate_charge(
        self,
        task,
        platforms: list,
        situation,
        used_platform_ids: set[int],
        relay_platforms: list,
    ) -> dict | None:
        """组员 C：分配充电任务（保留仓库 ChargeTask 约定）。

        约定：
        - assigned_platform_ids 中仅包含需要充电的 UAV ID
        - charger UGV 通过 charger_platform_id 标识，不写入 assigned_platform_ids
        - charger UGV 的 current_task 不受 ChargeTask 影响
        """
        charger_candidates = [
            p for p in platforms
            if p.platform_type == "ugv"
            and p.has_available_capability("charger")
            and p.id not in used_platform_ids
        ]
        if not charger_candidates:
            return None

        uav_platform = None
        for p in platforms:
            if p.id == task.target_entity_id:
                uav_platform = p
                break
        if uav_platform is None:
            return None

        # 多目标评分选最近且综合代价最低的 UGV（相对 UAV 位置）
        scored = []
        for charger in charger_candidates:
            # 用到 UAV 的距离近似时间/能耗；ChargeTask 目标实体为 UAV
            cost = calculate_cost(
                task,
                charger,
                situation,
                relay_platforms=relay_platforms,
            )
            # 叠加到 UAV 的距离，避免选过远 UGV
            dist_to_uav = charger.distance_to(uav_platform)
            scored.append((charger, cost, dist_to_uav))

        scored.sort(key=lambda item: (item[1]["total_cost"], item[2]))
        charger, best_cost, _ = scored[0]

        task.charger_platform_id = charger.id
        if uav_platform.id not in task.assigned_platform_ids:
            task.assigned_platform_ids.append(uav_platform.id)
        # UAV 占用本轮（避免再被分给其他任务）；charger 不占用
        used_platform_ids.add(uav_platform.id)

        return {
            "task_id": task.task_id,
            "task_type": task.task_type,
            "selected_platform_ids": [uav_platform.id],
            "preempted_task_ids": [],
            "score": best_cost["total_cost"],
            "reason": (
                f"UAV#{uav_platform.id} 需要换电，"
                f"UGV#{charger.id} 具备 charger 能力且综合代价最低 "
                f"({best_cost['total_cost']:.2f})"
            ),
        }
