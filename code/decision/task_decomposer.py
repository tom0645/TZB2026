"""将无法直接执行的实体任务分解为局部重搜索或支援任务。"""

from math import hypot

from task.tasks import (
    EntityTask,
    InterceptTask,
    MedicalDeliveryTask,
    ReconTask,
    RescueTask,
)


class TaskDecomposer:
    """任务分解器：只返回子任务，不修改任务状态。"""

    def decompose(self, task, situation, active_tasks: list) -> list:
        if not isinstance(task, EntityTask):
            return []

        entity = situation.get_entity(task.target_entity_id)
        if entity is None or not entity.discovered or self._is_stale(entity, situation):
            return self._build_reacquisition_task(
                task, entity, situation, active_tasks,
            )

        if isinstance(task, RescueTask):
            if not entity.extra.get("injured", False):
                return []
            if self._has_task_for(
                    task.target_entity_id, MedicalDeliveryTask, active_tasks):
                return []
            child = MedicalDeliveryTask(
                task.target_entity_id,
                last_known_position=entity.position,
            )
            child.parent_task_id = task.task_id
            child.trigger_key = f"medical:{task.target_entity_id}"
            child.trigger_reason = "救援目标需要医疗支援"
            return [child]

        if isinstance(task, MedicalDeliveryTask):
            if entity.extra.get("rescued", False):
                return []
            if self._has_task_for(
                    task.target_entity_id, RescueTask, active_tasks):
                return []
            child = RescueTask(
                task.target_entity_id,
                last_known_position=entity.position,
            )
            child.parent_task_id = task.task_id
            child.trigger_key = f"rescue:{task.target_entity_id}"
            child.trigger_reason = "医疗目标仍需转移救援"
            return [child]

        return []

    def _build_reacquisition_task(self, task, entity, situation, active_tasks):
        if self._has_recon_task_for(task.task_id, active_tasks):
            return []
        area = self._build_reacquisition_area(task, entity, situation)
        if area is None:
            return []

        child = ReconTask(
            area=area,
            required_coverage=0.8,
            priority=max(0, task.priority - 1),
            target_entity_type=self._target_entity_type(task, entity),
            priority_threshold=0.1,
            source_task_id=task.task_id,
        )
        child.parent_task_id = task.task_id
        child.trigger_key = f"reacquire:{task.task_id}"
        child.trigger_reason = f"任务目标 {task.target_entity_id} 态势缺失或过期"
        return [child]

    @staticmethod
    def _is_stale(entity, situation) -> bool:
        """超过 30 秒未更新的目标需要重新搜索。"""
        current_time = float(getattr(situation.world, "time", 0.0))
        return current_time - float(entity.timestamp) > 30.0

    @staticmethod
    def _has_task_for(entity_id: int, task_type: type, active_tasks: list) -> bool:
        return any(
            isinstance(candidate, task_type)
            and getattr(candidate, "target_entity_id", None) == entity_id
            for candidate in active_tasks
        )

    @staticmethod
    def _build_reacquisition_area(task, entity, situation):
        position = getattr(task, "last_known_position", None)
        velocity = (0.0, 0.0)
        age = 0.0
        if entity is not None:
            position = entity.position
            velocity = entity.velocity
            age = max(0.0, float(situation.world.time) - float(entity.timestamp))
        if position is None:
            return None

        center = (
            position[0] + velocity[0] * age,
            position[1] + velocity[1] * age,
        )
        uncertainty = hypot(*velocity) * age
        radius = min(
            2000.0,
            max(500.0, float(situation.resolution) * 10.0, uncertainty * 1.5),
        )
        return (
            max(0.0, center[0] - radius),
            max(0.0, center[1] - radius),
            min(float(situation.scene_width), center[0] + radius),
            min(float(situation.scene_height), center[1] + radius),
        )

    @staticmethod
    def _has_recon_task_for(source_task_id: int, active_tasks: list) -> bool:
        return any(
            isinstance(candidate, ReconTask)
            and candidate.source_task_id == source_task_id
            for candidate in active_tasks
        )

    @staticmethod
    def _target_entity_type(task, entity) -> str:
        declared_type = getattr(task, "target_entity_type", None)
        if declared_type:
            return declared_type
        if entity is not None:
            if entity.entity_type in ("person", "victim", "intruder", "suspect"):
                return "person"
            return entity.entity_type
        if isinstance(task, (MedicalDeliveryTask, RescueTask)):
            return "person"
        if isinstance(task, InterceptTask):
            return "aerial"
        return "person"
