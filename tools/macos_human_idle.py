#!/usr/bin/env python3
"""Report whether recent keyboard or pointer input makes GUI injection unsafe."""

import math
import sys

import Quartz


def main() -> int:
    if len(sys.argv) != 2:
        return 2

    try:
        threshold_seconds = max(60.0, float(sys.argv[1]))
    except ValueError:
        return 2

    event_types = (
        Quartz.kCGEventKeyDown,
        Quartz.kCGEventFlagsChanged,
        Quartz.kCGEventMouseMoved,
        Quartz.kCGEventLeftMouseDown,
        Quartz.kCGEventRightMouseDown,
        Quartz.kCGEventOtherMouseDown,
        Quartz.kCGEventScrollWheel,
    )
    idle_seconds = min(
        float(
            Quartz.CGEventSourceSecondsSinceLastEventType(
                Quartz.kCGEventSourceStateCombinedSessionState,
                event_type,
            )
        )
        for event_type in event_types
    )
    if not math.isfinite(idle_seconds) or idle_seconds < 0:
        return 2

    print(f"{idle_seconds:.3f}")
    return 0 if idle_seconds >= threshold_seconds else 1


if __name__ == "__main__":
    raise SystemExit(main())
