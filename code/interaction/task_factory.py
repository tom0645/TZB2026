"""任务构造与参数校验。

用于校验任务注入指令的参数合法性并构造 Task 实例。
"""

from task.tasks import (
    ArriveTask, OccupyTask, DiscoverTask, RescueTask, InterceptTask, MedicalDeliveryTask
)

# 任务类型白名单
TASK_WHITELIST = {
    "ArriveTask", "OccupyTask", "DiscoverTask", "RescueTask", "InterceptTask", "MedicalDeliveryTask"
}


def create_task(task_type: str, params: dict, world) -> object:
    """校验参数并构造相应的 Task 实例。
    
    若校验成功，返回构造好的 Task 实例；
    若校验失败，返回具体原因的错误提示字符串。
    """
    if task_type not in TASK_WHITELIST:
        return f"任务类型 '{task_type}' 不在允许的白名单内。"

    # 1. 提取与校验 priority
    priority = params.get("priority")
    if priority is not None:
        try:
            priority = int(priority)
            if not (0 <= priority <= 100):
                return f"优先级 {priority} 超出合法范围 [0, 100]。"
        except ValueError:
            return f"优先级必须为整数，当前值为: {priority}。"

    # 2. 提取与校验 required_platforms
    required_platforms = params.get("required_platforms", 1)
    try:
        required_platforms = int(required_platforms)
        if required_platforms <= 0:
            return f"所需平台数量必须为正整数，当前值为: {required_platforms}。"
    except ValueError:
        return f"所需平台数量必须为正整数，当前值为: {required_platforms}。"

    # 校验所需平台数是否超过系统总平台数
    platform_count = len(world.situation.platforms)
    if required_platforms > platform_count:
        return f"所需平台数量 {required_platforms} 超过当前拥有的平台总数 {platform_count}。"

    # 3. 针对不同任务类型的特定校验与构造
    task = None
    if task_type in ("ArriveTask", "OccupyTask"):
        target_pos = params.get("target_pos")
        if target_pos is None:
            return f"任务类型 '{task_type}' 缺失必要参数 'target_pos'。"
            
        # 支持 "x,y" 字符串格式的坐标解析
        if isinstance(target_pos, str):
            try:
                target_pos = tuple(map(float, target_pos.split(',')))
            except Exception:
                return f"参数 'target_pos' 格式不正确，应为以逗号分隔的两个数字，例如 8000,2000，当前为: {target_pos}。"
                
        if not isinstance(target_pos, (list, tuple)) or len(target_pos) != 2:
            return f"参数 'target_pos' 必须为包含 x 和 y 的坐标元组/列表，当前为: {target_pos}。"
            
        try:
            x = float(target_pos[0])
            y = float(target_pos[1])
            target_pos = (x, y)
        except Exception:
            return f"参数 'target_pos' 包含的必须是数字坐标，当前为: {target_pos}。"

        # 越界校验
        width = world.config.width
        height = world.config.height
        if not (0 <= x <= width and 0 <= y <= height):
            return f"坐标 ({x:.1f}, {y:.1f}) 超出地图范围 x∈[0, {width:.0f}], y∈[0, {height:.0f}]。"

        radius = params.get("radius", 50.0)
        try:
            radius = float(radius)
        except ValueError:
            return f"参数 'radius' 必须为数字，当前值为: {radius}。"

        req_caps = params.get("required_capabilities")
        if req_caps is not None:
            if isinstance(req_caps, str):
                req_caps = [c.strip() for c in req_caps.split(",") if c.strip()]
            if not isinstance(req_caps, list):
                return f"参数 'required_capabilities' 必须为列表或逗号分隔的字符串，当前为: {req_caps}。"

        if task_type == "ArriveTask":
            kwargs = {"target_pos": target_pos, "radius": radius}
            if priority is not None:
                kwargs["priority"] = priority
            if req_caps is not None:
                kwargs["required_capabilities"] = req_caps
            task = ArriveTask(**kwargs)
        else:  # OccupyTask
            hold_time = params.get("hold_time", 60.0)
            try:
                hold_time = float(hold_time)
            except ValueError:
                return f"参数 'hold_time' 必须为数字，当前值为: {hold_time}。"
            
            kwargs = {"target_pos": target_pos, "radius": radius, "hold_time": hold_time}
            if priority is not None:
                kwargs["priority"] = priority
            if req_caps is not None:
                kwargs["required_capabilities"] = req_caps
            task = OccupyTask(**kwargs)

    elif task_type == "DiscoverTask":
        target_entity_type = params.get("target_entity_type")
        if not target_entity_type:
            return f"任务类型 'DiscoverTask' 缺失必要参数 'target_entity_type'。"
            
        required_count = params.get("required_count", 1)
        try:
            required_count = int(required_count)
            if required_count <= 0:
                return f"DiscoverTask 的 required_count 必须为正整数，当前为 {required_count}。"
        except ValueError:
            return f"DiscoverTask 的 required_count 必须为正整数，当前为 {required_count}。"

        kwargs = {"target_entity_type": target_entity_type, "required_count": required_count}
        if priority is not None:
            kwargs["priority"] = priority
        if "area" in params:
            kwargs["area"] = params["area"]
        task = DiscoverTask(**kwargs)

    elif task_type in ("RescueTask", "InterceptTask", "MedicalDeliveryTask"):
        target_entity_id = params.get("target_entity_id")
        if target_entity_id is None:
            return f"任务类型 '{task_type}' 缺失必要参数 'target_entity_id'。"
        try:
            target_entity_id = int(target_entity_id)
        except ValueError:
            return f"参数 'target_entity_id' 必须为整数，当前值为: {target_entity_id}。"

        # 检查态势层中是否存在该实体
        entity_state = world.situation.get_entity(target_entity_id)
        if entity_state is None:
            return f"目标实体 #{target_entity_id} 不存在于态势层中。"

        # 检查是否已处于终态
        if task_type == "RescueTask":
            if entity_state.extra.get("rescued", False):
                return f"目标实体 #{target_entity_id} 已经是已救援状态，无需生成 RescueTask。"
            kwargs = {"target_entity_id": target_entity_id}
            if priority is not None:
                kwargs["priority"] = priority
            task = RescueTask(**kwargs)
            
        elif task_type == "InterceptTask":
            if entity_state.extra.get("neutralized", False):
                return f"目标实体 #{target_entity_id} 已经是已处置状态，无需生成 InterceptTask。"
            kwargs = {"target_entity_id": target_entity_id}
            if priority is not None:
                kwargs["priority"] = priority
            task = InterceptTask(**kwargs)
            
        elif task_type == "MedicalDeliveryTask":
            if not entity_state.extra.get("injured", True) or entity_state.extra.get("rescued", False):
                return f"目标实体 #{target_entity_id} 无需进行医疗投送，可能伤情已处理或已完成救援。"
            kwargs = {"target_entity_id": target_entity_id}
            if priority is not None:
                kwargs["priority"] = priority
            task = MedicalDeliveryTask(**kwargs)

    # 4. 后处理赋值 required_platforms
    if task is not None:
        task.required_platforms = required_platforms
        return task
        
    return "未知的任务类型，无法构造任务。"
