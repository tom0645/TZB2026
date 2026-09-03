"""LLM 自然语言指令通道 —— function calling 主循环。

每条指令独立处理：态势快照 + 指令 → 模型 → tool 调用 → executor → 最终答复。
不维护多轮对话记忆。

配置经环境变量注入（对 main.py 零改动）：
    LLM_API_KEY   必填，API 密钥
    LLM_BASE_URL  选填，OpenAI 兼容端点，如 https://api.deepseek.com
    LLM_MODEL     选填，模型名，默认 deepseek-chat

任何异常均收口为可读文本返回，绝不向上抛出（REPL 线程崩溃会导致交互永久失效）。
"""

import os
import json

from interaction.context_builder import build_context
from interaction.executor import do_inject, do_cancel, do_reprioritize

MAX_ROUNDS = 5          # function calling 最大往返轮数，防死循环
_client = None          # 惰性初始化的 OpenAI 客户端


# =========================================================================
# Tool Schema 定义（OpenAI 兼容格式）
# =========================================================================

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "inject_task",
            "description": (
                "注入新任务，下一仿真帧生效并由系统自动分配平台。"
                "重要：priority 数字越小优先级越高（0 最高，100 最低），"
                "人工紧急指令建议 1~10。参考现有优先级：Intercept=5, Charge=25, "
                "Rescue=30, MedicalDelivery=40, Arrive=65, Discover=70, Recon=90。"
                "高优先级任务会自动抢占低优先级任务的平台。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "task_type": {
                        "type": "string",
                        "enum": ["ArriveTask", "OccupyTask", "DiscoverTask",
                                 "RescueTask", "InterceptTask", "MedicalDeliveryTask"],
                        "description": (
                            "ArriveTask=派平台抵达坐标点；OccupyTask=在坐标点驻留一段时间；"
                            "DiscoverTask=搜索发现某类型目标；"
                            "RescueTask/InterceptTask/MedicalDeliveryTask=针对已发现目标实体的"
                            "救援/拦截/医疗投送，必须提供 target_entity_id，"
                            "且该 ID 必须出现在上下文的已发现目标列表中"
                        ),
                    },
                    "priority": {
                        "type": "integer", "minimum": 0, "maximum": 100,
                        "description": "优先级，数字越小越优先。紧急指令用 1~10",
                    },
                    "target_pos": {
                        "type": "array", "items": {"type": "number"},
                        "description": "[x, y] 目标坐标（米）。ArriveTask/OccupyTask 必填",
                    },
                    "target_entity_id": {
                        "type": "integer",
                        "description": "目标实体 ID。Rescue/Intercept/MedicalDelivery 必填",
                    },
                    "required_platforms": {
                        "type": "integer",
                        "description": "需要的平台数量，默认 1",
                    },
                    "required_capabilities": {
                        "type": "array", "items": {"type": "string"},
                        "description": (
                            "所需能力列表。ArriveTask/OccupyTask 强烈建议显式给出，"
                            "否则任何平台（包括慢速无人车）都可能被派去。"
                            "用户说'无人机/飞机'时应填 [\"sensor\"]"
                        ),
                    },
                    "hold_time": {
                        "type": "number",
                        "description": "驻留时长（秒），OccupyTask 用，默认 60",
                    },
                    "radius": {
                        "type": "number",
                        "description": "到达判定半径（米），默认 50",
                    },
                    "target_entity_type": {
                        "type": "string",
                        "description": "DiscoverTask 必填，目标类型如 person/vehicle/aerial",
                    },
                    "required_count": {
                        "type": "integer",
                        "description": "DiscoverTask 需发现的目标数量，默认 1",
                    },
                },
                "required": ["task_type", "priority"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "cancel_task",
            "description": (
                "取消一个 PENDING 或 ACTIVE 状态的任务。"
                "task_id 必须来自上下文的当前任务列表。"
                "取消后任务占用的平台会在下一帧自动释放。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "integer", "description": "要取消的任务 ID"},
                },
                "required": ["task_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "reprioritize_task",
            "description": (
                "调整已有任务的优先级。数字越小优先级越高："
                "'最高优先级'应设为 0 或 1，'最低优先级'为 90~100。"
                "调高优先级（数字调小）可能触发对其他任务平台的抢占。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "integer"},
                    "priority": {
                        "type": "integer", "minimum": 0, "maximum": 100,
                        "description": "新优先级，数字越小越优先",
                    },
                },
                "required": ["task_id", "priority"],
            },
        },
    },
]


# =========================================================================
# System Prompt
# =========================================================================

