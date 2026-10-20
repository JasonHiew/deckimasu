# providers/dictionary/manager.py
# Front door for the dictionary feature: lookups, installing dictionaries from
# the recommended list / a URL / a local zip, Yomitan-style updates
# (index.json isUpdatable + indexUrl + downloadUrl + revision), and the
# management operations behind the Dictionary settings tab.
#
# Downloads and imports run one at a time on a background worker thread; the
# frontend polls get_status() for progress.

import logging
import os
import queue
import threading
import time
import uuid

from .importer import DictionaryImportError, ImportCancelled, import_dictionary, read_index
from .lookup import LookupEngine
from .store import DictionaryStore

logger = logging.getLogger(__name__)

_JMDICT_RELEASES = "https://github.com/yomidevs/jmdict-yomitan/releases/latest/download"

# Same defaults Aidoku offers: JMdict + JMnedict for terms, Jiten for frequency.
RECOMMENDED_DICTIONARIES = [
    {
        "key": "jmdict",
        "name": "JMdict (English)",
        "description": "Japanese-English dictionary",
        "indexUrl": f"{_JMDICT_RELEASES}/JMdict_english_without_proper_names.json",
        "downloadUrl": f"{_JMDICT_RELEASES}/JMdict_english_without_proper_names.zip",
        "approxDownloadMb": 15,
        "approxInstalledMb": 80,
    },
    {
        "key": "jmnedict",
        "name": "JMnedict",
        "description": "Japanese names: people, places, organisations",
        "indexUrl": f"{_JMDICT_RELEASES}/JMnedict.json",
        "downloadUrl": f"{_JMDICT_RELEASES}/JMnedict.zip",
        "approxDownloadMb": 11,
        "approxInstalledMb": 65,
    },
    {
        "key": "jiten",
        "name": "Jiten frequency",
        "description": "Word frequency ranks from jiten.moe",
        "indexUrl": "https://api.jiten.moe/api/frequency-list/index",
        "downloadUrl": "https://api.jiten.moe/api/frequency-list/download",
        "approxDownloadMb": 8,
        "approxInstalledMb": 70,
    },
]

ATTRIBUTION = (
    "JMdict and JMnedict are the property of the Electronic Dictionary Research and "
    "Development Group (EDRDG), used under CC BY-SA 4.0 (edrdg.org). Jiten frequency "
    "data from jiten.moe, CC BY-SA 4.0. Dictionary lookup ported from Yomitan (GPL-3.0)."
)

_HTTP_TIMEOUT = 30
_USER_AGENT = "decky-translator-dictionary/1.0"


