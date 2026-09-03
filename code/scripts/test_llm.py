"""LLM 连通性与 tool 调用测试脚本（阶段二第一步，测完可删）。

不依赖仿真系统运行：用伪造的态势快照测试三类指令的翻译效果，
只打印模型返回的 tool 调用参数，不实际执行任何任务操作。

用法：
    export LLM_API_KEY=你的密钥
    export LLM_BASE_URL=https://api.deepseek.com   # 按供应商修改
    export LLM_MODEL=deepseek-chat                 # 按供应商修改
    python scripts/test_llm.py
"""

import os
import sys

# 确保项目根目录在 sys.path 中（脚本位于 scripts/ 子目录）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from interaction.llm_client import TOOLS, SYSTEM_PROMPT


FAKE_CONTEXT = """[仿真时间] T=1234s（场景：荒野搜救 10000×10000m）
[当前任务]（数字越小优先级越高）
  #3  DiscoverTask       ACTIVE   pri=70  目标类型=victim 数量=5   平台=[0]
  #5  ArriveTask         ACTIVE   pri=65  目标=(4000,4000)         平台=[1]
[己方平台]
  #0 UAV pos=(1520,2300) 电量=78% 能力=[sensor, medical(存量2)] 任务=#3
  #1 UAV pos=(3200,3100) 电量=65% 能力=[sensor, medical(存量3)] 任务=#5
  #4 UGV pos=(900,600) 能力=[charger(6), cargo(0/5), rescue] 任务=无
[已发现目标]
  #12 person pos=(4010,3980) injured=True rescued=False
[提示] 地图 x∈[0,10000] y∈[0,10000]，东=+x，北=+y，单位米"""


# 覆盖三类操作 + 两个高危翻车点（优先级方向、方位换算）
TEST_INSTRUCTIONS = [
    "派一架无人机紧急赶到地图东南角看看",       # 注入：盯 capabilities=["sensor"]、pri<=10、坐标约(8000,2000)
    "对那个受伤的人执行救援",                   # 注入：盯是否从上下文匹配到 entity_id=12
    "取消 5 号任务",                            # 取消
    "把 3 号任务提到最高优先级",                # 调权：盯 priority 是 0/1 而不是 100
    "现在有几个任务在执行？",                   # 查询：应零工具调用直接回答
]


def main():
    from openai import OpenAI

    api_key = os.environ.get("LLM_API_KEY")
    if not api_key:
        print("错误：未设置环境变量 LLM_API_KEY")
        sys.exit(1)

    client = OpenAI(api_key=api_key,
                    base_url=os.environ.get("LLM_BASE_URL") or None,
                    timeout=30.0)
    model = os.environ.get("LLM_MODEL", "deepseek-chat")
    print(f"[测试] 模型: {model} | 端点: {os.environ.get('LLM_BASE_URL', '官方默认')}\n")

    for instr in TEST_INSTRUCTIONS:
        print("=" * 60)
        print(f"指令: {instr}")
        resp = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"{FAKE_CONTEXT}\n\n指挥员指令：{instr}"},
            ],
            tools=TOOLS,
        )
        msg = resp.choices[0].message
        if msg.tool_calls:
            for tc in msg.tool_calls:
                print(f"  → 工具: {tc.function.name}")
                print(f"    参数: {tc.function.arguments}")
        if msg.content:
            print(f"  → 文本: {msg.content}")
        if not msg.tool_calls and not msg.content:
            print("  → （模型无输出）")
    print("=" * 60)
    print("\n[测试完成] 检查要点：")
    print("  1. 东南角坐标是否为大x小y（约 8000,2000）")
    print("  2. '紧急'/'最高优先级'是否翻译为小数字（<=10）")
    print("  3. '无人机'是否填了 required_capabilities=[\"sensor\"]")
    print("  4. '那个受伤的人'是否匹配到 target_entity_id=12")
    print("  5. 查询类指令是否零工具调用")


if __name__ == "__main__":
    main()
