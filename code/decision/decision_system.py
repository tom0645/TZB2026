"""决策系统 —— 指控系统核心。

持有 world 引用，通过 self.world.situation 和 self.world.task_tracker 访问态势和任务。
仿真和真实部署代码完全一致。

每帧执行：
1. 反应规则：检查态势变化，生成新任务注入 TaskTracker
2. 任务分解：对 active 任务中无法直接执行的，拆分为子任务链
3. 平台分配：按优先级和能力需求，为可执行任务匹配平台并下达
"""


class DecisionSystem:
    """决策系统：通过 world 引用访问态势层、任务跟踪器和平台列表。

    构造时从 world.config 读取反应规则。初始任务由 World 通过 task_schedule 注入。
    """

    def __init__(self, world: "World"):  # type: ignore[name-defined]
        self.world = world
        self.rules = world.config.reaction_rules or []
        self.allocator = None    # 延迟导入以避免循环引用
        self.decomposer = None   # 延迟导入以避免循环引用
        # 供 Demo、回放和验收查询的决策事件；不参与任务状态机。
        self.decision_history: list[dict] = []
        # 未分配任务仅在首次出现或分配状态变化时记录，避免每帧重复输出。
        self._unassigned_signatures: dict[int, tuple[tuple[int, ...], int]] = {}

    def step(self):
        """每帧执行：反应规则 → 分解 → 分配"""
        self._evaluate_rules()
        self._decompose_tasks()
        self._allocate_tasks()

    def get_decision_history(self) -> list[dict]:
        """返回决策历史副本，供 Demo 和评估展示使用。"""
        return [
            {
                **record,
                "selected_platform_ids": list(record["selected_platform_ids"]),
                "preempted_task_ids": list(record["preempted_task_ids"]),
            }
            for record in self.decision_history
        ]

    def _evaluate_rules(self):
        """评估所有反应规则，生成新任务"""
        situation = self.world.situation
        active_tasks = self.world.task_tracker.get_active()

        for rule in self.rules:
            triggered = rule.find_triggered(situation, active_tasks)
            if triggered:
                new_tasks = rule.generate(triggered, situation)
                for task in new_tasks:
                    self.world.task_tracker.inject(task)

    def _decompose_tasks(self):
        """检查 active 任务是否需要分解"""
        if self.decomposer is None:
            from decision.task_decomposer import TaskDecomposer
            self.decomposer = TaskDecomposer()

        situation = self.world.situation
        active_tasks = self.world.task_tracker.get_active()

        for task in list(active_tasks):
            sub_tasks = self.decomposer.decompose(task, situation, active_tasks)
            for sub in sub_tasks:
                self.world.task_tracker.inject(sub)

    def _allocate_tasks(self):
        """为 pending 任务分配平台"""
        if self.allocator is None:
            from decision.platform_allocator import PlatformAllocator
            self.allocator = PlatformAllocator()

        from task.tasks import TaskStatus
        situation = self.world.situation
        pending_tasks = [t for t in self.world.task_tracker.get_active()
                         if t.status == TaskStatus.PENDING]

        if not pending_tasks:
            self._unassigned_signatures.clear()
            return

        platforms = [platform for platform in situation.platforms.values()
                     if platform.enabled]

        decisions = self.allocator.allocate(pending_tasks, platforms, situation)
        self._record_allocation_results(decisions, pending_tasks)

        # 通过 assigned_platform_ids 判断是否已分配足够平台，满足条件则激活任务
        for task in pending_tasks:
            if len(task.assigned_platform_ids) >= task.required_platforms:
                self.world.task_tracker.activate_task(task.task_id)

    def _record_allocation_results(self, decisions: list[dict], pending_tasks: list):
        """记录并输出本轮分配结果及未满足平台数量的任务。"""
        for decision in decisions:
            self._append_decision({
                "time": float(self.world.time),
                "outcome": "assigned",
                **decision,
            })

        current_unassigned: dict[int, tuple[tuple[int, ...], int]] = {}
        for task in pending_tasks:
            assigned_ids = tuple(sorted(task.assigned_platform_ids))
            required_count = int(task.required_platforms)
            if len(assigned_ids) >= required_count:
                continue

            signature = (assigned_ids, required_count)
            current_unassigned[task.task_id] = signature
            if self._unassigned_signatures.get(task.task_id) == signature:
                continue

            self._append_decision({
                "time": float(self.world.time),
                "outcome": "unassigned",
                "task_id": task.task_id,
                "task_type": task.task_type,
                "selected_platform_ids": list(assigned_ids),
                "preempted_task_ids": [],
                "score": None,
                "reason": (
                    f"分配未满足平台数量：已分配 {len(assigned_ids)}，"
                    f"需要 {required_count}；可能受能力、电量、平台占用或抢占限制"
                ),
            })

        self._unassigned_signatures = current_unassigned

    def _append_decision(self, record: dict):
        """追加单条决策事件，并输出适合终端 Demo 的摘要。"""
        self.decision_history.append(record)
        outcome = "已分配" if record["outcome"] == "assigned" else "未分配"
        print(
            f"[决策 T={record['time']:.0f}s] {outcome} "
            f"{record['task_type']}#{record['task_id']} "
            f"平台={record['selected_platform_ids']}；{record['reason']}"
        )
