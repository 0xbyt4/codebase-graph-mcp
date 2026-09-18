"""Fixture program for the pulse sampler: busy work, a blocking wait, a late import, then asyncio."""
import asyncio
import sys
import time

from worker import compute, wait_a_bit


def run(seconds):
    end = time.time() + seconds
    imported_late = False
    while time.time() < end:
        compute(3000)
        wait_a_bit()
        if not imported_late:
            import late_module  # noqa: F401  (appears as an import event)
            imported_late = True


if __name__ == "__main__":
    duration = float(sys.argv[1]) if len(sys.argv) > 1 else 2.0
    run(duration / 2)
    import async_part
    asyncio.run(async_part.serve(duration / 2))
