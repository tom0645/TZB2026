"""任务跟踪器 —— 任务的纯生命周期管理器。

不生成任务，不决定"该做什么"。只负责：
- 接收来自决策系统和人工干预的任务注入
- 跟踪每个任务的状态（pending / active / completed / failed / cancelled）
- 判定任务完成条件（查询态势层）
- 向决策系统提供当前 active 任务列表
- 统一同步 platform.current_task（从 task.assigned_platform_ids 映射）
"""

from task.tasks import Task, TaskStatus


class TaskTracker:
    """任务跟踪器：纯生命周期管理器。通过 self.world 访问态势层和全局时间。

    platform.current_task 的唯一写入者：
    每帧 step() 末尾根据所有 PENDING/ACTIVE 任务的 assigned_platform_ids
    统一同步到平台，不再由 PlatformAllocator 直接写入。
    """

    def __init__(self, world: "World"):  # type: ignore[name-defined]
        self.world = world
        self.tasks: dict[int, Task] = {}   # task_id → Task，扁平字典

    def inject(self, task: Task):
        """注入新任务。由决策系统或人工调用。"""
        task.created_time = self.world.time
        task.status = TaskStatus.PENDING
        self.tasks[task.task_id] = task
        print(f"[任务] 注入 {task.brief()} 优先级={task.priority} 需要能力={task.required_capabilities}")

    def cancel(self, task_id: int):
        """取消任务（人工调用）"""
        task = self.tasks.get(task_id)
        if task is not None and task.status in (TaskStatus.PENDING, TaskStatus.ACTIVE):
            task.status = TaskStatus.CANCELLED
            print(f"[任务] 取消 {task.brief()}")

    def reprioritize(self, task_id: int, priority: int):
        """调整任务优先级（人工调用）"""
        task = self.tasks.get(task_id)
        if task is not None:
            old = task.priority
            task.priority = priority
            print(f"[任务] 调整优先级 {task.brief()} {old} → {priority}")

    def get_active(self) -> list[Task]:
        """返回所有 pending + active 任务列表（供决策系统使用）"""
        return [t for t in self.tasks.values()
                if t.status in (TaskStatus.PENDING, TaskStatus.ACTIVE)]

    def get_all(self) -> list[Task]:
        """返回全部任务（含已完成、失败，供效能评估器使用）"""
        return list(self.tasks.values())

    def get_tasks_by_type(self, task_type: type) -> list[Task]:
        """按类型筛选任务"""
        return [t for t in self.tasks.values() if isinstance(t, task_type)]

    def has_active_task_for_entity(self, entity_id: int, task_type: type) -> bool:
        """检查是否已有针对指定实体的激活任务（某类型）"""
        for t in self.tasks.values():
            if t.status not in (TaskStatus.PENDING, TaskStatus.ACTIVE):
                continue
            if isinstance(t, task_type):
                if getattr(t, 'target_entity_id', None) == entity_id:
                    return True
        return False

    def step(self):
        """每帧检查所有 active 任务的完成条件、超时和抢占释放。

        末尾统一同步 platform.current_task：
        遍历所有 PENDING/ACTIVE 任务的 assigned_platform_ids，
        将所有平台引用写入正确值，已释放的平台自动清空。
        """
        situation = self.world.situation
        for task in self.tasks.values():
            if task.status != TaskStatus.ACTIVE:
                continue

            # 抢占检测：ACTIVE 但执行平台不足（被高优先级任务抢走）→ 退回 PENDING
            if len(task.assigned_platform_ids) < task.required_platforms:
                task.status = TaskStatus.PENDING
                print(f"[任务] 平台不足退回 PENDING {task.brief()} 已分配={len(task.assigned_platform_ids)} 需要={task.required_platforms}")
                continue

            # 超时检查
            if task.deadline is not None and self.world.time >= task.deadline:
                task.status = TaskStatus.FAILED
                print(f"[任务] 超时失败 {task.brief()} deadline={task.deadline:.1f}s now={self.world.time:.1f}s")
                continue

            # 完成条件检查（裁判系统判定）
            if task.is_completed(situation):
                task.status = TaskStatus.COMPLETED
                print(f"[任务] 完成 {task.brief()}")

        # 统一同步：将所有 PENDING/ACTIVE 任务的 assigned_platform_ids 映射到 platform.current_task
        self._sync_platform_current_task()

    def activate_task(self, task_id: int):
        """将 pending 任务标记为 active（由决策系统在分配平台后调用）。

        assigned_platform_ids 由 PlatformAllocator 写入，此处仅翻转状态。
        platform.current_task 由 step() 末尾的 _sync_platform_current_task() 统一同步。
        """
        task = self.tasks.get(task_id)
        if task is not None and task.status == TaskStatus.PENDING:
            task.status = TaskStatus.ACTIVE
            print(f"[任务] 激活 {task.brief()} 已分配平台={task.assigned_platform_ids}")

    def _sync_platform_current_task(self):
        """将所有 PENDING/ACTIVE 任务的 assigned_platform_ids 同步到 platform.current_task。

        构建 platform_id → Task 映射后，遍历所有己方平台统一写入：
        - 在 assigned_platform_ids 中的 → 写入对应 Task
        - 不在任何 assigned_platform_ids 中的 → 清空为 None

        注意：ChargeTask 的 charger UGV 不在此同步中 ——
        ChargeTask 只分配给 UAV，UGV 仅作为停机坪被 UAV 通过 charger_platform_id 查找，
        UGV 可以同时服务多个 UAV 并继续执行其他任务。
        """
        situation = self.world.situation

        # 构建 platform_id → Task 的同步映射（仅 active/pending 任务）
        assignment: dict[int, Task] = {}
        for task in self.tasks.values():
            if task.status not in (TaskStatus.PENDING, TaskStatus.ACTIVE):
                continue
            for pid in task.assigned_platform_ids:
                assignment[pid] = task

        # 同步所有平台
        for platform in situation.platforms.values():
            expected = assignment.get(platform.id, None)
            if platform.current_task is not expected:
                platform.current_task = expected
