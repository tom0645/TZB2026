"""Web 仿真会话服务。

该模块只负责把现有 ``World`` 暴露给前端，不复制仿真规则。网页的运行、
暂停和单步操作最终都会调用同一个 ``World.tick()``，因此地图上的平台、
目标、任务和指标来自真实仿真状态，而不是另一套演示逻辑。

启动方式：
    python -m uvicorn web_api:app --app-dir code --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import asyncio
import contextlib
import io
import math
import random
import threading
import time
import sys
from collections import deque
from pathlib import Path
from typing import Any, Literal

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


CODE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = CODE_DIR.parent
FRONTEND_DIR = PROJECT_DIR / "frontend"
if str(CODE_DIR) not in sys.path:
    sys.path.insert(0, str(CODE_DIR))


PHASES = (
    ("spawn", "实体生成"),
    ("control", "控制决策"),
    ("movement", "运动执行"),
    ("sensing", "态势感知"),
    ("judge", "任务裁判"),
    ("decision", "反应决策"),
    ("render", "状态推送"),
)

TASK_LABELS = {
    "ReconTask": "区域侦察", "DiscoverTask": "目标发现", "ArriveTask": "到达指定点",
    "RescueTask": "人员救援", "MedicalDeliveryTask": "医疗投送", "InterceptTask": "目标拦截",
    "RepairTask": "设施维修", "ChargeTask": "补能换电", "GuardTask": "区域警戒",
    "ClearTask": "残骸清理", "OccupyTask": "区域驻留",
}
ENTITY_LABELS = {
    "victim": "待救援人员", "person": "人员目标", "intruder": "越境人员", "suspect": "可疑人员",
    "facility": "设施异常", "aerial": "空中目标", "vehicle": "可疑车辆", "hostile_uav": "可疑无人机",
}
CAPABILITY_LABELS = {
    "sensor": "感知搜索", "effector": "目标处置", "medical": "医疗投送", "rescue": "人员救援",
    "maintenance": "设施维修", "charger": "补能换电", "relay": "通信中继", "debris_clear": "残骸清理",
}


class SceneRequest(BaseModel):
    scene: Literal["rescue", "border", "area"] = "rescue"


class SpeedRequest(BaseModel):
    speed: float = Field(default=1.0, ge=0.25, le=16.0)


class ReprioritizeRequest(BaseModel):
    priority: int = Field(ge=0, le=100)


class TaskRequest(BaseModel):
    task_type: str
    priority: int = Field(default=10, ge=0, le=100)
    target_pos: list[float] | str | None = None
    target_entity_id: int | None = None
    target_entity_type: str | None = None
    required_count: int = Field(default=1, ge=1)
    required_platforms: int = Field(default=1, ge=1)
    required_capabilities: list[str] | str | None = None
    radius: float = Field(default=50.0, gt=0)
    hold_time: float = Field(default=60.0, gt=0)
    area: list[float] | None = None


def _scene_builder(scene: str):
    if scene == "border":
        from scene.border_patrol import build_border_patrol_scene

        return build_border_patrol_scene
    if scene == "area":
        from scene.area_control import build_area_control_scene

        return build_area_control_scene
    from scene.search_rescue import build_search_rescue_scene

    return build_search_rescue_scene


def _status_name(status: Any) -> str:
    return getattr(status, "name", str(status))


def _number(value: Any, digits: int = 2) -> float:
    try:
        return round(float(value), digits)
    except (TypeError, ValueError):
        return 0.0


class SimulationSession:
    """单个浏览器会话对应的仿真实例和后台 tick 线程。"""

    def __init__(self, scene: str = "rescue"):
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.worker: threading.Thread | None = None
        self.scene = scene
        self.running = False
        self.speed = 1.0
        self.tick_count = 0
        # 保留足够长的事件流，前端才能提供“全程”时间线视图。
        self.events: deque[dict[str, Any]] = deque(maxlen=2000)
        self.history: deque[dict[str, Any]] = deque(maxlen=180)
        self.last_tick: dict[str, Any] = {}
        self.previous_tasks: dict[int, tuple[str, tuple[int, ...], int]] = {}
        self.previous_entities: dict[int, tuple[str, bool]] = {}
        self.target_history: dict[int, deque[list[float]]] = {}
        self.platform_motion: dict[int, dict[str, float]] = {}
        self.world = None
        self.reset(scene)
        self.worker = threading.Thread(
            target=self._run_loop,
            name="tzb-web-simulation",
            daemon=True,
        )
        self.worker.start()

    # ------------------------------------------------------------------
    # 会话控制

    def reset(self, scene: str | None = None):
        with self.lock:
            self.running = False
            self.speed = 1.0
            if scene is not None:
                self.scene = scene
            random.seed(42)
            # 每次会话从稳定的任务编号开始，便于前端回放和对比。
            from task.tasks import Task

            Task._next_id = 0
            config = _scene_builder(self.scene)()
            from world.world import World

            self.world = World(config, backend="headless")
            self.tick_count = 0
            self.events.clear()
            self.history.clear()
            self.previous_tasks = {}
            self.previous_entities = {}
            self.target_history = {}
            self.platform_motion = {}
            self.last_tick = {
                "phase": "idle",
                "phase_label": "等待运行",
                "phases": self._phase_rows({}),
                "details": {},
            }
            self._append_event("session", "会话已重置，等待运行", "cyan")

    def run(self):
        with self.lock:
            self.running = True

    def pause(self):
        with self.lock:
            self.running = False

    def set_speed(self, speed: float):
        with self.lock:
            self.speed = float(speed)

    def step_once(self):
        with self.lock:
            self._tick_locked()

    def _run_loop(self):
        while not self.stop_event.is_set():
            started = time.monotonic()
            with self.lock:
                if self.running:
                    ticks = max(1, min(16, int(round(self.speed))))
                    for _ in range(ticks):
                        if not self.running:
                            break
                        self._tick_locked()
                    interval = max(0.04, 0.24 / max(self.speed, 0.25))
                else:
                    interval = 0.12
            elapsed = time.monotonic() - started
            self.stop_event.wait(max(0.01, interval - elapsed))

    # ------------------------------------------------------------------
    # 仿真 tick 与变化记录

    def _tick_locked(self):
        world = self.world
        if world is None:
            return

        before_entities = {
            entity_id: (getattr(entity, "entity_type", "unknown"), bool(entity.enabled))
            for entity_id, entity in world.entities.items()
        }
        before_positions = {
            entity.id: tuple(entity.position)
            for entity in world.get_platforms()
        }
        before_tasks = {
            task_id: (
                _status_name(task.status),
                tuple(task.assigned_platform_ids),
                int(task.priority),
            )
            for task_id, task in world.task_tracker.tasks.items()
        }
        before_decisions = len(world.decision_system.decision_history)
        before_time = float(world.time)

        # 核心日志目前面向 CLI 输出，Web 会话将其转成结构化事件。
        with contextlib.redirect_stdout(io.StringIO()):
            world.tick()

        self.tick_count += 1
        after_entities = {
            entity_id: (getattr(entity, "entity_type", "unknown"), bool(entity.enabled))
            for entity_id, entity in world.entities.items()
        }
        new_entities = set(after_entities) - set(before_entities)

        situation_entities = world.situation.get_entities_all()
        newly_discovered = []
        for entity_id, state in situation_entities.items():
            history = self.target_history.setdefault(entity_id, deque(maxlen=90))
            history.append([_number(state.position[0], 1), _number(state.position[1], 1)])
            previous = self.previous_entities.get(entity_id)
            if previous is None or not previous[1]:
                newly_discovered.append(state)

        task_changes = []
        for task_id, task in world.task_tracker.tasks.items():
            current = (
                _status_name(task.status),
                tuple(task.assigned_platform_ids),
                int(task.priority),
            )
            previous = before_tasks.get(task_id)
            if previous is None:
                task_changes.append((task, "inject"))
            elif current[0] != previous[0]:
                task_changes.append((task, current[0].lower()))
            elif current[1] != previous[1] or current[2] != previous[2]:
                task_changes.append((task, "update"))

        for entity_id in sorted(new_entities):
            entity = world.entities[entity_id]
            label = self._entity_label(entity)
            kind = "platform" if getattr(entity, "platform_type", None) else "entity"
            self._append_event(kind, f"{label} 加入仿真", "blue" if kind == "platform" else "amber")
        for state in newly_discovered:
            self._append_event(
                "discovery",
                f"发现 {self._state_label(state)}",
                "red" if self._state_kind(state) in {"intruder", "aerial", "vehicle"} else "amber",
            )
        for task, change in task_changes:
            label = f"{TASK_LABELS.get(task.task_type, task.task_type)} #{task.task_id}"
            color = "green" if change == "completed" else "red" if change in {"failed", "cancelled"} else "cyan"
            change_label = {"completed": "已完成", "failed": "已失败", "cancelled": "已取消", "active": "开始执行", "pending": "等待分配", "update": "已更新", "inject": "已注入"}.get(change, change)
            self._append_event("task", f"{label} · {change_label}", color)

        decision_count = len(world.decision_system.decision_history) - before_decisions
        meaningful_decisions = 0
        for record in world.decision_system.decision_history[-max(0, decision_count):]:
            if record.get("outcome") == "assigned":
                selected_ids = tuple(record.get("selected_platform_ids", []))
                previous = before_tasks.get(record.get("task_id"))
                if previous is not None and tuple(previous[1]) == selected_ids:
                    continue
                meaningful_decisions += 1
                platform_types = {platform.id: platform.platform_type for platform in world.get_platforms()}
                ids = ",".join(self._platform_label(pid, platform_types.get(pid)) for pid in record.get("selected_platform_ids", []))
                self._append_event(
                    "decision",
                    f"{TASK_LABELS.get(record.get('task_type'), record.get('task_type'))} #{record.get('task_id')} 分配给 {ids or '待定'}",
                    "blue",
                )

        current_tasks = {
            task_id: (
                _status_name(task.status),
                tuple(task.assigned_platform_ids),
                int(task.priority),
            )
            for task_id, task in world.task_tracker.tasks.items()
        }
        self.previous_tasks = current_tasks
        self.previous_entities = {
            entity_id: (state.entity_type, bool(state.discovered))
            for entity_id, state in situation_entities.items()
        }

        moved_count = 0
        for platform in world.get_platforms():
            before = before_positions.get(platform.id)
            if before is not None and before != tuple(platform.position):
                moved_count += 1
            if before is not None:
                dx = float(platform.position[0]) - float(before[0])
                dy = float(platform.position[1]) - float(before[1])
                distance = math.hypot(dx, dy)
                actual_speed = distance / max(float(world.dt), 1e-6)
                motion = self.platform_motion.setdefault(platform.id, {})
                motion["speed"] = actual_speed
                if distance > 1e-6:
                    motion["heading"] = math.degrees(math.atan2(dy, dx)) % 360
                else:
                    motion.setdefault("heading", float(platform.heading))

        completed = sum(
            1 for task in world.task_tracker.tasks.values()
            if _status_name(task.status) == "COMPLETED"
        )
        active = len(world.task_tracker.get_active())
        coverage = self._coverage_ratio(world)
        avg_battery = self._average_battery(world)
        details = {
            "spawn": f"新增 {len(new_entities)} 个实体",
            "control": f"{len(world.get_platforms())} 个平台完成控制决策",
            "movement": f"{moved_count} 个平台发生位移",
            "sensing": f"新发现 {len(newly_discovered)} 个目标 · 覆盖 {coverage:.1f}%",
            "judge": f"完成 {completed} · 活跃 {active}",
            "decision": f"新增 {meaningful_decisions} 条有效分配",
            "render": "状态已推送到前端页面",
        }
        self.last_tick = {
            "phase": "render",
            "phase_label": "状态推送",
            "phases": self._phase_rows(details),
            "details": details,
            "before_time": before_time,
            "after_time": float(world.time),
        }
        self.history.append(
            {
                "time": _number(world.time, 1),
                "coverage": _number(coverage, 2),
                "completed": completed,
                "active": active,
                "battery": _number(avg_battery, 2),
            }
        )

    def _append_event(self, kind: str, text: str, color: str = "cyan"):
        current_time = float(self.world.time) if self.world is not None else 0.0
        self.events.append({
            "time": _number(current_time, 1),
            "kind": kind,
            "text": text,
            "color": color,
        })

    # ------------------------------------------------------------------
    # 状态序列化

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return self._snapshot_locked()

    def _snapshot_locked(self) -> dict[str, Any]:
        world = self.world
        if world is None:
            return {"simulation": {"running": False}}

        platforms = [self._platform_snapshot(platform) for platform in world.get_platforms()]
        targets = [
            self._target_snapshot(state)
            for state in world.situation.get_entities_all().values()
            if state.entity_type not in {"uav", "ugv", "cue"}
        ]
        tasks = [self._task_snapshot(task, platforms, targets) for task in world.task_tracker.get_all()]
        metrics = self._metrics(world, platforms, targets, tasks)
        evaluation = self._evaluation_snapshot(world, metrics)
        return {
            "simulation": {
                "scene": self.scene,
                "scene_name": world.config.name,
                "running": self.running,
                "speed": self.speed,
                "time": _number(world.time, 1),
                "dt": _number(world.dt, 2),
                "tick": self.tick_count,
                "duration": _number(world.max_duration, 1),
                "phase": self.last_tick.get("phase", "idle"),
                "phase_label": self.last_tick.get("phase_label", "等待运行"),
            },
            "map": {
                "width": _number(world.width, 1),
                "height": _number(world.height, 1),
                "obstacles": [
                    {"center": list(obs.center), "radius": _number(obs.radius, 1)}
                    for obs in world.config.obstacles
                ],
                "roads": [
                    {"waypoints": [list(point) for point in road.waypoints]}
                    for road in world.config.roads
                ],
                "cues": self._cues(world),
                "layers": self._layers(world),
            },
            "platforms": platforms,
            "targets": targets,
            "tasks": tasks,
            "alerts": self._alerts(platforms, targets, tasks),
            "metrics": metrics,
            "evaluation": evaluation,
            "history": list(self.history),
            "flow": self.last_tick,
            "events": list(reversed(self.events)),
        }

    def _platform_snapshot(self, platform) -> dict[str, Any]:
        task = platform.current_task
        # 地图意图线必须跟随控制器真正选出的扫描航点；任务区域中心只
        # 是任务参数，并不代表当前这一帧的平台运动目标。
        target = getattr(platform, "target_position", None)
        if target is None and task is not None:
            target = getattr(task, "target_pos", None)
        if target is None and task is not None:
            target = getattr(task, "last_known_position", None)
        motion = self.platform_motion.get(platform.id, {})
        speed = float(motion.get("speed", 0.0))
        heading = float(motion.get("heading", platform.heading))
        capabilities = []
        for capability in platform.capabilities:
            stock = None
            suffix = ""
            if hasattr(capability, "stock"):
                stock = int(capability.stock)
                suffix = f"剩余 {stock} 件"
            elif hasattr(capability, "charges"):
                stock = int(capability.charges)
                suffix = f"剩余 {stock} 次"
            elif hasattr(capability, "battery_stock"):
                stock = int(capability.battery_stock)
                suffix = f"剩余 {stock} 块"
            elif hasattr(capability, "quantity"):
                suffix = f"装载 {int(capability.quantity)}/{int(capability.capacity)}"
            else:
                suffix = "可用" if capability.is_available() else "不可用"
            capabilities.append({
                "name": capability.type,
                "available": bool(capability.is_available()),
                "state": suffix,
                "stock": stock,
            })
        battery = 100.0 * platform.battery / platform.max_battery if platform.max_battery else 0.0
        return {
            "id": platform.id,
            "label": self._platform_label(platform.id, platform.platform_type),
            "type": platform.platform_type,
            "position": [_number(platform.position[0], 1), _number(platform.position[1], 1)],
            "velocity": [_number(platform.velocity[0], 2), _number(platform.velocity[1], 2)],
            "speed": _number(speed, 2),
            "heading": _number(heading, 1),
            "battery": _number(battery, 1),
            "task_id": getattr(task, "task_id", None),
            "task": f"{task.task_type} #{task.task_id}" if task is not None else "待命",
            "target": list(target) if target is not None else None,
            "intent_speed": _number(getattr(platform, "desired_speed", 0.0), 2),
            "capabilities": capabilities,
            "online": bool(platform.enabled),
            "landed_on": platform.landed_on,
            "charge_timer": _number(platform.charge_timer, 1),
        }

    def _target_snapshot(self, state) -> dict[str, Any]:
        kind = self._state_kind(state)
        extra = {
            key: value
            for key, value in (state.extra or {}).items()
            if isinstance(value, (str, int, float, bool, list, dict))
        }
        return {
            "id": state.entity_id,
            "label": self._state_label(state),
            "type": kind,
            "entity_type": state.entity_type,
            "position": [_number(state.position[0], 1), _number(state.position[1], 1)],
            "velocity": [_number(state.velocity[0], 2), _number(state.velocity[1], 2)],
            "state": self._target_status(extra, kind),
            "confidence": 1.0,
            "discovered": bool(state.discovered),
            "extra": extra,
            "timestamp": _number(state.timestamp, 1),
            "track": list(self.target_history.get(state.entity_id, [])),
        }

    def _task_snapshot(self, task, platforms, targets) -> dict[str, Any]:
        platform_map = {platform["id"]: platform["label"] for platform in platforms}
        target_map = {target["id"]: target["label"] for target in targets}
        target_entity_id = getattr(task, "target_entity_id", None)
        target_pos = getattr(task, "target_pos", None)
        if target_entity_id is not None:
            target = target_map.get(target_entity_id, f"实体 #{target_entity_id}")
        elif target_pos is not None:
            target = f"坐标 ({target_pos[0]:.0f}, {target_pos[1]:.0f})"
        elif hasattr(task, "area"):
            target = "区域侦察"
        else:
            target = "全域"
        assigned = [platform_map.get(pid, f"平台 #{pid}") for pid in task.assigned_platform_ids]
        return {
            "id": task.task_id,
            "type": task.task_type,
            "priority": task.priority,
            "status": _status_name(task.status),
            "platform": ", ".join(assigned) if assigned else "待分配",
            "platform_ids": list(task.assigned_platform_ids),
            "target": target,
            "target_entity_id": target_entity_id,
            "target_pos": list(target_pos) if target_pos is not None else None,
            "capabilities": list(task.required_capabilities),
            "created_time": _number(task.created_time, 1),
            "deadline": task.deadline,
            "trigger_reason": task.trigger_reason,
        }

    def _metrics(self, world, platforms, targets, tasks) -> dict[str, Any]:
        coverage = self._coverage_ratio(world)
        completed = sum(1 for task in tasks if task["status"] == "COMPLETED")
        failed = sum(1 for task in tasks if task["status"] == "FAILED")
        active = sum(1 for task in tasks if task["status"] in {"PENDING", "ACTIVE"})
        battery = sum(platform["battery"] for platform in platforms) / len(platforms) if platforms else 0.0
        discovered = sum(1 for target in targets if target["discovered"])
        assigned = sum(1 for platform in platforms if platform.get("task_id") is not None)
        return {
            "coverage": _number(coverage, 1),
            "completed": completed,
            "failed": failed,
            "active": active,
            "total_tasks": len(tasks),
            "completion_rate": _number(100 * completed / len(tasks), 1) if tasks else 0.0,
            "average_battery": _number(battery, 1),
            "online_platforms": sum(1 for platform in platforms if platform["online"]),
            "discovered_targets": discovered,
            "alerts_high": sum(1 for alert in self._alerts(platforms, targets, tasks) if alert["level"] == "high"),
            "assigned_platforms": assigned,
            "platform_utilization": _number(100 * assigned / len(platforms), 1) if platforms else 0.0,
        }

    def _evaluation_snapshot(self, world, metrics) -> dict[str, Any]:
        """将终局评估器的原始统计转为前端可直接绘制的场景指标。"""
        from world.evaluator import Evaluator

        report = Evaluator().evaluate(world)
        goal_type = world.config.global_goal.goal_type if world.config.global_goal else ""
        task_rate = 100.0 * float(report.get("task_completion_rate", 0.0))
        common = [
            {
                "key": "task_completion_rate",
                "label": "任务完成率",
                "value": _number(task_rate, 1),
                "display": f"{task_rate:.1f}%",
                "unit": "%",
                "target": 100,
                "tone": "cyan",
                "detail": f"{report.get('task_completed', 0)} / {report.get('task_total', 0)} 个任务",
            }
        ]
        coverage = float(metrics.get("coverage", 0.0))
        if goal_type == "rescue":
            total = int(report.get("victim_total", 0))
            rescued = int(report.get("rescued_count", 0))
            deceased = int(report.get("deceased_count", 0))
            items = [
                {"key": "coverage", "label": "搜索覆盖率", "value": _number(coverage, 1), "display": f"{coverage:.1f}%", "unit": "%", "target": 90, "tone": "blue", "detail": "全域搜索网格"},
                {"key": "rescue_rate", "label": "救援率", "value": _number(100 * float(report.get("rescue_rate", 0.0)), 1), "display": f"{100 * float(report.get('rescue_rate', 0.0)):.1f}%", "unit": "%", "target": 80, "tone": "green", "detail": f"已救援 {rescued} / {total} 人"},
                {"key": "deceased_count", "label": "伤亡人数", "value": deceased, "display": f"{deceased} 人", "unit": "人", "target": 0, "tone": "red", "lower_is_better": True, "detail": "生存时间耗尽"},
            ] + common
            headline = "救援目标已达成" if report.get("global_goal_met") else "救援任务进行中"
        elif goal_type == "border_patrol":
            hostile_total = int(report.get("hostile_total", 0))
            facility_total = int(report.get("facility_total", 0))
            intercept_rate = 100 * float(report.get("intercept_rate", 0.0))
            repair_rate = 100 * float(report.get("facility_repair_rate", 0.0))
            items = [
                {"key": "coverage", "label": "边境线覆盖率", "value": _number(coverage, 1), "display": f"{coverage:.1f}%", "unit": "%", "target": 95, "tone": "blue", "detail": "巡检区域新鲜度"},
                {"key": "intercept_rate", "label": "异常拦截率", "value": _number(intercept_rate, 1), "display": f"{intercept_rate:.1f}%", "unit": "%", "target": 100, "tone": "red", "detail": f"已拦截 {report.get('intercepted_count', 0)} / {hostile_total} 个目标"},
                {"key": "facility_repair_rate", "label": "设施修复率", "value": _number(repair_rate, 1), "display": f"{repair_rate:.1f}%", "unit": "%", "target": 100, "tone": "amber", "detail": f"已修复 {report.get('repaired_facility_count', 0)} / {facility_total} 处设施"},
                {"key": "unresolved_hostile_count", "label": "未处置目标", "value": int(report.get("unresolved_hostile_count", 0)), "display": f"{int(report.get('unresolved_hostile_count', 0))} 个", "unit": "个", "target": 0, "tone": "red", "lower_is_better": True, "detail": "尚未拦截或逃逸"},
                {"key": "escaped_count", "label": "目标逃逸次数", "value": int(report.get("escaped_count", 0)), "display": f"{int(report.get('escaped_count', 0))} 次", "unit": "次", "target": 0, "tone": "red", "lower_is_better": True, "detail": "越过防区边界"},
            ] + common
            headline = "边境目标已全部处置" if report.get("global_goal_met") else "边境巡检进行中"
        else:
            aerial_total = int(report.get("aerial_total", 0))
            neutralize_rate = 100 * float(report.get("neutralize_rate", 0.0))
            debris_rate = 100 * float(report.get("debris_clear_rate", 0.0))
            violations = int(report.get("core_violation_count", 0))
            items = [
                {"key": "coverage", "label": "外围预警覆盖率", "value": _number(coverage, 1), "display": f"{coverage:.1f}%", "unit": "%", "target": 90, "tone": "blue", "detail": "外围搜索网格"},
                {"key": "neutralize_rate", "label": "空中目标处置率", "value": _number(neutralize_rate, 1), "display": f"{neutralize_rate:.1f}%", "unit": "%", "target": 100, "tone": "red", "detail": f"已处置 {report.get('neutralized_count', 0)} / {aerial_total} 个目标"},
                {"key": "debris_clear_rate", "label": "残骸清理率", "value": _number(debris_rate, 1), "display": f"{debris_rate:.1f}%", "unit": "%", "target": 100, "tone": "amber", "detail": f"已清理 {report.get('debris_cleared_count', 0)} / {aerial_total} 处残骸"},
                {"key": "core_violation_count", "label": "核心区入侵次数", "value": violations, "display": f"{violations} 次", "unit": "次", "target": 0, "tone": "red", "lower_is_better": True, "detail": "进入核心禁入区"},
            ] + common
            headline = "核心区保持安全" if report.get("global_goal_met") else "区域封控进行中"
        return {
            "scene": self.scene,
            "scene_name": world.config.name,
            "score": _number(report.get("score", 0.0), 1),
            "goal_met": bool(report.get("global_goal_met", False)),
            "headline": headline,
            "metrics": items,
            "raw": report,
        }

    def _alerts(self, platforms, targets, tasks) -> list[dict[str, Any]]:
        alerts = []
        for target in targets:
            extra = target.get("extra", {})
            kind = target["type"]
            if kind in {"intruder", "vehicle", "aerial"} and not extra.get("neutralized", False):
                alerts.append({
                    "id": f"target-{target['id']}",
                    "level": "high",
                    "title": f"高优先级 · {target['label']}",
                    "detail": f"未处置目标 · 位置 {target['position'][0]:.0f}, {target['position'][1]:.0f}",
                    "meta": f"T+{target['timestamp']:.0f}s · 置信度 {target['confidence']:.2f}",
                    "target_id": target["id"],
                })
            elif kind == "facility" and not extra.get("repaired", False):
                alerts.append({
                    "id": f"facility-{target['id']}",
                    "level": "medium",
                    "title": f"中优先级 · {target['label']}",
                    "detail": "设施异常 · 等待现场核查",
                    "meta": f"T+{target['timestamp']:.0f}s",
                    "target_id": target["id"],
                })
            elif kind in {"victim", "person"} and not extra.get("rescued", False):
                alerts.append({
                    "id": f"victim-{target['id']}",
                    "level": "medium" if extra.get("injured", False) else "low",
                    "title": f"{'中优先级' if extra.get('injured', False) else '低优先级'} · {target['label']}",
                    "detail": "受伤人员" if extra.get("injured", False) else "待救援人员",
                    "meta": f"T+{target['timestamp']:.0f}s",
                    "target_id": target["id"],
                })
        for platform in platforms:
            if platform["type"] == "uav" and platform["battery"] <= 20:
                alerts.append({
                    "id": f"battery-{platform['id']}",
                    "level": "medium",
                    "title": f"中优先级 · {platform['label']} 低电量",
                    "detail": f"剩余电量 {platform['battery']:.0f}% · 充电任务已生成",
                    "meta": "安全阈值 20%",
                    "target_id": None,
                })
        for task in tasks:
            if task["status"] == "PENDING" and not task["platform_ids"]:
                alerts.append({
                    "id": f"task-{task['id']}",
                    "level": "low",
                    "title": "低优先级 · 任务等待分配",
                    "detail": f"{TASK_LABELS.get(task['type'], task['type'])} #{task['id']} · 所需能力 {', '.join(CAPABILITY_LABELS.get(cap, cap) for cap in task['capabilities']) or '无'}",
                    "meta": f"优先级 {task['priority']}",
                    "target_id": task.get("target_entity_id"),
                })
        return alerts[:12]

    def _layers(self, world) -> dict[str, Any]:
        coverage = world.situation.coverage.last_scan_time
        finite = np.isfinite(coverage)
        age = np.where(finite, np.maximum(world.time - coverage, 0.0), 9999.0)
        coverage_display = np.where(finite, np.clip(1.0 - age / 600.0, 0.0, 1.0), 0.0)

        entity_type = next(iter(world.config.erosion_speeds), "person")
        try:
            priority = world.situation.get_search_priority(world.time, entity_type).astype(float)
        except Exception:
            priority = np.zeros_like(coverage_display)
        max_priority = float(priority.max()) if priority.size else 0.0
        if max_priority > 0:
            priority = priority / max_priority

        passability = world.situation.passability.grid.astype(float)
        passability_display = np.where(passability == 1, 0.0, np.where(passability == 2, 1.0, 0.28))
        return {
            "width": 40,
            "height": 40,
            "coverage": self._downsample(coverage_display),
            "priority": self._downsample(priority),
            "passability": self._downsample(passability_display),
        }

    @staticmethod
    def _cues(world) -> list[dict[str, Any]]:
        """返回价值图中仍然有效的线索热源，供地图绘制。"""
        sources = []
        for index, source in enumerate(world.situation.value_map.sources, start=1):
            age = max(0.0, float(world.time) - float(source.born_time))
            confidence = float(source.peak) * 0.5 ** (age / float(source.half_life))
            if confidence < 0.01:
                continue
            sources.append({
                "id": index,
                "position": [
                    _number((source.grid_pos[0] + 0.5) * world.situation.resolution, 1),
                    _number((source.grid_pos[1] + 0.5) * world.situation.resolution, 1),
                ],
                "confidence": _number(confidence, 3),
                "radius": _number(source.sigma * 2.0 * world.situation.resolution, 1),
            })
        return sources

    @staticmethod
    def _downsample(array: np.ndarray, size: int = 40) -> list[list[float]]:
        if array.size == 0:
            return []
        y_index = np.linspace(0, array.shape[0] - 1, min(size, array.shape[0])).astype(int)
        x_index = np.linspace(0, array.shape[1] - 1, min(size, array.shape[1])).astype(int)
        sampled = array[np.ix_(y_index, x_index)]
        return np.round(np.nan_to_num(sampled, nan=0.0, posinf=0.0, neginf=0.0), 3).tolist()

    @staticmethod
    def _coverage_ratio(world) -> float:
        try:
            return 100.0 * world.situation.get_coverage_ratio((0.0, 0.0, world.width, world.height))
        except Exception:
            return 0.0

    @staticmethod
    def _average_battery(world) -> float:
        platforms = world.get_platforms()
        if not platforms:
            return 0.0
        return sum(
            100.0 * platform.battery / platform.max_battery
            if platform.max_battery else 0.0
            for platform in platforms
        ) / len(platforms)

    def _platform_label(self, platform_id: int, platform_type: str | None = None) -> str:
        """返回按平台类型独立递增的显示编号，不改变平台内部 ID。"""
        prefix = (platform_type or "platform").upper()
        world = self.world
        if world is not None and platform_type:
            candidates = [
                platform for platform in world.get_platforms()
                if getattr(platform, "platform_type", None) == platform_type
            ]
            candidates.sort(key=lambda platform: int(getattr(platform, "id", 0)))
            for index, platform in enumerate(candidates, start=1):
                if getattr(platform, "id", None) == platform_id:
                    return f"{prefix}-{index:02d}"
        try:
            fallback = int(platform_id) + 1
        except (TypeError, ValueError):
            fallback = 1
        return f"{prefix}-{fallback:02d}"

    def _entity_label(self, entity) -> str:
        if getattr(entity, "platform_type", None):
            return self._platform_label(entity.id, entity.platform_type)
        kind = getattr(entity, "role", None) or getattr(entity, "entity_type", "实体")
        return f"{ENTITY_LABELS.get(kind, kind)} #{entity.id}"

    @staticmethod
    def _state_kind(state) -> str:
        return state.extra.get("role") or state.entity_type

    def _state_label(self, state) -> str:
        kind = self._state_kind(state)
        return f"{ENTITY_LABELS.get(kind, kind)} #{state.entity_id}"

    @staticmethod
    def _target_status(extra: dict[str, Any], kind: str) -> str:
        if extra.get("neutralized"):
            return "已处置"
        if extra.get("rescued"):
            return "已救援"
        if extra.get("repaired"):
            return "已修复"
        if extra.get("injured"):
            return "受伤"
        return "跟踪中" if kind in {"intruder", "vehicle", "aerial"} else "待处置"

    @staticmethod
    def _phase_rows(details: dict[str, str]) -> list[dict[str, str]]:
        rows = []
        for phase_id, label in PHASES:
            rows.append({
                "id": phase_id,
                "label": label,
                "status": "done" if details else "queued",
                "detail": details.get(phase_id, "等待") if details else "等待",
            })
        return rows


class SimulationHub:
    """按场景保留独立会话，切换场景时不丢失已经推进的状态。"""

    def __init__(self):
        self._lock = threading.RLock()
        self._current_scene = "rescue"
        self._sessions: dict[str, SimulationSession] = {
            "rescue": SimulationSession("rescue")
        }

    @property
    def current(self) -> SimulationSession:
        return self._sessions[self._current_scene]

    def switch(self, scene: str) -> dict[str, Any]:
        with self._lock:
            if scene == self._current_scene:
                return self.current.snapshot()
            # 隐藏场景不在后台自行推进；再次切回时从暂停点继续。
            self.current.pause()
            if scene not in self._sessions:
                self._sessions[scene] = SimulationSession(scene)
            self._current_scene = scene
            return self.current.snapshot()

    def reset_current(self) -> dict[str, Any]:
        with self._lock:
            self.current.reset(self._current_scene)
            return self.current.snapshot()

    def snapshot(self) -> dict[str, Any]:
        return self.current.snapshot()

    def __getattr__(self, name: str):
        # 保持既有端点代码简洁，运行、暂停、速度等操作都转给当前场景。
        return getattr(self.current, name)


session = SimulationHub()
app = FastAPI(title="TZB2026 Simulation API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"ok": True, "service": "tzb2026-simulation", "websocket": "/ws"}


@app.get("/api/state")
def get_state():
    return session.snapshot()


@app.get("/api/context")
def get_context():
    from interaction.context_builder import build_context

    with session.lock:
        return {"context": build_context(session.world)}


@app.post("/api/session/run")
def run_session():
    session.run()
    return session.snapshot()


@app.post("/api/session/pause")
def pause_session():
    session.pause()
    return session.snapshot()


@app.post("/api/session/step")
def step_session():
    session.step_once()
    return session.snapshot()


@app.post("/api/session/switch")
def switch_session(request: SceneRequest):
    return session.switch(request.scene)


@app.post("/api/session/reset")
def reset_session(request: SceneRequest):
    # 请求中的场景仅用于前端明确表达当前对象；重置不会顺带切换场景。
    if request.scene != session.current.scene:
        return session.switch(request.scene)
    return session.reset_current()


@app.post("/api/session/speed")
def speed_session(request: SpeedRequest):
    session.set_speed(request.speed)
    return session.snapshot()


@app.post("/api/tasks/inject")
def inject_task(request: TaskRequest):
    from interaction.executor import do_inject
    from task.tasks import Task

    with session.lock:
        # World 在第一个 tick 才会生成 T=0 平台；人工任务注入需要先让
        # TaskFactory 看到这些平台，后续任务仍按正常 tick 顺序分配。
        if session.world is not None and not session.world.situation.platforms:
            session.world._spawn_due_entities()
        scheduled_ids = [
            task.task_id for _, task in session.world.config.task_schedule
            if hasattr(task, "task_id")
        ]
        tracked_ids = list(session.world.task_tracker.tasks)
        Task._next_id = max(scheduled_ids + tracked_ids, default=-1) + 1
        params = request.model_dump(exclude={"task_type", "priority"}) if hasattr(request, "model_dump") else request.dict(exclude={"task_type", "priority"})
        params["priority"] = request.priority
        message = do_inject(session.world, request.task_type, params)
        return {"ok": not message.startswith("错误"), "message": message, "state": session.snapshot()}


@app.post("/api/tasks/cancel/{task_id}")
def cancel_task(task_id: int):
    from interaction.executor import do_cancel

    with session.lock:
        message = do_cancel(session.world, task_id)
        return {"ok": message.startswith("成功"), "message": message, "state": session.snapshot()}


@app.post("/api/tasks/reprioritize/{task_id}")
def reprioritize_task(task_id: int, request: ReprioritizeRequest):
    from interaction.executor import do_reprioritize

    with session.lock:
        message = do_reprioritize(session.world, task_id, request.priority)
        return {"ok": message.startswith("成功"), "message": message, "state": session.snapshot()}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            await websocket.send_json(session.snapshot())
            await asyncio.sleep(0.25)
    except (WebSocketDisconnect, RuntimeError):
        return


if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("web_api:app", host="127.0.0.1", port=8000, reload=False)