class DictionaryManager:
    def __init__(self, root_dir):
        self.root_dir = root_dir
        self.store = DictionaryStore(root_dir)
        self.engine = LookupEngine(self.store)

        self._jobs = queue.Queue()
        self._lock = threading.Lock()
        self._cancel = threading.Event()
        self._status = self._idle_status()
        self._last_error = None
        self._last_message = None
        self._worker = threading.Thread(target=self._run_worker, name="dictionary-worker", daemon=True)
        self._worker.start()

    # Lookup

    def lookup(self, text, offset=0):
        return self.engine.lookup(text, offset)

    def has_term_dictionaries(self):
        return any(h.info.get("counts", {}).get("terms") for h in self.store.enabled_handles())

    # Listing / management

    def list_dictionaries(self):
        result = []
        for e in self.store.list():
            latest = e.get("latestRevision")
            result.append({
                "id": e["id"],
                "title": e["title"],
                "revision": e["revision"],
                "enabled": e.get("enabled", True),
                "kinds": e.get("kinds", []),
                "counts": e.get("counts", {}),
                "sizeBytes": e.get("sizeBytes", 0),
                "importedAt": e.get("importedAt", 0),
                "author": e.get("index", {}).get("author", ""),
                "attribution": e.get("index", {}).get("attribution", ""),
                "description": e.get("index", {}).get("description", ""),
                "url": e.get("index", {}).get("url", ""),
                "isUpdatable": bool(e.get("index", {}).get("isUpdatable") and e.get("index", {}).get("downloadUrl")),
                "latestRevision": latest,
                "updateAvailable": bool(latest and latest != e["revision"]),
            })
        return result

    def recommended(self):
        installed_urls = {e.get("index", {}).get("indexUrl") for e in self.store.list()}
        return [dict(r, installed=r["indexUrl"] in installed_urls) for r in RECOMMENDED_DICTIONARIES]

    def set_enabled(self, dict_id, enabled):
        return self.store.set_enabled(dict_id, enabled)

    def move(self, dict_id, delta):
        return self.store.move(dict_id, delta)

    def delete(self, dict_id):
        if self._status.get("dictId") == dict_id:
            return False
        return self.store.remove(dict_id)

    # Jobs

    def install_recommended(self, keys=None):
        queued = 0
        for r in self.recommended():
            if r["installed"] or (keys and r["key"] not in keys):
                continue
            self._enqueue({"kind": "download", "title": r["name"], "url": r["downloadUrl"],
                           "indexUrl": r["indexUrl"]})
            queued += 1
        return queued

    def install_from_url(self, url):
        url = (url or "").strip()
        if not url.lower().startswith(("http://", "https://")):
            raise ValueError("URL must start with http:// or https://")
        self._enqueue({"kind": "download", "title": url.rsplit("/", 1)[-1] or url, "url": url,
                       "resolveIndex": url.lower().split("?")[0].endswith(".json")})
        return True

    def install_from_file(self, path):
        if not path or not os.path.isfile(path):
            raise ValueError("File not found")
        self._enqueue({"kind": "file", "title": os.path.basename(path), "path": path})
        return True

    def check_updates(self):
        self._enqueue({"kind": "check", "title": "Checking for updates"})
        return True

    def update(self, dict_id=None):
        """Queues updates for one dictionary, or every dictionary with a newer revision."""
        queued = 0
        for e in self.store.list():
            if dict_id is not None and e["id"] != dict_id:
                continue
            index = e.get("index", {})
            if not (index.get("isUpdatable") and index.get("downloadUrl")):
                continue
            if dict_id is None:
                latest = e.get("latestRevision")
                if not latest or latest == e["revision"]:
                    continue
            self._enqueue({"kind": "download", "title": e["title"], "url": index["downloadUrl"],
                           "replaceId": e["id"]})
            queued += 1
        return queued

    def last_update_check(self):
        return max((e.get("checkedAt", 0) for e in self.store.list()), default=0)

    def auto_update(self, interval_days):
        """Checks for and installs updates if the interval has elapsed. Returns True if it ran."""
        if not interval_days or interval_days <= 0:
            return False
        last_check = self.last_update_check()
        if last_check and time.time() - last_check < interval_days * 86400:
            return False
        if not any(e.get("index", {}).get("isUpdatable") for e in self.store.list()):
            return False
        self._enqueue({"kind": "check", "title": "Checking for updates", "thenUpdate": True})
        return True

    def cancel(self):
        self._cancel.set()
        drained = 0
        while True:
            try:
                self._jobs.get_nowait()
                drained += 1
            except queue.Empty:
                break
        return drained

    def get_status(self):
        with self._lock:
            status = dict(self._status)
            status["queued"] = self._jobs.qsize()
            status["lastError"] = self._last_error
            status["lastMessage"] = self._last_message
        status["lastUpdateCheck"] = self.last_update_check()
        return status

    def clear_last_error(self):
        with self._lock:
            self._last_error = None
            self._last_message = None

    def shutdown(self):
        self.cancel()
        self._jobs.put(None)
        self.store.close()

    # Worker

    @staticmethod
    def _idle_status():
        return {"busy": False, "title": "", "phase": "", "progress": 0.0, "message": "", "dictId": None}

    def _enqueue(self, job):
        self._jobs.put(job)

    def _set_status(self, **fields):
        with self._lock:
            self._status.update(fields)

    def _run_worker(self):
        while True:
            job = self._jobs.get()
            if job is None:
                return
            self._cancel.clear()
            self._set_status(busy=True, title=job.get("title", ""), phase="starting", progress=0.0,
                             message="", dictId=job.get("replaceId"))
            try:
                if job["kind"] == "check":
                    self._do_check(then_update=job.get("thenUpdate", False))
                elif job["kind"] == "download":
                    self._do_download(job)
                elif job["kind"] == "file":
                    self._do_import(job["path"], job.get("replaceId"))
            except ImportCancelled:
                logger.info("Dictionary job cancelled")
                with self._lock:
                    self._last_message = "Cancelled"
            except Exception as e:
                logger.error(f"Dictionary job '{job.get('title')}' failed: {e}")
                with self._lock:
                    self._last_error = f"{job.get('title', 'Dictionary')}: {e}"
            finally:
                with self._lock:
                    self._status = self._idle_status()

    def _http_get(self, url, stream=False):
        import requests
        try:
            resp = requests.get(url, stream=stream, timeout=_HTTP_TIMEOUT,
                                headers={"User-Agent": _USER_AGENT})
        except requests.ConnectionError:
            raise RuntimeError("Cannot reach the dictionary server. Check your internet connection.")
        except requests.Timeout:
            raise RuntimeError("The dictionary server timed out.")
        if resp.status_code != 200:
            resp.close()
            raise RuntimeError(f"HTTP {resp.status_code} from {url}")
        return resp

    def _do_check(self, then_update=False):
        entries = [e for e in self.store.list()
                   if e.get("index", {}).get("isUpdatable") and e.get("index", {}).get("indexUrl")]
        for i, e in enumerate(entries):
            if self._cancel.is_set():
                raise ImportCancelled()
            self._set_status(phase="checking", progress=i / max(1, len(entries)),
                             message=f"Checking {e['title']}")
            try:
                resp = self._http_get(e["index"]["indexUrl"])
                remote = resp.json()
                self.store.update_info(e["id"], latestRevision=remote.get("revision"), checkedAt=time.time())
            except Exception as ex:
                logger.warning(f"Update check failed for {e['title']}: {ex}")
        available = sum(1 for d in self.list_dictionaries() if d["updateAvailable"])
        with self._lock:
            self._last_message = (f"{available} update(s) available" if available
                                  else "All dictionaries are up to date")
        if then_update and available:
            self.update()

    def _do_download(self, job):
        url = job["url"]
        if job.get("resolveIndex"):
            self._set_status(phase="downloading", message="Reading index.json")
            index = self._http_get(url).json()
            url = index.get("downloadUrl")
            if not url:
                raise DictionaryImportError("index.json has no downloadUrl")
            self._set_status(title=index.get("title", job["title"]))

        replace_id = job.get("replaceId")
        temp_path = os.path.join(self.root_dir, f"{uuid.uuid4().hex[:12]}.download")
        try:
            resp = self._http_get(url, stream=True)
            total = int(resp.headers.get("content-length") or 0)
            downloaded = 0
            with open(temp_path, "wb") as f:
                for chunk in resp.iter_content(chunk_size=256 * 1024):
                    if self._cancel.is_set():
                        resp.close()
                        raise ImportCancelled()
                    f.write(chunk)
                    downloaded += len(chunk)
                    self._set_status(
                        phase="downloading",
                        progress=(downloaded / total) if total else 0.0,
                        message=f"Downloading {downloaded / 1e6:.1f}" + (f" / {total / 1e6:.1f} MB" if total else " MB"),
                    )
            self._do_import(temp_path, replace_id)
        finally:
            if os.path.exists(temp_path):
                os.remove(temp_path)

    def _do_import(self, zip_path, replace_id=None):
        index = read_index(zip_path)
        if replace_id is None:
            existing = self.store.find_by_source(index)
            if existing is not None:
                if existing["revision"] == index["revision"]:
                    with self._lock:
                        self._last_message = f"{existing['title']} is already installed"
                    return
                replace_id = existing["id"]
        self._set_status(title=index["title"], phase="importing", progress=0.0, message="Importing",
                         dictId=replace_id)

        def progress(fraction, message):
            self._set_status(progress=fraction, message=message)

        info = import_dictionary(zip_path, self.root_dir, progress=progress, cancel_event=self._cancel)
        self.store.add(info, replace_id=replace_id)
        with self._lock:
            self._last_message = f"{'Updated' if replace_id else 'Installed'} {info['title']}"
