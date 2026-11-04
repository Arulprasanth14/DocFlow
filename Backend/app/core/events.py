"""
DocFlow Backend — Event Bus
A simple synchronous event dispatcher for cross-module hooks.
"""
from typing import Any, Callable, Dict, List
import structlog

logger = structlog.get_logger(__name__)

class EventBus:
    _subscribers: Dict[str, List[Callable]] = {}

    @classmethod
    def subscribe(cls, event_name: str, callback: Callable) -> None:
        if event_name not in cls._subscribers:
            cls._subscribers[event_name] = []
        cls._subscribers[event_name].append(callback)

    @classmethod
    def publish(cls, event_name: str, payload: Any = None) -> None:
        logger.info(f"Event published: {event_name}", payload_keys=list(payload.keys()) if isinstance(payload, dict) else None)
        subscribers = cls._subscribers.get(event_name, [])
        for callback in subscribers:
            try:
                callback(payload)
            except Exception as e:
                logger.error(f"Error in event subscriber for {event_name}: {e}")
