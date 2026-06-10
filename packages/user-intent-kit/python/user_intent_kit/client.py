# SPDX-License-Identifier: AGPL-3.0

"""IntentClient - Python client for the User Intent API."""

import json
import threading
import urllib.request
import urllib.error
from typing import Any, Optional


class IntentClient:
    """REST client for the User Intent API on Ant Farm."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        user_id: str,
        device_id: Optional[str] = None,
        timeout_sec: float = 10.0,
        heartbeat_interval_sec: float = 30.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.user_id = user_id
        self.device_id = device_id
        self.timeout_sec = timeout_sec
        self.heartbeat_interval_sec = max(heartbeat_interval_sec, 10.0)
        self._heartbeat_timer: Optional[threading.Timer] = None

    # --- Profile ---

    def get_profile(self) -> dict:
        return self._request("GET", f"/profile/{self.user_id}")

    def update_profile(self, fields: dict) -> dict:
        return self._request("PUT", f"/profile/{self.user_id}", fields)

    # --- Intent ---

    def get_intent(self) -> dict:
        return self._request("GET", f"/intent/{self.user_id}")

    def patch_device(self, fields: dict) -> dict:
        if not self.device_id:
            raise ValueError("No device_id configured")
        return self._request("PATCH", f"/intent/{self.user_id}/{self.device_id}", fields)

    def set_device(self, fields: dict) -> dict:
        if not self.device_id:
            raise ValueError("No device_id configured")
        return self._request("PUT", f"/intent/{self.user_id}/{self.device_id}", fields)

    def remove_device(self, device_id: Optional[str] = None) -> dict:
        target = device_id or self.device_id
        if not target:
            raise ValueError("No device_id specified")
        return self._request("DELETE", f"/intent/{self.user_id}/{target}")

    def patch_agent(self, name: str, fields: dict) -> dict:
        return self._request("PATCH", f"/intent/{self.user_id}/agents/{name}", fields)

    # --- Derived state helpers ---

    def get_derived(self) -> dict:
        intent = self.get_intent()
        return intent.get("derived", {})

    def is_in_meeting(self) -> bool:
        return self.get_derived().get("urgency_mode") == "text-only"

    def should_suppress_audio(self) -> bool:
        return self.get_derived().get("suppress_audio", False)

    def preferred_device(self) -> Optional[str]:
        return self.get_derived().get("preferred_device")

    # --- Heartbeat ---

    def heartbeat(self) -> dict:
        if not self.device_id:
            raise ValueError("No device_id configured")
        return self._request("PATCH", f"/intent/{self.user_id}/{self.device_id}", {"heartbeat": True})

    def start_heartbeat(self):
        self.stop_heartbeat()
        self._schedule_heartbeat()

    def stop_heartbeat(self):
        if self._heartbeat_timer:
            self._heartbeat_timer.cancel()
            self._heartbeat_timer = None

    def _schedule_heartbeat(self):
        def _beat():
            try:
                self.heartbeat()
            except Exception:
                pass
            self._heartbeat_timer = threading.Timer(self.heartbeat_interval_sec, _beat)
            self._heartbeat_timer.daemon = True
            self._heartbeat_timer.start()

        self._heartbeat_timer = threading.Timer(self.heartbeat_interval_sec, _beat)
        self._heartbeat_timer.daemon = True
        self._heartbeat_timer.start()

    # --- Internal ---

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        url = f"{self.base_url}{path}"
        data = None
        if body and method not in ("GET", "DELETE"):
            data = json.dumps(body).encode("utf-8")

        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("X-API-Key", self.api_key)
        req.add_header("Content-Type", "application/json")

        try:
            resp = urllib.request.urlopen(req, timeout=self.timeout_sec)
            content = resp.read().decode("utf-8")
            if not content:
                return {}
            return json.loads(content)
        except urllib.error.HTTPError as e:
            body_text = e.read().decode("utf-8", errors="replace") if e.fp else ""
            raise IntentApiError(e.code, body_text) from e


class IntentApiError(Exception):
    def __init__(self, status_code: int, body: str):
        self.status_code = status_code
        self.body = body
        super().__init__(f"Intent API error {status_code}: {body}")
