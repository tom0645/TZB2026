"""仿真主入口 —— 异构无人协同指控系统纯 Python 仿真。

用法（默认 matplotlib 可视化后端）：
    python main.py                          # 搜救场景（matplotlib 实时渲染）
    python main.py --scene rescue           # 搜救场景
    python main.py --scene border           # 边境巡检场景
    python main.py --scene area             # 区域封控场景

Headless 模式（无图形界面）：
    python main.py --backend headless                           # 搜救场景 headless
    python main.py --scene border --backend headless            # 边境巡检 headless
    python main.py --scene area --backend headless              # 区域封控 headless

其他常用选项：
    python main.py --verbose                                    # 每帧打印详细状态
    python main.py --report-interval 300                        # 每 300s 输出状态报告
    python main.py --max-steps 500                              # 限制最大步数
    python main.py --backend headless --verbose --max-steps 100 # 组合使用
"""

import argparse
import sys
import os

# 确保项目根目录在 sys.path 中
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def parse_args():
    """解析命令行参数"""
    parser = argparse.ArgumentParser(description="异构无人协同指控系统 纯Python仿真")
    parser.add_argument("--scene", type=str, default="rescue",
                        choices=["rescue", "border", "area"],
                        help="选择仿真场景 (默认: rescue)")
    parser.add_argument("--backend", type=str, default="matplotlib",
                        choices=["headless", "matplotlib"],
                        help="渲染后端 (默认: matplotlib)")
    parser.add_argument("--max-steps", type=int, default=None,
                        help="最大仿真步数，覆盖场景配置")
    parser.add_argument("--verbose", action="store_true",
                        help="打印每帧详细状态")
    parser.add_argument("--report-interval", type=float, default=600.0,
                        help="状态报告间隔（秒，默认 600s = 10min）")
    parser.add_argument("--interactive", action="store_true",
                        help="启用终端交互模式（REPL）")
    return parser.parse_args()


def run_simulation(config, args):
    """运行仿真主循环"""
    from world.world import World

    # 创建 World
    world = World(config, backend=args.backend)
    max_steps = args.max_steps or int(config.max_duration / config.dt)

    print(f"[仿真启动] 场景: {config.name} | "
          f"区域: {config.width:.0f}×{config.height:.0f}m | "
          f"时长: {config.max_duration:.0f}s | 步长: {config.dt}s")
    print(f"[平台数量] {sum(1 for _, e in config.spawn_schedule if hasattr(e, 'platform_type'))}")
    print(f"[初始任务] {len([t for t in config.task_schedule if t[0] == 0.0])} 个")
    print(f"[反应规则] {len(config.reaction_rules)} 条")
    if args.backend == "matplotlib":
        print("[可视化] matplotlib 实时渲染已启用")
    print("-" * 60)

    if args.interactive:
        import threading
        from interaction.repl import repl_loop
        threading.Thread(target=repl_loop, args=(world,), daemon=True).start()

    next_report_time = args.report_interval

    for step in range(max_steps):
        world.tick()
        if args.interactive:
            import time
            time.sleep(0.05)

        # 定期状态报告
        if args.verbose or world.time >= next_report_time:
            active_tasks = world.task_tracker.get_active()
            completed = sum(1 for t in world.task_tracker.tasks.values()
                           if t.status.name == "COMPLETED")
            print(f"[T={world.time:7.0f}s | 步{step:5d}] "
                  f"活跃任务: {len(active_tasks):3d} | "
                  f"已完成: {completed:3d} | "
                  f"实体: {len(world.entities):3d}")
            next_report_time += args.report_interval

        # 检查提前终止：所有平台已停止
        platform_count = len(world.get_platforms())
        if platform_count == 0:
            print("[仿真终止] 所有平台已停止")
            break

    print("-" * 60)
    print(f"[仿真完成] 总用时: {world.time:.0f}s | 步数: {step + 1}")

    return world


def main():
    """主入口"""
    args = parse_args()

    # 选择场景
    if args.scene == "rescue":
        from scene.search_rescue import build_search_rescue_scene
        config = build_search_rescue_scene()
    elif args.scene == "border":
        from scene.border_patrol import build_border_patrol_scene
        config = build_border_patrol_scene()
    elif args.scene == "area":
        from scene.area_control import build_area_control_scene
        config = build_area_control_scene()
    else:
        print(f"未知场景: {args.scene}")
        sys.exit(1)

    # 运行仿真
    world = run_simulation(config, args)

    # 效能评估
    from world.evaluator import Evaluator
    evaluator = Evaluator()
    report = evaluator.evaluate(world)

    print("\n========== 效能评估报告 ==========")
    print(f"场景:        {report['scene_name']}")
    print(f"仿真时长:    {report['total_duration']:.0f}s")
    print(f"任务总数:    {report['task_total']}")
    print(f"任务完成:    {report['task_completed']}")
    print(f"任务失败:    {report['task_failed']}")
    print(f"完成率:      {report['task_completion_rate']:.1%}")
    print(f"全局目标:    {'达成' if report['global_goal_met'] else '未达成'}")
    print(f"综合评分:    {report['score']:.1f} / 100")

    # 场景特定指标
    if 'rescued_count' in report:
        print(f"救援人数:    {report['rescued_count']} / {report.get('victim_total', '?')}")
    if 'intercepted_count' in report:
        print(f"拦截成功:    {report['intercepted_count']} / {report.get('target_total', '?')}")
    if 'neutralized_count' in report:
        print(f"处置成功:    {report['neutralized_count']} / {report.get('aerial_total', '?')}")
    print("=" * 35)

    # 可视化后端：保持窗口直到用户关闭
    if args.backend == "matplotlib" and world.renderer is not None:
        import matplotlib.pyplot as plt
        print("[可视化] 仿真完成，关闭图形窗口退出...")
        plt.ioff()
        plt.show(block=True)


if __name__ == "__main__":
    main()
