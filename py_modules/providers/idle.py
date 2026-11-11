# providers/idle.py
# Frees a resource that has not been used for a while (an OCR worker process,
# open dictionary databases), so the plugin holds as little RAM as possible
# while a game is running. The owner calls touch() on every use; the resource
# is expected to come back by itself on the next use.

import logging
import threading
import time

logger = logging.getLogger(__name__)


class IdleTimer:
    def __init__(self, timeout, on_idle, name="resource"):
        self._timeout = float(timeout)
        self._on_idle = on_idle
        self._name = name
        self._lock = threading.Lock()
        self._last_used = 0.0
        self._timer = None

    def touch(self):
        """Marks the resource as just used and makes sure a check is scheduled."""
        with self._lock:
            self._last_used = time.monotonic()
            if self._timer is None:
                self._schedule(self._timeout)

    def cancel(self):
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None

    def _schedule(self, delay):
        self._timer = threading.Timer(delay, self._check)
        self._timer.daemon = True
        self._timer.start()

    def _check(self):
        with self._lock:
            idle = time.monotonic() - self._last_used
            if idle < self._timeout:
                # Used again since this check was scheduled: wait out the rest
                self._schedule(self._timeout - idle)
                return
            self._timer = None
        try:
            logger.info(f"{self._name} idle for {int(idle)}s, releasing it")
            self._on_idle()
        except Exception as e:
            logger.warning(f"Could not release idle {self._name}: {e}")
