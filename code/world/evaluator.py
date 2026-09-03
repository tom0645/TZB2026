"""效能评估器 —— 基于全局真值做终局判定和指标统计（仅仿真）。

仿真结束时调用。World 本身持有所有实体的真实状态，是唯一的真值来源。
评估器通过 world.entities 和 world.situation.coverage 读取真值，
而非通过 SituationManager 的态势副本，确保评估结果不受通信/感知限制影响。
"""


class Evaluator:
    """效能评估器：基于 World（全局真值）做终局判定和指标统计。"""

    def evaluate(self, world: "World", task_tracker=None) -> dict:  # type: ignore[name-defined]
        """
        Args:
            world: World 实例，作为全局真值来源
            task_tracker: TaskTracker 实例，提供任务日志
        Returns:
            评估报告字典
        """
        if task_tracker is None:
            task_tracker = world.task_tracker

        # === 任务完成统计 ===
        all_tasks = task_tracker.get_all()
        from task.tasks import TaskStatus
        completed = sum(1 for t in all_tasks if t.status == TaskStatus.COMPLETED)
        failed = sum(1 for t in all_tasks if t.status == TaskStatus.FAILED)
        total = len(all_tasks)

        # === 全局目标判定 ===
        global_goal_met = self._check_global_goal(world)

        # === 基本报告 ===
        report = {
            "scene_name": world.config.name,
            "total_duration": world.time,
            "task_total": total,
            "task_completed": completed,
            "task_failed": failed,
            "task_completion_rate": completed / total if total > 0 else 0.0,
            "global_goal_met": global_goal_met,
            "score": 0.0,
        }

        # === 场景特定评估 ===
        goal_type = world.config.global_goal.goal_type if world.config.global_goal else ""

        if goal_type == "rescue":
            report.update(self._evaluate_rescue(world))
        elif goal_type == "border_patrol":
            report.update(self._evaluate_border_patrol(world))
        elif goal_type == "area_control":
            report.update(self._evaluate_area_control(world))

        # === 评分 ===
        report["score"] = self._calculate_score(report)

        return report

    @staticmethod
    def _get_border_hostiles(world) -> list:
        """返回边境场景已生成的敌对目标，设施异常不属于拦截统计分母。"""
        hostiles = []
        for entity in world.entities.values():
            entity_type = getattr(entity, "entity_type", "")
            role = getattr(entity, "role", None)
            is_hostile = (
                entity_type in ("intruder", "hostile_uav", "aerial", "vehicle")
                or (entity_type == "person" and role in ("intruder", "suspect"))
            )
            if is_hostile:
                hostiles.append(entity)
        return hostiles

    def _check_global_goal(self, world) -> bool:
        """检查全局目标是否达成"""
        goal = world.config.global_goal
        if goal is None:
            return True

        if goal.goal_type == "rescue":
            min_rescued = goal.params.get("min_rescued", 4)
            rescued_count = sum(1 for e in world.entities.values()
                               if getattr(e, 'rescued', False))
            return rescued_count >= min_rescued

        elif goal.goal_type == "border_patrol":
            hostiles = self._get_border_hostiles(world)
            facilities = [
                entity for entity in world.entities.values()
                if getattr(entity, "entity_type", "") == "facility"
            ]

            # 短时仿真中威胁尚未生成时不能提前宣告边境成功。
            if not hostiles:
                return False

            # 边境成功必须同时满足：所有已出现威胁均被处置、没有逃逸、
            # 且场景中已出现的设施异常都已修复。
            no_escape = not any(getattr(entity, "escaped", False) for entity in hostiles)
            all_neutralized = all(
                getattr(entity, "neutralized", False) for entity in hostiles
            )
            all_repaired = all(
                getattr(entity, "repaired", False) for entity in facilities
            )
            return no_escape and all_neutralized and all_repaired

        elif goal.goal_type == "area_control":
            max_intrusions = goal.params.get("max_intrusions", 0)
            # 检查核心区入侵次数（由实体内部记录或评估时统计）
            core_violations = sum(1 for e in world.entities.values()
                                 if getattr(e, 'core_violated', False))
            return core_violations <= max_intrusions

        return True

    def _evaluate_rescue(self, world) -> dict:
        """搜救场景评估"""
        victims = [e for e in world.entities.values()
                   if hasattr(e, 'role') and getattr(e, 'role', '') == 'victim']
        rescued = [v for v in victims if getattr(v, 'rescued', False)]
        deceased = [v for v in victims if getattr(v, 'survival_time', 0) <= 0]

        return {
            "victim_total": len(victims),
            "rescued_count": len(rescued),
            "deceased_count": len(deceased),
            "rescue_rate": len(rescued) / len(victims) if victims else 0.0,
            "survival_rate": (len(victims) - len(deceased)) / len(victims) if victims else 0.0,
        }

    def _evaluate_border_patrol(self, world) -> dict:
        """边境巡检场景评估：仅以敌对目标计算拦截率。"""
        hostiles = self._get_border_hostiles(world)
        intercepted = [
            target for target in hostiles if getattr(target, "neutralized", False)
        ]
        escaped = [
            target for target in hostiles if getattr(target, "escaped", False)
        ]
        unresolved = [
            target for target in hostiles
            if not getattr(target, "neutralized", False)
            and not getattr(target, "escaped", False)
        ]
        facilities = [
            entity for entity in world.entities.values()
            if getattr(entity, "entity_type", "") == "facility"
        ]
        repaired = [
            facility for facility in facilities
            if getattr(facility, "repaired", False)
        ]

        return {
            # 保留 target_total 键以兼容 main.py 的既有展示，
            # 其含义在边境场景中明确为 hostile_total。
            "target_total": len(hostiles),
            "hostile_total": len(hostiles),
            "intercepted_count": len(intercepted),
            "escaped_count": len(escaped),
            "unresolved_hostile_count": len(unresolved),
            "facility_total": len(facilities),
            "repaired_facility_count": len(repaired),
            "intercept_rate": len(intercepted) / len(hostiles) if hostiles else 0.0,
            "facility_repair_rate": len(repaired) / len(facilities) if facilities else 0.0,
        }

    def _evaluate_area_control(self, world) -> dict:
        """区域封控场景评估"""
        aerials = [e for e in world.entities.values()
                   if getattr(e, 'entity_type', '') == 'aerial']
        neutralized = [a for a in aerials if getattr(a, 'neutralized', False)]
        cleared = [a for a in neutralized if getattr(a, 'debris_cleared', False)]
        core_violations = sum(
            1 for entity in world.entities.values()
            if getattr(entity, "core_violated", False)
        )

        return {
            "aerial_total": len(aerials),
            "neutralized_count": len(neutralized),
            "debris_cleared_count": len(cleared),
            "neutralize_rate": len(neutralized) / len(aerials) if aerials else 0.0,
            "debris_clear_rate": len(cleared) / len(aerials) if aerials else 0.0,
            "core_violation_count": core_violations,
        }

    def _calculate_score(self, report: dict) -> float:
        """计算综合评分（0-100）"""
        score = 0.0

        # 任务完成率（权重 40%）
        score += report.get("task_completion_rate", 0.0) * 40

        # 全局目标（权重 40%）
        if report.get("global_goal_met", False):
            score += 40

        # 场景特定加分（权重 20%）
        rescue_rate = report.get("rescue_rate", 0.0)
        intercept_rate = report.get("intercept_rate", 0.0)
        neutralize_rate = report.get("neutralize_rate", 0.0)
        best_rate = max(rescue_rate, intercept_rate, neutralize_rate)
        score += best_rate * 20

        return min(score, 100.0)
