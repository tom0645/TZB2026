# 人机交互控制系统使用说明书 (User Manual)

本说明书覆盖人机交互层的**全部功能**：斜杠命令（结构化操作）与自然语言指令（LLM function calling）。

> [!NOTE]
> 本人机交互层不修改仿真系统的任何内部物理/状态机逻辑，全部通过 TaskTracker 的公开人工干预接口（`inject` / `cancel` / `reprioritize`）控制，保障系统在自主运行与手动接入时行为一致。`--interactive` 未开启时，系统行为与原版完全相同。

---

## 一、功能概览

| 功能 | 结构化通道（斜杠命令） | 自然语言通道（LLM） |
| :--- | :--- | :--- |
| 注入新任务 | `/inject <type> <k=v>...` | "派一架无人机紧急赶到东南角" |
| 取消任务 | `/cancel <task_id>` | "取消那个搜索任务" |
| 调整优先级 | `/priority <task_id> <val>` | "把 1 号任务提到最高" |
| 查询态势 | `/list` `/platforms` `/targets` `/context` | "现在几个任务在跑" |

**通道选择建议**：已知 task_id 的确定性操作用斜杠命令（更快、零 API 开销）；涉及方位换算、目标指代、任务类型判断的模糊意图用自然语言。

---

## 二、环境准备

### 2.1 依赖安装

```bash
conda activate tzb2026
pip install -r requirements.txt        # 已含 openai>=1.0.0
```

### 2.2 配置 LLM API（仅自然语言通道需要）

外接 API，无需本地部署。以 DeepSeek 为例：

```bash
# Linux / macOS
export LLM_API_KEY="sk-你的密钥"
export LLM_BASE_URL="https://api.deepseek.com"
export LLM_MODEL="deepseek-chat"
```

```powershell
# Windows PowerShell
$env:LLM_API_KEY="sk-你的密钥"
$env:LLM_BASE_URL="https://api.deepseek.com"
$env:LLM_MODEL="deepseek-chat"
```

| 变量 | 必填 | 说明 |
| :--- | :--- | :--- |
| `LLM_API_KEY` | 是 | API 密钥 |
| `LLM_BASE_URL` | 否 | OpenAI 兼容端点，切换供应商时修改 |
| `LLM_MODEL` | 否 | 模型名，默认 `deepseek-chat` |

> 采用 OpenAI 兼容协议，DeepSeek / Qwen / GLM / Moonshot 等主流服务均可通过修改 `LLM_BASE_URL` 与 `LLM_MODEL` 直接切换。
> 环境变量仅在当前终端会话有效；未配置时斜杠命令仍可正常使用，仅自然语言通道不可用。

### 2.3 启动

```bash
python3 main.py --interactive --backend headless --max-steps 5000
```

- `--interactive`：开启交互控制线程（REPL）
- `--backend headless`：命令行模式高速仿真，便于调试
- `--max-steps 5000`：确保有充足时间进行调试操作

看到 `[交互] 终端交互模式已启用，输入 /help 查看命令。` 即可输入指令。

---

## 三、斜杠命令参考

### 3.1 态势与信息查询

| 命令 | 说明 |
| :--- | :--- |
| `/help` | 显示命令帮助列表 |
| `/list` | 列出所有活跃任务（`PENDING` + `ACTIVE`），按优先级由高到低排序（pri 越小越高） |
| `/platforms` | 显示己方平台的位置、电量、能力及库存、当前任务 ID |
| `/targets` | 列出已发现目标的位置与状态字段（injured / rescued 等） |
| `/context` | 显示完整四区块态势快照——**即 LLM 每次看到的上下文输入**，调优 prompt 时的主要依据 |
| `/quit` | 立即终止仿真程序（注意：跳过效能评估报告输出） |

### 3.2 任务流控制

**`/cancel <task_id>`** — 取消指定任务。
```
/cancel 3
```
对已被分配平台的 ACTIVE 任务，平台在下一帧自动解绑并恢复空闲。对不存在或已终结（COMPLETED / FAILED / CANCELLED）的任务会明确报错。

**`/priority <task_id> <priority>`** — 修改优先级（0 最高，100 最低）。
```
/priority 4 5
```
调高优先级后，低优先级任务正在使用的平台会被抢占并重分配。

**`/inject <task_type> <k=v>...`** — 注入手工创建的新任务。
```
/inject ArriveTask target_pos=8000,2000 priority=10 required_capabilities=sensor
/inject RescueTask target_entity_id=12 priority=5
```

支持的任务类型白名单：

| 类型 | 用途 | 必填参数 |
| :--- | :--- | :--- |
| `ArriveTask` | 抵达指定坐标 | `target_pos` |
| `OccupyTask` | 在坐标点驻留 | `target_pos`（`hold_time` 默认 60s） |
| `DiscoverTask` | 搜索发现某类型目标 | `target_entity_type` |
| `RescueTask` | 人员救援 | `target_entity_id` |
| `InterceptTask` | 目标拦截 | `target_entity_id` |
| `MedicalDeliveryTask` | 医疗物资投送 | `target_entity_id` |

参数解析规则（`k=v`）：
- 逗号分隔数字 → 元组：`target_pos=8000,2000` → `(8000.0, 2000.0)`
- 逗号分隔字符 → 列表：`required_capabilities=sensor,medical` → `['sensor', 'medical']`
- 数字与布尔值自动转为 `int` / `float` / `bool`

> **注意**：`ArriveTask` / `OccupyTask` 建议显式指定 `required_capabilities`，否则任何平台（包括慢速 UGV）都可能被派出。

---

## 四、自然语言指令

**任何不以 `/` 开头的输入**都会被送入 LLM 通道解析。

### 4.1 使用示例

