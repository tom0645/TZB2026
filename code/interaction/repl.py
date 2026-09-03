"""终端交互线程与斜杠命令分发。

实现 REPL 输入循环与命令分发，支持对任务的查询和增删改调试。
非斜杠输入视为自然语言指令，交由 LLM 通道（llm_client）处理。
"""

import sys
import os
import traceback
from interaction.context_builder import _fmt_tasks, _fmt_platforms, _fmt_targets, build_context
from interaction.executor import do_cancel, do_reprioritize, do_inject


def print_help():
    """打印指令帮助"""
    help_text = """
======================= 交互命令帮助 =======================
  /list                           - 显示所有活跃任务 (PENDING / ACTIVE)
  /platforms                      - 显示我方平台状态 (位置、电量、能力及当前任务)
  /targets                        - 显示已发现目标状态
  /context                        - 显示完整态势快照（即 LLM 看到的上下文）
  /cancel <task_id>               - 取消指定任务
  /priority <task_id> <priority>  - 修改任务优先级 (0最高，100最低)
  /inject <type> <k=v>...         - 注入新任务。支持类型包括:
                                    ArriveTask, OccupyTask, DiscoverTask,
                                    RescueTask, InterceptTask, MedicalDeliveryTask
                                    例如:
                                    /inject ArriveTask target_pos=8000,2000 priority=10
                                    /inject RescueTask target_entity_id=12 priority=5
  /help                           - 显示此帮助信息
  /quit                           - 退出整个仿真系统

  其他任何输入将被视为自然语言指令，由大模型解析执行。
  例如: 派一架无人机紧急赶到地图东南角
  （需配置环境变量 LLM_API_KEY，可选 LLM_BASE_URL / LLM_MODEL）
============================================================
"""
    print(help_text)


def parse_inject_params(args) -> dict:
    """解析 /inject 传入的 k=v 键值对参数"""
    params = {}
    for pair in args:
        if "=" not in pair:
            print(f"[警告] 无法解析的参数项 '{pair}'，格式应为 k=v，已忽略该项。")
            continue
        k, v = pair.split("=", 1)

        # 1. 尝试解析坐标 tuple/list 或 逗号分隔的字符串列表
        if "," in v:
            try:
                # 尝试解析为数字元组 (例如 target_pos=8000,2000)
                params[k] = tuple(float(x) for x in v.split(","))
            except ValueError:
                # 失败则保留为逗号分隔的字符串列表 (例如 required_capabilities=sensor,medical)
                params[k] = [x.strip() for x in v.split(",") if x.strip()]
        else:
            # 2. 尝试解析为整数、浮点数、布尔值或普通字符串
            try:
                params[k] = int(v)
            except ValueError:
                try:
                    params[k] = float(v)
                except ValueError:
                    if v.lower() == "true":
                        params[k] = True
                    elif v.lower() == "false":
                        params[k] = False
                    else:
                        params[k] = v
    return params


def repl_loop(world):
    """交互命令输入循环线程主函数"""
    print("\n[交互] 终端交互模式已启用，输入 /help 查看命令。")

    while True:
        try:
            line = input().strip()
            if not line:
                continue

            if not line.startswith("/"):
                # 自然语言指令 → LLM 通道（延迟导入：不用该功能则不加载 openai 包）
                from interaction.llm_client import handle_command
                print(handle_command(line, world))
                continue

            parts = line.split()
            cmd = parts[0]

            if cmd == "/help":
                print_help()

            elif cmd == "/quit":
                print("[交互] 收到退出指令，正在终止仿真程序...")
                os._exit(0)

            elif cmd == "/list":
                print(_fmt_tasks(world))

            elif cmd == "/platforms":
                print(_fmt_platforms(world))

            elif cmd == "/targets":
                print(_fmt_targets(world))

            elif cmd == "/context":
                print(build_context(world))

            elif cmd == "/cancel":
                if len(parts) < 2:
                    print("错误用法。格式: /cancel <task_id>")
                    continue
                try:
                    task_id = int(parts[1])
                except ValueError:
                    print(f"错误：任务 ID 必须是整数，收到 '{parts[1]}'")
                    continue
                print(do_cancel(world, task_id))

            elif cmd == "/priority":
                if len(parts) < 3:
                    print("错误用法。格式: /priority <task_id> <priority_value>")
                    continue
                try:
                    task_id = int(parts[1])
                    priority = int(parts[2])
                except ValueError:
                    print(f"错误：任务 ID 和优先级必须是整数，收到 ID='{parts[1]}', 优先级='{parts[2]}'")
                    continue
                print(do_reprioritize(world, task_id, priority))

            elif cmd == "/inject":
                if len(parts) < 2:
                    print("错误用法。格式: /inject <task_type> <k=v>...")
                    continue
                task_type = parts[1]
                params = parse_inject_params(parts[2:])
                print(do_inject(world, task_type, params))

            else:
                print(f"未知命令 '{cmd}'，输入 /help 查看可用指令。")

        except EOFError:
            # 标准输入结束，可能处于非交互式后台运行
            print("[交互] 检测到标准输入结束 (EOF)，退出交互线程。")
            break
        except Exception as e:
            print(f"[交互] 执行指令时发生内部错误: {e}")
            traceback.print_exc()
