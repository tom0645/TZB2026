"""态势快照文本生成。

用于为操作员或 LLM 提供仿真时间、当前任务、己方平台和已发现目标的态势认知快照。
"""

def _format_capability(cap) -> str:
    """辅助函数：格式化单个能力组件"""
    t = cap.type
    if t == "medical":
        return f"medical(存量{cap.stock})"
    elif t == "maintenance":
        return f"maintenance(存量{cap.stock})"
    elif t == "charger":
        return f"charger({cap.battery_stock})"
    elif t == "effector":
        return f"effector(存量{cap.charges})"
    elif t == "cargo":
        return f"cargo({cap.quantity}/{cap.capacity})"
    else:
        return t


def _fmt_tasks(world) -> str:
    """格式化当前活跃任务区块"""
    active_tasks = list(world.task_tracker.get_active())
    active_tasks.sort(key=lambda t: (t.priority, t.task_id))
    lines = ["[当前任务]（数字越小优先级越高）"]
    if not active_tasks:
        lines.append("  无活跃任务")
    for task in active_tasks:
        target_str = ""
        if hasattr(task, "target_pos") and task.target_pos is not None:
            target_str = f"目标=({task.target_pos[0]:.0f},{task.target_pos[1]:.0f})"
        elif hasattr(task, "target_entity_id") and task.target_entity_id is not None:
            target_str = f"目标实体=#{task.target_entity_id}"
            if task.task_type == "ChargeTask":
                target_str = f"被充平台=#{task.target_entity_id} 充电车=#{task.charger_platform_id}"
        elif hasattr(task, "target_entity_type") and task.target_entity_type is not None:
            target_str = f"目标类型={task.target_entity_type} 数量={task.required_count}"
        elif hasattr(task, "area") and task.area is not None:
            target_str = f"区域={task.area}"
            
        platform_str = f"平台={task.assigned_platform_ids}"
        lines.append(f"  #{task.task_id:<2d} {task.task_type:<18s} {task.status.name:<8s} pri={task.priority:<3d} {target_str:<25s} {platform_str}")
    return "\n".join(lines)


def _fmt_platforms(world) -> str:
    """格式化己方平台状态区块"""
    platforms_list = list(world.situation.platforms.values())
    platforms_list.sort(key=lambda p: p.id)
    lines = ["[己方平台]"]
    if not platforms_list:
        lines.append("  无己方平台")
    for platform in platforms_list:
        battery_str = ""
        if platform.platform_type.lower() == "uav":
            pct = (platform.battery / platform.max_battery) * 100
            battery_str = f"电量={pct:.0f}% "
            
        caps_str = ", ".join(_format_capability(c) for c in platform.capabilities)
        task_str = f"任务=#{platform.current_task.task_id}" if platform.current_task is not None else "任务=无"
        lines.append(f"  #{platform.id:<2d} {platform.platform_type.upper():<3s} pos=({platform.position[0]:.0f},{platform.position[1]:.0f}) {battery_str}能力=[{caps_str}] {task_str}")
    return "\n".join(lines)


def _fmt_targets(world) -> str:
    """格式化已发现目标区块"""
    targets = list(world.situation.get_all_targets())
    targets.sort(key=lambda t: t.entity_id)
    lines = ["[已发现目标]"]
    if not targets:
        lines.append("  无已发现目标")
    for target in targets:
        extra_str = " ".join(f"{k}={v}" for k, v in target.extra.items())
        lines.append(f"  #{target.entity_id:<2d} {target.entity_type} pos=({target.position[0]:.0f},{target.position[1]:.0f}) {extra_str}")
    return "\n".join(lines)


def build_context(world) -> str:
    """生成完整四区块态势认知快照字符串"""
    t_sec = f"[仿真时间] T={world.time:.0f}s（场景：{world.config.name} {world.config.width:.0f}×{world.config.height:.0f}m）"
    tasks_sec = _fmt_tasks(world)
    platforms_sec = _fmt_platforms(world)
    targets_sec = _fmt_targets(world)
    hint_sec = f"[提示] 地图 x∈[0,{world.config.width:.0f}] y∈[0,{world.config.height:.0f}]，东=+x，北=+y，单位米"
    
    return f"{t_sec}\n{tasks_sec}\n{platforms_sec}\n{targets_sec}\n{hint_sec}"
