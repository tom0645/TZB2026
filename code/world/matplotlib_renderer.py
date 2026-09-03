"""Matplotlib 可视化渲染器 —— 2D 俯视场景实时渲染。

提供仿真过程的实时可视化，包括：
- 场景地图（障碍物、道路、实体位置、覆盖热力图）
- 信息面板（仿真状态、活跃任务列表）
- 效能曲线（覆盖率、任务完成数随时间变化）

设计原则：与 World 解耦，仅读取公开接口，不依赖仿真内部状态。
"""

import math
import matplotlib
matplotlib.use("TkAgg")  # 必须在 import pyplot 之前设置后端

# 中文字体配置：必须在创建任何 Figure 之前设置
matplotlib.rcParams["font.sans-serif"] = [
    "Microsoft YaHei", "SimHei", "KaiTi", "FangSong",
    "Noto Sans CJK SC", "WenQuanYi Micro Hei",
    "DejaVu Sans",
]
matplotlib.rcParams["font.monospace"] = [
    "Microsoft YaHei", "SimHei", "KaiTi",
    "DejaVu Sans Mono",
]
matplotlib.rcParams["axes.unicode_minus"] = False  # 解决负号显示异常

import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.gridspec import GridSpec
import numpy as np
from collections import deque


class MatplotlibRenderer:
    """Matplotlib 实时可视化渲染器。

    通过 World 和 SituationManager 的公开接口读取数据，
    每 N 仿真秒渲染一帧，使用 blit 加速减少重绘开销。
    """

    def __init__(self, world, interval: float = 1.0):
        """
        Args:
            world: World 实例，用于读取场景配置和初始状态
            interval: 渲染间隔（仿真秒），默认 1.0s
        """
        self._render_interval = interval
        self._last_render_time = -float("inf")

        # 历史数据缓存（用于曲线图）
        self._time_history: deque[float] = deque(maxlen=500)
        self._coverage_history: deque[float] = deque(maxlen=500)
        self._task_completed_history: deque[int] = deque(maxlen=500)
        self._battery_avg_history: deque[float] = deque(maxlen=500)

        # Artist 容器（用于 set_data / set_offsets 增量更新）
        self._artists: dict = {}

        # 初始化图表
        self._init_figure(world)

    # ================================================================
    #  公开接口
    # ================================================================

    def render(self, world):
        """渲染一帧。根据渲染间隔判断是否实际执行绘制。

        Args:
            world: World 实例
        """
        if world.time - self._last_render_time < self._render_interval - 1e-6:
            return
        self._last_render_time = world.time

        self._update_map(world)
        self._update_info(world)
        self._update_charts(world)
        self._fig.canvas.draw_idle()
        self._fig.canvas.flush_events()

    def close(self):
        """关闭可视化窗口。"""
        plt.close(self._fig)

    # ================================================================
    #  图表初始化
    # ================================================================

    def _init_figure(self, world):
        """初始化 figure、axes 和所有图层。"""
        plt.ion()
        self._fig = plt.figure("异构无人协同指控系统 - 实时态势", figsize=(18, 9),
                               facecolor="white")

        # 布局：左侧主地图 (3列) + 右侧面板 (1列)
        gs = GridSpec(2, 4, figure=self._fig, width_ratios=[1, 1, 1, 0.7],
                      hspace=0.35, wspace=0.30,
                      left=0.04, right=0.97, top=0.94, bottom=0.06)

        self._ax_map = self._fig.add_subplot(gs[:, :3])         # 主地图
        self._ax_info = self._fig.add_subplot(gs[0, 3])          # 信息面板
        self._ax_chart = self._fig.add_subplot(gs[1, 3])         # 效能曲线

        self._ax_info.axis("off")
        self._fig.suptitle(f"场景: {world.config.name}  |  "
                           f"区域: {world.config.width:.0f}×{world.config.height:.0f} m",
                           fontsize=13, fontweight="bold", y=0.98)

        # 绘制静态图层
        self._draw_static_layers(world)

        # 初始化动态图层（创建空 Artist）
        self._init_dynamic_artists()

        # 图例
        self._init_legend()

        self._ax_map.set_xlim(0, world.width)
        self._ax_map.set_ylim(0, world.height)
        self._ax_map.set_aspect("equal")
        self._ax_map.set_xlabel("X (m)")
        self._ax_map.set_ylabel("Y (m)")
        self._ax_map.grid(True, alpha=0.2, linestyle="--")

    def _draw_static_layers(self, world):
        """绘制静态图层：场景边界、障碍物、道路。"""
        w, h = world.width, world.height

        # 场景边界矩形
        boundary = mpatches.Rectangle((0, 0), w, h, fill=False,
                                       edgecolor="black", linewidth=2,
                                       linestyle="-", zorder=0)
        self._ax_map.add_patch(boundary)

        # 障碍物（灰色半透明圆）
        for obs in world.config.obstacles:
            circle = plt.Circle(obs.center, obs.radius, facecolor="gray",
                                edgecolor="dimgray", alpha=0.35, linewidth=1.5,
                                zorder=1)
            self._ax_map.add_patch(circle)
            # 标注
            self._ax_map.annotate("障碍", obs.center, fontsize=7,
                                  color="dimgray", ha="center", va="center",
                                  alpha=0.7)

        # 道路（虚线连接航点）
        for road in world.config.roads:
            if len(road.waypoints) >= 2:
                xs = [wp[0] for wp in road.waypoints]
                ys = [wp[1] for wp in road.waypoints]
                self._ax_map.plot(xs, ys, linestyle="--", color="saddlebrown",
                                  linewidth=1.5, alpha=0.6, zorder=1)

        # 网格参考线（弱化）
        resolution = world.config.resolution * 5  # 每 250m 一根
        for x in np.arange(resolution, w, resolution):
            self._ax_map.axvline(x, color="lightgray", alpha=0.15, linewidth=0.5)
        for y in np.arange(resolution, h, resolution):
            self._ax_map.axhline(y, color="lightgray", alpha=0.15, linewidth=0.5)

    def _init_dynamic_artists(self):
        """创建所有动态图层的空 Artist 对象，供后续 set_data / set_offsets 更新。"""
        # --- 覆盖热力图（初始为空） ---
        self._coverage_img = self._ax_map.imshow(
            np.zeros((1, 1)), extent=[0, 1, 0, 1],
            cmap="Blues", alpha=0.25, zorder=2, origin="lower",
            aspect="auto", vmin=0, vmax=1, visible=False
        )

        # --- 实体 scatter 图层 ---
        styles = {
            "uav":        dict(marker="^", color="royalblue",  s=100, edgecolors="navy",     linewidths=0.8, zorder=10),
            "ugv":        dict(marker="s", color="limegreen",  s=80,  edgecolors="darkgreen", linewidths=0.8, zorder=10),
            "victim":     dict(marker="o", color="red",        s=70,  edgecolors="darkred",   linewidths=0.8, zorder=9),
            "intruder":   dict(marker="o", color="darkorange", s=70,  edgecolors="darkred",   linewidths=0.8, zorder=9),
            "suspect":    dict(marker="o", color="gold",       s=70,  edgecolors="darkorange",linewidths=0.8, zorder=9),
            "aerial":     dict(marker="D", color="darkviolet", s=70,  edgecolors="indigo",    linewidths=0.8, zorder=9),
            "vehicle":    dict(marker="s", color="saddlebrown",s=70,  edgecolors="maroon",    linewidths=0.8, zorder=9),
            "facility":   dict(marker="^", color="dimgray",    s=70,  edgecolors="black",     linewidths=0.8, zorder=9),
        }
        self._entity_scatters: dict[str, plt.matplotlib.collections.PathCollection] = {}
        for key, style in styles.items():
            self._entity_scatters[key] = self._ax_map.scatter([], [], **style)

        # --- 实体文字标注 ---
        self._entity_labels: dict[str, list] = {}

        # --- 连线 Artist（任务分配线、充电线） ---
        (self._task_lines,) = self._ax_map.plot([], [], color="cyan",
                                                  linewidth=1.0, linestyle="--",
                                                  alpha=0.6, zorder=5)

        # --- 信息面板文字 ---
        self._info_text = self._ax_info.text(
            0.02, 0.95, "", fontsize=9, fontfamily="monospace",
            va="top", ha="left", transform=self._ax_info.transAxes,
            linespacing=1.6
        )

        # --- 效能曲线 ---
        (self._coverage_line,) = self._ax_chart.plot([], [], "b-", linewidth=1.5,
                                                      label="覆盖率", alpha=0.85)
        (self._task_line,) = self._ax_chart.plot([], [], "g-", linewidth=1.5,
                                                   label="已完成任务", alpha=0.85)
        (self._battery_line,) = self._ax_chart.plot([], [], "orange", linewidth=1.5,
                                                      label="平均电量%", alpha=0.85)
        self._ax_chart.set_xlabel("时间 (s)", fontsize=8)
        self._ax_chart.set_ylabel("值", fontsize=8)
        self._ax_chart.legend(fontsize=7, loc="upper left")
        self._ax_chart.grid(True, alpha=0.3)
        self._ax_chart.tick_params(labelsize=7)

    def _init_legend(self):
        """初始化图例。"""
        legend_entries = [
            mpatches.Patch(color="royalblue", alpha=0.7, label="UAV 无人机"),
            mpatches.Patch(color="limegreen", alpha=0.7, label="UGV 无人车"),
            mpatches.Patch(color="red", alpha=0.7, label="失踪人员"),
            mpatches.Patch(color="darkorange", alpha=0.7, label="越境人员"),
            mpatches.Patch(color="gold", alpha=0.7, label="可疑人员"),
            mpatches.Patch(color="darkviolet", alpha=0.7, label="空中目标"),
            mpatches.Patch(color="saddlebrown", alpha=0.7, label="可疑车辆"),
            mpatches.Patch(color="dimgray", alpha=0.7, label="设施异常"),
        ]
        self._ax_map.legend(handles=legend_entries, fontsize=7,
                            loc="upper right", framealpha=0.85,
                            ncol=4, columnspacing=1.0)

    # ================================================================
    #  每帧更新
    # ================================================================

    def _update_map(self, world):
        """更新主地图：实体位置、覆盖热力图、连线。"""

        # --- 覆盖热力图 ---
        self._update_coverage_overlay(world)

        # --- 实体位置 ---
        self._update_entity_positions(world)

        # --- 连线 ---
        self._update_lines(world)

    def _update_coverage_overlay(self, world):
        """更新覆盖热力图叠加层。每 10 仿真秒更新一次以减少开销。"""
        if int(world.time) % 10 != 0:
            return

        try:
            last_scan = world.situation.coverage.last_scan_time
            if last_scan is None or last_scan.size == 0:
                return

            scanned_mask = np.isfinite(last_scan)
            if not np.any(scanned_mask):
                self._coverage_img.set_visible(False)
                return

            # 归一化：最近扫描 = 1，未扫描 = 0
            max_time = world.time
            normalized = np.where(scanned_mask,
                                  np.clip((last_scan - (max_time - 600)) / 600, 0, 1),
                                  0.0)

            self._coverage_img.set_data(normalized)
            ext = [0, world.width, 0, world.height]
            self._coverage_img.set_extent(ext)
            self._coverage_img.set_clim(0, 1)
            self._coverage_img.set_visible(True)
        except Exception:
            self._coverage_img.set_visible(False)

    def _update_entity_positions(self, world):
        """从 World 真值更新各实体 scatter 图层，按类型分组。"""
        from entity.platform_entity import PlatformEntity
        from entity.target_entity import PersonTarget, AerialTarget, VehicleTarget, FacilityTarget

        # 收集各类型实体坐标
        groups: dict[str, list[tuple[float, float]]] = {
            "uav": [], "ugv": [],
            "victim": [], "intruder": [], "suspect": [],
            "aerial": [], "vehicle": [], "facility": [],
        }
        labels: dict[str, list[tuple[float, float, str]]] = {k: [] for k in groups}

        for entity in world.entities.values():
            if not entity.enabled:
                continue

            if isinstance(entity, PlatformEntity):
                key = entity.platform_type  # "uav" or "ugv"
                groups[key].append(entity.position)
                # 标注：电量百分比
                pct = int(entity.battery / entity.max_battery * 100)
                status = ""
                if entity.landed_on is not None:
                    status = "[充电]"
                elif entity.current_task is not None:
                    tname = type(entity.current_task).__name__.replace("Task", "")
                    status = f"[{tname}]"
                labels[key].append((*entity.position, f"#{entity.id} {pct}%{status}"))

            elif isinstance(entity, PersonTarget):
                key = entity.role  # "victim", "intruder", "suspect"
                groups[key].append(entity.position)
                info = ""
                if entity.role == "victim":
                    if entity.rescued:
                        info = "✓已救"
                    elif entity.injured:
                        # 受伤者生存时间消耗速度 2 倍，有效剩余时间为一半
                        effective_min = entity.survival_time / 2 / 60
                        info = f"伤 {effective_min:.0f}min"
                    else:
                        info = f"{entity.survival_time/60:.0f}min"
                elif entity.neutralized:
                    info = "✕"
                labels[key].append((*entity.position, info))

            elif isinstance(entity, AerialTarget):
                groups["aerial"].append(entity.position)
                info = "✕" if entity.neutralized else ("↓残骸" if entity.neutralized else "")
                labels["aerial"].append((*entity.position, info))

            elif isinstance(entity, VehicleTarget):
                groups["vehicle"].append(entity.position)
                info = "✕" if entity.neutralized else ""
                labels["vehicle"].append((*entity.position, info))

            elif isinstance(entity, FacilityTarget):
                groups["facility"].append(entity.position)
                info = "✓" if entity.repaired else ""
                labels["facility"].append((*entity.position, info))

        # 更新 scatter 位置
        for key, scatter in self._entity_scatters.items():
            positions = groups.get(key, [])
            if positions:
                xs = [p[0] for p in positions]
                ys = [p[1] for p in positions]
                scatter.set_offsets(np.column_stack([xs, ys]))
                # 已处置目标降低透明度
                if key in ("victim", "intruder", "suspect", "aerial", "vehicle",
                           "facility"):
                    scatter.set_alpha(0.3)  # 保留统一透明度，由信息标注区分
                else:
                    scatter.set_alpha(1.0)
            else:
                scatter.set_offsets(np.empty((0, 2)))

        # 更新 label
        for key, label_list in labels.items():
            # 移除旧 label
            for ann in self._entity_labels.pop(key, []):
                ann.remove()
            new_anns = []
            for x, y, text in label_list:
                ann = self._ax_map.annotate(text, (x, y), fontsize=6,
                                            color="black", ha="center", va="bottom",
                                            xytext=(0, 8), textcoords="offset points",
                                            alpha=0.85)
                new_anns.append(ann)
            self._entity_labels[key] = new_anns

    def _update_lines(self, world):
        """更新连线：每个平台到其 target_position 的意图线。

        平台在 update_control() 中通过 set_target() 写入目标坐标，
        此方法直接读取 target_position，覆盖所有任务类型（含 ReconTask、DiscoverTask 等）。
        """
        from entity.platform_entity import PlatformEntity

        segment_xs: list[float] = []
        segment_ys: list[float] = []

        for entity in world.entities.values():
            if not isinstance(entity, PlatformEntity) or not entity.enabled:
                continue
            if entity.target_position is None:
                continue

            segment_xs.extend([entity.position[0], entity.target_position[0], None])
            segment_ys.extend([entity.position[1], entity.target_position[1], None])

        self._task_lines.set_data(segment_xs, segment_ys)

    # ================================================================
    #  信息面板
    # ================================================================

    def _update_info(self, world):
        """更新右侧信息面板文字。"""
        from entity.platform_entity import PlatformEntity
        from entity.target_entity import PersonTarget, AerialTarget

        platforms = [e for e in world.entities.values()
                     if isinstance(e, PlatformEntity) and e.enabled]
        uavs = [p for p in platforms if p.platform_type == "uav"]
        ugvs = [p for p in platforms if p.platform_type == "ugv"]

        victims = [e for e in world.entities.values()
                   if isinstance(e, PersonTarget) and e.role == "victim"]
        rescued = sum(1 for v in victims if v.rescued)
        deceased = sum(1 for v in victims if v.survival_time <= 0)
        intruders = [e for e in world.entities.values()
                     if isinstance(e, PersonTarget) and e.role in ("intruder", "suspect")]
        aerials = [e for e in world.entities.values()
                   if isinstance(e, AerialTarget)]

        # 任务统计
        active = world.task_tracker.get_active()
        completed = sum(1 for t in world.task_tracker.tasks.values()
                        if t.status.name == "COMPLETED")

        uav_batt = f"{np.mean([p.battery/p.max_battery for p in uavs])*100:.0f}%" if uavs else "N/A"
        ugv_batt = f"{np.mean([p.battery/p.max_battery for p in ugvs])*100:.0f}%" if ugvs else "N/A"

        lines = [
            "══════ 仿真状态 ══════",
            f"时间:   {world.time:7.0f} s",
            f"步长:   {world.dt:.0f} s",
            f"",
            "══════ 平台状态 ══════",
            f"UAV:  {len(uavs)} 架 | 均电 {uav_batt}",
            f"UGV:  {len(ugvs)} 辆 | 均电 {ugv_batt}",
            f"",
            "══════ 目标状态 ══════",
            f"失踪人员: {len(victims)} | 已救 {rescued}",
        ]
        if deceased:
            lines.append(f"  死亡: {deceased}")
        if intruders:
            neu = sum(1 for i in intruders if i.neutralized)
            lines.append(f"越境人员: {len(intruders)} | 已处置 {neu}")
        if aerials:
            neu = sum(1 for a in aerials if a.neutralized)
            lines.append(f"空中目标: {len(aerials)} | 已处置 {neu}")

        lines += [
            f"",
            "══════ 任务状态 ══════",
            f"活跃: {len(active)} | 已完成: {completed}",
        ]

        # 活跃任务详情（最多显示 8 条，按优先级从高到低排列）
        show_tasks = sorted(active, key=lambda t: t.priority)[:8]
        if show_tasks:
            lines.append("── 活跃任务 ──")
            for t in show_tasks:
                tname = type(t).__name__.replace("Task", "")
                status = t.status.name[:4]
                lines.append(f" {tname:<10} pri={t.priority:<3} {status}")

        self._info_text.set_text("\n".join(lines))

        # 记录历史数据
        self._time_history.append(world.time)
        try:
            cov = world.situation.coverage.get_coverage_ratio(
                (0, 0, world.width, world.height))
        except Exception:
            cov = 0.0
        self._coverage_history.append(cov)
        self._task_completed_history.append(completed)
        batts = [p.battery / p.max_battery * 100 for p in platforms]
        self._battery_avg_history.append(np.mean(batts) if batts else 0.0)

    # ================================================================
    #  效能曲线
    # ================================================================

    def _update_charts(self, world):
        """更新右侧效能曲线图。"""
        times = list(self._time_history)

        self._coverage_line.set_data(times, list(self._coverage_history))
        self._task_line.set_data(times, list(self._task_completed_history))
        self._battery_line.set_data(times, list(self._battery_avg_history))

        if times:
            self._ax_chart.set_xlim(max(0, times[-1] - 600), max(times[-1] + 60, 60))
            y_vals = (list(self._coverage_history) +
                      list(self._task_completed_history) +
                      list(self._battery_avg_history))
            y_max = max(y_vals) * 1.15 if y_vals else 100
            self._ax_chart.set_ylim(-2, max(y_max, 10))