```
派一架无人机紧急赶到地图东南角
对 12 号伤员执行救援
在地图中心驻守十分钟
取消那个搜索任务
把 1 号任务提到最高
现在几个任务在跑
```

### 4.2 输出解读

以"派一架无人机紧急赶到地图东南角"为例，终端会依次出现三段输出：

```
[任务] 注入 ArriveTask#9(pos=(8000.0, 2000.0)) 优先级=1 需要能力=['sensor']   ← 仿真线程
[LLM→执行] inject_task: 成功：已注入新任务 ArriveTask#9(...)                  ← 模型实际执行的操作
[任务] 激活 ArriveTask#9(pos=(8000.0, 2000.0)) 已分配平台=[0]                 ← 分配器响应
已下达：一架无人机紧急赶赴东南角 (8000, 2000)，优先级设为 1。任务编号 #9。      ← 模型答复
```

`[LLM→执行]` 行是排查问题的关键——它显示模型实际调用了哪个工具、传了什么参数、执行结果如何。

### 4.3 已支持的智能行为

| 行为 | 示例 |
| :--- | :--- |
| 方位换算 | "东南角" → `(8000, 2000)`（原点西南角，东=+x，北=+y） |
| 优先级语义 | "紧急""最高优先级" → `priority=1`；"不着急" → `priority=90` |
| 平台推断 | "无人机" → `required_capabilities=["sensor"]` |
| 目标指代 | "那个受伤的人" → 从态势快照匹配 `injured=True` 的实体 ID |
| 歧义追问 | "派个飞机过去" → 反问目的地，不猜测 |
| 拒绝幻觉 | 无匹配目标时如实报告并列出候选，不编造 ID |
| 参数纠错 | "去坐标(50000,3000)" → 转述越界报错并请求确认 |
| 多操作指令 | "取消 3 号任务，改派两架去东北角" → 一次 cancel + 一次 inject |

### 4.4 已知特性

- **响应延迟**：API 往返约 1~10 秒，期间仿真持续推进不冻结；输入的字符会缓存至响应返回后一并显示，属正常现象。
- **一帧延迟**：注入的任务在下一仿真帧被分配，抢占引发的平台转向再晚一帧（原项目 Tick 时序设计如此），故确认话术为"已下达"而非"已执行"。
- **无对话记忆**：每条指令独立处理，携带当帧态势快照，不保留历史上下文。

---

## 五、参数安全性校验

`task_factory.py` 对所有注入任务进行拦截校验，失败时打印清晰中文报错（自然语言通道下该报错回传给模型，由其修正或向指挥员解释）：

| 校验项 | 说明 |
| :--- | :--- |
| 类型白名单 | `task_type` 必须在六种允许类型内 |
| 坐标越界 | `target_pos` 必须在地图范围内（如 `[0, 10000]`） |
| 实体存在性 | `target_entity_id` 必须已存在于态势层 |
| 实体终态 | 已 rescued / neutralized 的目标不可再下达对应任务 |
| 优先级范围 | `priority ∈ [0, 100]` |
| 平台数量 | `required_platforms` 不得超过在场平台总数 |

---

## 六、典型调试流程

### 场景 A：验证强制抢占

1. `/platforms` 确认平台状态；
2. `/inject ArriveTask target_pos=8000,2000 priority=1 required_capabilities=sensor`；
3. 观察 `[任务] 激活 ArriveTask#X 已分配平台=[N]`，且原低优先级任务打印 `平台不足退回 PENDING`；
4. `/platforms` 确认平台 #N 的任务已切换。

### 场景 B：验证释放链路

1. `/cancel <上一步的 task_id>`；
2. 下一帧 `/platforms` 显示该平台 `任务=无`。

### 场景 C：自然语言翻译排查

1. 敲自然语言指令；
2. 看 `[LLM→执行]` 确认模型实际做了什么；
3. 若翻译有误，`/context` 查看模型当时看到的输入；
4. 据此调整 `interaction/llm_client.py` 中的 `SYSTEM_PROMPT` 并重测。

### 场景 D：不启动仿真单测 LLM

```bash
python scripts/test_llm.py
```
用伪造态势快照测试指令翻译，仅打印模型返回的工具参数，不执行任何操作。适合快速迭代 prompt。

---

## 七、模块结构

```
interaction/
├── context_builder.py    # 态势快照文本生成（build_context / _fmt_* 区块函数）
├── executor.py           # 三操作统一封装（do_inject / do_cancel / do_reprioritize）
├── task_factory.py       # 任务构造与参数校验
├── llm_client.py         # tool schema、system prompt、function calling 主循环
└── repl.py               # 终端交互线程与命令分发

main.py                   # 仅新增 --interactive 参数与 REPL 线程启动
scripts/test_llm.py       # LLM 连通性与翻译测试脚本（可选）
```

设计文档见 `.docs/人机交互与指令系统设计.md`。

---

## 八、常见问题

| 现象 | 原因与处理 |
| :--- | :--- |
| `[LLM] 未设置环境变量 LLM_API_KEY` | 按 §2.2 配置；注意环境变量仅当前终端会话有效 |
| `[LLM] 调用失败：...` | 网络或密钥问题；仿真不受影响，可重试或改用斜杠命令 |
| 未指定能力时派出了 UGV | `required_capabilities` 为空时所有平台均为候选，注入时显式指定 |
| ReconTask 一直不完成 | 主项目 `ReconTask.is_completed()` 尚为 TODO（恒 False），故该类型不在注入白名单内 |
| EntityTask 选中的不是最近平台 | 主项目 `PlatformAllocator._resolve_target()` 已知缺陷（距离排序回落原点），已记录上报，本模块不越界修改 |
| `/quit` 后没有评估报告 | `/quit` 为强制退出；需要报告请让仿真自然跑完 |
