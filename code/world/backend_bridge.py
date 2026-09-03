"""后端桥接器抽象基类 —— 封装 Python 仿真与外部后端（UE 引擎 / 实机）的通信差异。

纯 Python 仿真路径中不需要桥接，此模块为后续扩展预留。
"""

from abc import ABC, abstractmethod


class BackendBridge(ABC):
    """后端桥接器抽象基类。

    指令下发由实体在 update_control 中通过 set_target() 主动触发，
    仅在目标变化时发送，避免每帧全量广播。
    """

    @abstractmethod
    def sync_from_backend(self, world: "World"):  # type: ignore[name-defined]
        """从外部后端同步实体状态到 World。

        UE 模式：从 UE 拉取所有平台的位置、速度、航向
        实机模式：从地面站数据链路获取平台 GPS 坐标等
        """
        pass

    @abstractmethod
    def send_move_command(self, entity_id: int, target_pos: tuple, speed: float):
        """向指定实体下发移动指令（由实体 set_target 调用，仅在目标变化时触发）"""
        pass

    @abstractmethod
    def send_stop_command(self, entity_id: int):
        """向指定实体下发停止指令（由实体 set_target(None) 调用）"""
        pass
