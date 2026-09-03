"""能力组件 —— 平台可搭载的功能组件，决定平台能执行何种任务。

设计遵循"拥有与可用分离"原则：平台拥有能力是静态配置，但能力可能因库存耗尽而暂时不可用。
"""

from abc import ABC, abstractmethod


class Capability(ABC):
    """能力组件抽象基类"""

    @property
    @abstractmethod
    def type(self) -> str:
        """能力类型标识：sensor / medical / maintenance / charger / effector / relay / cargo / debris_clear"""
        pass

    @abstractmethod
    def is_available(self) -> bool:
        """能力当前是否可用（库存>0 或 非消耗型始终可用）"""
        pass

    def on_use(self) -> bool:
        """使用能力，消耗资源，返回是否成功。非消耗型默认返回 True。"""
        return True


class SensorCapability(Capability):
    """侦察探测能力 —— 非消耗型。"""

    def __init__(self, range_: float = 500.0, fov: float = 360.0):
        """
        Args:
            range_: 有效探测距离（米）
            fov: 视场角（度），360 为全向
        """
        self.range = range_
        self.fov = fov

    @property
    def type(self) -> str:
        return "sensor"

    def is_available(self) -> bool:
        return True

    def detect(self, world: "World") -> list:  # type: ignore[name-defined]
        """探测周围实体，返回在探测范围内的实体列表。

        由平台在 update_state() 中调用，结果推入态势层。
        """
        detected = []
        for entity in world.entities.values():
            if entity.id == getattr(self, '_owner_id', -1):
                continue                    # 不探测自己
            if not entity.enabled:
                continue
            owner = world.entities.get(getattr(self, '_owner_id', -1))
            if owner is None:
                continue
            dist = owner.distance_to(entity)
            if dist <= self.range:
                detected.append(entity)
        return detected


class MedicalCapability(Capability):
    """医疗投送能力 —— 消耗型（UAV 专用），投送急救包。"""

    def __init__(self, stock: int = 3):
        self.stock: int = stock
        self.max_stock: int = stock

    @property
    def type(self) -> str:
        return "medical"

    def is_available(self) -> bool:
        return self.stock > 0

    def on_use(self) -> bool:
        if self.stock <= 0:
            return False
        self.stock -= 1
        return True

    def replenish(self, amount: int = 1):
        """补充库存"""
        self.stock = min(self.stock + amount, self.max_stock)


class MaintenanceCapability(Capability):
    """维修能力 —— 消耗型，携带维修工具和备件。"""

    def __init__(self, stock: int = 3):
        self.stock: int = stock

    @property
    def type(self) -> str:
        return "maintenance"

    def is_available(self) -> bool:
        return self.stock > 0

    def on_use(self) -> bool:
        if self.stock <= 0:
            return False
        self.stock -= 1
        return True


class ChargerCapability(Capability):
    """补能能力 —— 消耗型（UGV 专用），为无人机换电。"""

    def __init__(self, battery_stock: int = 6):
        self.battery_stock: int = battery_stock

    @property
    def type(self) -> str:
        return "charger"

    def is_available(self) -> bool:
        return self.battery_stock > 0

    def on_use(self) -> bool:
        if self.battery_stock <= 0:
            return False
        self.battery_stock -= 1
        return True


class EffectorCapability(Capability):
    """处置能力 —— 消耗型（UAV 专用），用于拦截/捕获非合作目标。"""

    def __init__(self, charges: int = 3, effective_range: float = 15.0):
        self.charges: int = charges
        self.effective_range: float = effective_range

    @property
    def type(self) -> str:
        return "effector"

    def is_available(self) -> bool:
        return self.charges > 0

    def on_use(self) -> bool:
        if self.charges <= 0:
            return False
        self.charges -= 1
        return True


class CargoCapability(Capability):
    """物资/人员运输能力 —— 装载型（UGV 专用）。"""

    def __init__(self, capacity: int = 5):
        self.capacity: int = capacity
        self.quantity: int = 0               # 当前装载数量

    @property
    def type(self) -> str:
        return "cargo"

    def is_available(self) -> bool:
        return self.quantity < self.capacity

    def take(self, amount: int = 1) -> bool:
        """装载物资/人员，返回是否成功"""
        if self.quantity + amount > self.capacity:
            return False
        self.quantity += amount
        return True

    def unload(self, amount: int = 1) -> bool:
        """卸载物资/人员"""
        if self.quantity < amount:
            return False
        self.quantity -= amount
        return True


class RescueCapability(Capability):
    """救援能力 —— 非消耗型（UGV 专用），用于搜救遇险人员。"""

    @property
    def type(self) -> str:
        return "rescue"

    def is_available(self) -> bool:
        return True


class DebrisClearCapability(Capability):
    """残骸清理能力 —— 非消耗型（UGV 专用）。"""

    @property
    def type(self) -> str:
        return "debris_clear"

    def is_available(self) -> bool:
        return True
