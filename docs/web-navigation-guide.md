# 网页导航测试与接口说明

本次适配基于新增的导航、目标行为和场景决策代码，保留原有任务操作与浅蓝灰军用信息终端样式。网页和 Python 仿真通过 HTTP / WebSocket 连接；尚未接入 UE 实时画面或 UE 运动反馈。

## 操作

1. 启动项目中的 `web_api.py` 服务，打开 `http://127.0.0.1:8000/`。
2. 左侧展开“导航与测试”，选择单平台绕障或双平台交叉测试，点击“建立独立测试”。原任务暂停并保留。
3. 使用顶部“运行”或“快进”推进测试。密集 `>>` 方向箭头为规划路径，较浅的实线为单位实际轨迹；无人机使用蓝色系，无人车使用灰绿色系。首次推进前尚未生成路径。初始无单位高亮，单击单位高亮其路径与轨迹，再次单击取消，选择其他单位时转移高亮。
4. 选中测试单位后，可填写目标 X、Y 和期望速度。坐标使用米、位于当前地图内；期望速度不超过平台最大速度。目标超出地图或落在不可通行区域时返回原因，保留原目标。
5. 展开“临时障碍设置”，使用“在前方加入”测试路径被阻挡后的重规划，也可按坐标更新障碍位置或移除障碍。面板控制同一个 `web-test-obstacle`；API 可按不同 ID 管理多个障碍。
6. “模拟目标丢失”使单位等待新目标；重新设置有效目标后可恢复。“停止该单位”清除导航目标，下一次推进停车或悬停。
7. “返回原任务”恢复原会话的时间、任务与事件；顶部“结束 / 重置”在测试模式下只重置测试。重建测试会替换同场景的旧测试。

单平台测试复用当前场景地图，可选择在起终点之间加入静态障碍。交叉测试使用两个平台及交叉目标，不运行任务调度；避让动作取决于实际距离、速度和平台类型，并非每次交叉都会触发。

“原始路径”“前视点”“安全间距”“限制区域”控制地图诊断显示。“显示目标行为（仿真测试）”默认关闭，仅显示态势中已经发现的目标的仿真行为信息；它不作为决策层的输入。

## 新增接口

全部控制使用 JSON。`start`、`exit`、`stop`、`target-loss`、`obstacles` 和 `view/options` 返回状态快照；`goal` 返回 `{ok, message, state}`。非法参数返回 HTTP 422，不合适的模式或当前状态返回 409，未找到的平台返回 404。

| 接口 | 主要参数 | 功能 |
| --- | --- | --- |
| `POST /api/navigation/start` | `scene`、`kind`、`platform_type`、`static_obstacle`；可选 `goal`、`speed` | 新建独立导航测试并切换至该测试 |
| `POST /api/navigation/exit` | 无 | 返回对应场景的普通任务会话 |
| `POST /api/navigation/goal` | `platform_id`、`goal: [x,y]`、`speed` | 设置新目标与期望速度 |
| `POST /api/navigation/stop` | `platform_id` | 清除单位导航目标 |
| `POST /api/navigation/target-loss` | `platform_id` | 模拟目标失去跟踪，等待重新下达目标 |
| `POST /api/navigation/obstacles` | `action: ahead / set / remove`、`obstacle_id`、`radius`、`affects: uav / ugv / both`；`ahead` 需 `platform_id`，`set` 需 `center: [x,y]` | 增加、更新或移除临时障碍 |
| `POST /api/view/options` | `behavior_debug: true / false` | 开关当前会话的目标行为诊断 |

`scene` 为 `rescue / border / area`；`kind` 为 `single / uav-crossing / ugv-crossing / mixed-crossing`。`platform_type` 为 `uav / ugv`，仅用于单平台测试。测试沿用 `/api/session/run`、`pause`、`step`、`reset`、`speed`；任务注入与自然语言指挥需先返回普通任务模式。

## 状态快照增加的字段

`GET /api/state` 和 `WS /ws` 使用相同快照结构，保留原字段。

| 字段 | 内容 |
| --- | --- |
| `simulation.mode`、`simulation.session_id` | 当前模式及会话标识；重置生成新标识 |
| `map.no_fly_zones`、`map.dynamic_obstacles`、`map.obstacle_version` | 禁飞区、临时障碍与障碍版本 |
| `map.border_area`、`map.core_area` | 巡检区域、核心防护区域 |
| `platforms[].navigation` | 原始 / 平滑路径、规划器、路径版本、用时、进度、重规划原因，以及避让 / 让行 / 停车等状态 |
| `platforms[].track` | 最近 600 次推进的实际位置，不与规划路径混用 |
| `platforms[].decision`、`tasks[].decision` | 最近相关决策：原因、候选平台、选中平台、任务阶段及算法等原始记录 |
| `targets[].first_seen`、`last_seen_age`、`tracking` | 首次发现时刻、观测年龄、当前跟踪情况 |
| `targets[].behavior` | 显式开启诊断后，已发现目标的行为信息；未开启时为 `null` |
| `events[]` | 稳定事件 ID、仿真时刻、中文摘要；保留部署、分配、重规划、导航等事件 |
| `metrics`、`evaluation` | 实际决策数量、障碍重规划、避让次数和按场景评价的数据 |
| `navigation_test`、`view_options` | 当前测试配置和诊断显示选项 |

目标列表始终来自已发现态势，评价器的全局统计仅用于仿真评估。详情中的候选平台数、原因和执行结果均读取真实记录，未提供时显示“暂无记录”或“未提供”。决策事件最多保留最近 2000 条，“全程”表示其中全部保留记录；高频连续运行的完整归档仍需独立日志持久化。

HTTP 与 WebSocket 在输出整个快照前，统一把 `Infinity`、`-Infinity`、`NaN` 转换为 JSON `null`，有限数保留原精度。`null` 表示该字段没有可显示的有限值，不代表零。例如边境人员的 `extra.survival_time` 在仿真中保持无限值，网页输出为 `null`。这避免目标被发现后整份状态无法解析、网页看似卡住而后台继续推进的问题。

导航进度以当前路径为准，重规划后重新统计；停止且清除目标时不显示旧路径的剩余路程。边境覆盖率仅以配置的巡检带为分母；区域封控的残骸清理率以已经处置的空中目标为分母。次数与时间等附加指标不使用百分比条。

## UE 接入边界

本文的 `/api/navigation/*` 是浏览器控制 Python 仿真的接口，不是 `路径规划接口与说明.md` 中 UE 与 Python 逐帧通信协议的实现。

后续仍需实现文档中的 `nav.map.set`、`nav.platform.register`、`nav.frame.update`、`nav.control.command` 等消息，以及会话 / 请求确认、异常、心跳、过期帧处理和断连停车；由 UE 回传真实位置、航向、速度及转角，Python 据此计算下一帧控制量。前端可复用现在的路径、状态和事件展示字段，但接入 UE 实时画面还需要单独的视频或 Pixel Streaming 通道。
