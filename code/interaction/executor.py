"""三操作统一封装。

提供对 TaskTracker 任务增删改操作的统一封装与参数校验，
返回人类可读的字符串，作为斜杠命令的打印输出或 LLM 调用的 tool_result。
"""

from task.tasks import TaskStatus
from interaction.task_factory import create_task


def do_cancel(world, task_id: int) -> str:
    """取消任务。
    
    对不存在或已终结（COMPLETED/FAILED/CANCELLED）的任务返回明确报错。
    """
    task = world.task_tracker.tasks.get(task_id)
    if task is None:
        return f"错误：任务 #{task_id} 不存在。"
    
    if task.status not in (TaskStatus.PENDING, TaskStatus.ACTIVE):
        return f"错误：任务 #{task_id} 当前状态为 {task.status.name}，无法取消。"
        
    world.task_tracker.cancel(task_id)
    return f"成功：已下达取消任务指令 {task.brief()}。"


def do_reprioritize(world, task_id: int, priority: int) -> str:
    """调整任务优先级。
    
    校验 task_id 存在且状态为 PENDING/ACTIVE，且 priority 在 [0, 100] 范围内。
    """
    task = world.task_tracker.tasks.get(task_id)
    if task is None:
        return f"错误：任务 #{task_id} 不存在。"
        
    if task.status not in (TaskStatus.PENDING, TaskStatus.ACTIVE):
        return f"错误：任务 #{task_id} 当前状态为 {task.status.name}，无法修改优先级。"
        
    if not (0 <= priority <= 100):
        return f"错误：优先级 {priority} 不在合法范围 [0, 100] 内。"
        
    old_priority = task.priority
    world.task_tracker.reprioritize(task_id, priority)
    return f"成功：调整任务 {task.brief()} 优先级: {old_priority} → {priority}。"


def do_inject(world, task_type: str, params: dict) -> str:
    """注入新任务。
    
    调用 task_factory 校验参数并构造 Task 实例，成功后注入到 task_tracker 中。
    """
    # 延迟导入或正常导入都可以，这里使用正常导入
    task_or_err = create_task(task_type, params, world)
    if isinstance(task_or_err, str):
        return f"错误：任务注入校验失败，原因：{task_or_err}"
        
    world.task_tracker.inject(task_or_err)
    return f"成功：已注入新任务 {task_or_err.brief()}，优先级={task_or_err.priority}，需要能力={task_or_err.required_capabilities}。"
