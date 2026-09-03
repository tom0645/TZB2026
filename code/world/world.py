"""世界模型（World）—— 仿真的驱动器。

读取场景定义，管理实体生命周期，按帧驱动所有子系统。
后端差异（matplotlib / headless / UE / 实机）封装在 tick() 内部。
"""


class World:
    """统一世界模型。

    读取场景配置，管理实体生命周期，驱动态势、任务、决策系统。
    实体和核心系统不感知后端。
    """

    def __init__(self, config, backend: str = "headless"):
        """
        Args:
            config: SceneConfig 实例
            backend: 后端类型 "headless" / "matplotlib" / "ue" / "reality"
        """
        from scene.scene_config import SceneConfig
        assert isinstance(config, SceneConfig), "config 必须是 SceneConfig 类型"

        # === 场景参数 ===
        self.config = config
        self.width = config.width
        self.height = config.height
        self.resolution = config.resolution
        self.dt = config.dt
        self.max_duration = config.max_duration
        self.backend = backend

        # === 时间 ===
        self.time: float = 0.0

        # === 实体管理 ===
        self.entities: dict[int, "BaseEntity"] = {}  # type: ignore[name-defined]
        self._next_entity_id: int = 0
        self._pending_spawns: list[tuple[float, "BaseEntity"]] = sorted(  # type: ignore[name-defined]
            config.spawn_schedule, key=lambda x: x[0]
        )

        # 任务日程表（与 spawn_schedule 模式一致）
        self._pending_tasks: list[tuple[float, object]] = sorted(
            config.task_schedule, key=lambda x: x[0]
        )

        # === 核心系统（所有后端共用） ===
        from situation.situation_manager import SituationManager
        from task.task_tracker import TaskTracker
        from decision.decision_system import DecisionSystem

        self.situation = SituationManager(self)
        self.task_tracker = TaskTracker(self)
        self.decision_system = DecisionSystem(self)

        # === 后端桥接 ===
        self._bridge = self._create_backend_bridge()

        # === 渲染器（仅 matplotlib 后端） ===
        self.renderer = None
        if self.backend == "matplotlib":
            from world.matplotlib_renderer import MatplotlibRenderer
            self.renderer = MatplotlibRenderer(self, interval=1.0)

    def _create_backend_bridge(self):
        """根据后端类型创建桥接器。纯 Python 路径不需要桥接。"""
        if self.backend == "ue":
            from world.backend_bridge import BackendBridge
            return BackendBridge()  # 占位
        elif self.backend == "reality":
            from world.backend_bridge import BackendBridge
            return BackendBridge()  # 占位
        return None

    # === 实体生命周期 ===

    def add_entity(self, entity):
        """将实体加入世界。赋值全局唯一 ID，注入 world 引用。"""
        entity.id = self._next_entity_id
        self._next_entity_id += 1
        entity.world = self
        self.entities[entity.id] = entity

        # 如果是平台，注册到态势层
        from entity.platform_entity import PlatformEntity
        if isinstance(entity, PlatformEntity):
            self.situation.register_platform(entity)

    def _spawn_due_entities(self):
        """生成当前时刻到期的待加入实体"""
        while self._pending_spawns and self._pending_spawns[0][0] <= self.time:
            _, entity = self._pending_spawns.pop(0)
            self.add_entity(entity)

    def _inject_due_tasks(self):
        """注入当前时刻到期的日程任务。
        
        与 spawn_schedule 模式一致：在指定时刻将任务注入 TaskTracker，
        T=0 为初始任务，后续时刻为模拟人工干预。
        后续由决策系统的分配器按优先级正常分配。
        """
        while self._pending_tasks and self._pending_tasks[0][0] <= self.time:
            _, task = self._pending_tasks.pop(0)
            self.task_tracker.inject(task)

    # === 实体查询接口（供实体 update 使用） ===

    def get_entities_in_range(self, pos: tuple[float, float], radius: float) -> list:
        """查询指定位置半径内的所有实体。O(n) 遍历，适合当前实体规模。"""
        result = []
        r2 = radius * radius
        for entity in self.entities.values():
            if not entity.enabled:
                continue
            dx = entity.position[0] - pos[0]
            dy = entity.position[1] - pos[1]
            if dx * dx + dy * dy <= r2:
                result.append(entity)
        return result

    def get_platforms(self) -> list:
        """获取所有己方平台"""
        from entity.platform_entity import PlatformEntity
        return [e for e in self.entities.values()
                if isinstance(e, PlatformEntity) and e.enabled]

    def get_targets(self) -> list:
        """获取所有目标实体（非平台、非线索）"""
        from entity.platform_entity import PlatformEntity
        from entity.cue_entity import CueEntity
        return [e for e in self.entities.values()
                if not isinstance(e, PlatformEntity) and not isinstance(e, CueEntity)
                and e.enabled]

    # === 每帧驱动 ===

    def tick(self):
        """执行一帧仿真。

        流程：
            1. 按时间表加入到期实体
            2. 后端同步（UE / 实机：从外部拉取平台位置）
            3. 控制决策（所有后端统一）
            4. 运动执行（仅 Python 后端）
            5. 实体状态（所有后端统一：感知 + 状态变更 + 传感器探测）
            6. TaskTracker 检查完成条件
            7. 决策系统（反应规则 + 分解 + 分配）
        """
        # 1. 按时间表加入实体
        self._spawn_due_entities()

        # 1.5. 定时任务注入（模拟人工干预）
        self._inject_due_tasks()

        # 2. 后端同步
        if self._bridge is not None:
            self._bridge.sync_from_backend(self)

        # 3. 控制决策（所有后端统一）
        for entity in list(self.entities.values()):
            if entity.enabled:
                entity.update_control(self.dt)

        # 4. 运动执行（仅 Python 后端）
        if self._bridge is None:
            for entity in list(self.entities.values()):
                if entity.enabled:
                    entity.update_movement(self.dt)

        # 5. 实体状态（所有后端统一）
        for entity in list(self.entities.values()):
            if not entity.enabled:
                continue
            entity.update_state(self.dt)

        # 5.5. 同步已发现目标的态势快照（仿真简化：假设已发现目标可被持续跟踪）
        self.situation.sync_discovered_entities()

        # 6. TaskTracker 检查 active 任务完成条件
        self.task_tracker.step()

        # 7. 决策系统
        self.decision_system.step()

        self.time += self.dt

        # 8. 渲染（仅 matplotlib 后端）
        if self.renderer is not None:
            self.renderer.render(self)