SYSTEM_PROMPT = """你是异构无人协同指控系统的指令解析助手，负责把指挥员的自然语言指令转化为工具调用。

## 核心规则

1. 优先级方向：数字越小优先级越高。0 最高，100 最低。指挥员说"紧急""立刻""最高优先级"时用 1~10；说"不着急""降级"时用 80~100。绝对不要把"最高优先级"翻译成大数字。

2. 坐标系：原点在地图西南角，东=+x，北=+y，单位米。地图尺寸见上下文提示行。方位词换算示例（以 10000×10000 地图为例）：东南角≈(8000,2000)，西北角≈(2000,8000)，东北角≈(8000,8000)，西南角≈(2000,2000)，中心≈(5000,5000)，北边缘≈(5000,9000)。

3. 平台选择：指挥员说"无人机/飞机/UAV"时，给 ArriveTask/OccupyTask 填 required_capabilities=["sensor"]；说"车/无人车/UGV"时按意图填 ["rescue"] 或 ["charger"]。不填能力字段会导致任意平台被派出（包括不合适的平台）。若指挥员未指明平台类型，ArriveTask/OccupyTask 默认填 required_capabilities=["sensor"]（侦察类任务优先用无人机）

4. ID 引用：task_id 和 target_entity_id 只能使用上下文中实际出现的编号，禁止编造。指挥员用描述指代目标时（如"那个伤员"），从已发现目标列表中按状态字段匹配（如 injured=True 的 person）；无法唯一匹配时向指挥员确认。

5. 歧义处理：目的地不明、目标指代无法唯一匹配、关键参数缺失时，不要猜测，直接用文字向指挥员提问。

6. 上下文只是当前时刻的态势快照，仅用于解析本条指令，不要基于它编造未发生的事。

## 回复风格

- 工具执行后，用一两句话向指挥员确认结果，措辞用"已下达"（任务在下一仿真帧生效，并非立即执行完毕）。
- 中文，简短，指挥口吻。执行失败时如实转述失败原因并给出建议。
- 纯查询类问题（如"现在有几个任务"）直接根据上下文回答，不调用工具。"""


# =========================================================================
# 客户端与工具执行
# =========================================================================

def _get_client():
    """惰性初始化 OpenAI 兼容客户端。

    延迟到首次自然语言指令时才创建：未配置 API Key 的用户
    仍可正常使用斜杠命令，不因 import 本模块而报错。
    """
    global _client
    if _client is None:
        from openai import OpenAI  # 延迟导入：未安装 openai 包不影响斜杠命令
        api_key = os.environ.get("LLM_API_KEY")
        if not api_key:
            raise RuntimeError(
                "未设置环境变量 LLM_API_KEY。"
                "配置方法：export LLM_API_KEY=你的密钥 "
                "（可选 LLM_BASE_URL / LLM_MODEL）")
        _client = OpenAI(
            api_key=api_key,
            base_url=os.environ.get("LLM_BASE_URL") or None,
            timeout=30.0,          # 防 API 挂起卡死输入线程
        )
    return _client


def _execute_tool(name: str, args: dict, world) -> str:
    """tool 名称 → executor 三函数的分发。

    返回 executor 的人类可读文本，原样作为 tool 结果回传模型
    （校验失败时模型依据具体原因自行修正或向用户解释）。
    """
    try:
        if name == "inject_task":
            task_type = args.pop("task_type", None)
            if task_type is None:
                return "错误：缺少 task_type 参数。"
            # 剩余参数整体作为 params 传入，与 task_factory 的入参约定对齐
            return do_inject(world, task_type, args)
        elif name == "cancel_task":
            return do_cancel(world, int(args["task_id"]))
        elif name == "reprioritize_task":
            return do_reprioritize(world, int(args["task_id"]), int(args["priority"]))
        return f"错误：未知工具 '{name}'。"
    except (KeyError, ValueError, TypeError) as e:
        return f"错误：工具参数不合法（{e}）。"


# =========================================================================
# 主入口
# =========================================================================

def handle_command(user_input: str, world) -> str:
    """处理一条自然语言指令，返回最终答复文本（供 REPL 打印）。

    流程：态势快照 + 指令 → function calling 循环（最多 MAX_ROUNDS 轮）
          → 模型返回纯文本时结束。
    """
    try:
        client = _get_client()
    except Exception as e:
        return f"[LLM] {e}"

    context = build_context(world)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"{context}\n\n指挥员指令：{user_input}"},
    ]

    try:
        for _ in range(MAX_ROUNDS):
            resp = client.chat.completions.create(
                model=os.environ.get("LLM_MODEL", "deepseek-chat"),
                messages=messages,
                tools=TOOLS,
            )
            msg = resp.choices[0].message

            # 无工具调用 = 模型给出最终答复（或追问），结束循环
            if not msg.tool_calls:
                return msg.content or "（模型未返回内容）"

            # 记录 assistant 轮（含 tool_calls），再逐个执行并回传结果
            messages.append(msg)
            for tc in msg.tool_calls:
                try:
                    args = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    result = "错误：工具参数不是合法 JSON。"
                else:
                    result = _execute_tool(tc.function.name, args, world)
                # 终端留痕：调优与演示时可见模型实际执行了什么
                print(f"[LLM→执行] {tc.function.name}: {result}")
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": result,
                })
        return "（指令处理超过最大轮数，已中止；已执行的操作见上方 [LLM→执行] 日志）"
    except Exception as e:
        return f"[LLM] 调用失败：{e}（仿真不受影响，可重试或改用斜杠命令）"
