# providers/ntfy_provider.py
# Sends recognized text to a phone via an ntfy (https://ntfy.sh) push notification

import logging

import requests

from .base import NetworkError, ApiKeyError, RateLimitError

logger = logging.getLogger(__name__)

REQUEST_TIMEOUT = 15


class NtfyProvider:
    """Publishes a plain-text notification to an ntfy topic."""

    def __init__(self, server_url: str = "", topic: str = "", token: str = ""):
        self._server_url = (server_url or "").rstrip("/")
        self._topic = topic or ""
        self._token = token or ""

    def is_configured(self) -> bool:
        return bool(self._server_url and self._topic)

    def send(self, message: str) -> None:
        """Publish message to the configured ntfy topic. Raises on failure."""
        if not self.is_configured():
            raise ApiKeyError("ntfy server URL and topic must be configured")

        url = f"{self._server_url}/{self._topic}"
        headers = {}
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"

        try:
            response = requests.post(
                url,
                data=message.encode("utf-8"),
                headers=headers,
                timeout=REQUEST_TIMEOUT,
            )
        except requests.exceptions.ConnectionError as e:
            raise NetworkError(f"Cannot reach ntfy server: {e}") from e
        except requests.exceptions.Timeout as e:
            raise NetworkError("ntfy request timed out") from e

        if response.status_code == 401 or response.status_code == 403:
            raise ApiKeyError("ntfy rejected the request (invalid or missing token)")
        elif response.status_code == 429:
            raise RateLimitError("ntfy rate limit exceeded")
        elif response.status_code != 200:
            raise NetworkError(f"ntfy error ({response.status_code}): {response.text[:200]}")

        logger.info(f"ntfy notification sent to {self._topic}")
