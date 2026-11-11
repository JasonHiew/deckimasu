# providers/quickmt_provider.py
# Offline Japanese -> English with quickmt-ja-en (https://huggingface.co/quickmt/quickmt-ja-en,
# CC-BY-4.0): a 200M-parameter CTranslate2 model. On the Deck it loads in ~2 s,
# holds ~300 MB and translates ten caption boxes in ~0.3 s, so live subtitles
# can run without a web service's rate limits. Japanese -> English only.

import json
import logging
import os
import select
import shutil
import subprocess
import threading
from typing import List, Optional

from .base import TranslationProvider, ProviderType
from .idle import IdleTimer
from . import python_runtime

logger = logging.getLogger(__name__)

HF_REPO = "quickmt/quickmt-ja-en"
# Pinned so a later upload can't change what users get
HF_REVISION = "e9ae594ff322d95254d730867c6166b25fd2c704"
HF_URL = f"https://huggingface.co/{HF_REPO}/resolve/{HF_REVISION}/{{filename}}"
MODEL_FILES = ["model.bin", "config.json", "source_vocabulary.json",
               "target_vocabulary.json", "src.spm.model", "tgt.spm.model"]
MODEL_DIR_NAME = "quickmt-ja-en"
MODEL_APPROX_MB = 400

WORKER_TIMEOUT = 60
WORKER_IDLE_TIMEOUT = 600  # seconds, like the OCR workers


class QuickMTDownloader:
    def __init__(self, models_dir: str):
        self._models_dir = models_dir
        self._lock = threading.Lock()
        self._downloading = False
        self._progress = 0.0
        self._error = None
        self._cancel = False
        os.makedirs(models_dir, exist_ok=True)
        partial = os.path.join(models_dir, f"{MODEL_DIR_NAME}.downloading")
        if os.path.isdir(partial):
            shutil.rmtree(partial, ignore_errors=True)

    def get_model_dir(self) -> str:
        return os.path.join(self._models_dir, MODEL_DIR_NAME)

    def is_model_downloaded(self) -> bool:
        d = self.get_model_dir()
        return all(os.path.isfile(os.path.join(d, f)) for f in MODEL_FILES)

    def get_model_size(self) -> int:
        d = self.get_model_dir()
        if not os.path.isdir(d):
            return 0
        return sum(os.path.getsize(os.path.join(d, f)) for f in os.listdir(d)
                   if os.path.isfile(os.path.join(d, f)))

    def get_status(self) -> dict:
        with self._lock:
            return {
                "downloaded": self.is_model_downloaded(),
                "size": self.get_model_size(),
                "approx_size_mb": MODEL_APPROX_MB,
                "downloading": self._downloading,
                "progress": self._progress,
                "error": self._error,
            }

    def start_download(self) -> bool:
        with self._lock:
            if self._downloading:
                return False
            self._downloading, self._progress, self._error, self._cancel = True, 0.0, None, False
        threading.Thread(target=self._download, name="quickmt-download", daemon=True).start()
        return True

    def cancel_download(self):
        self._cancel = True

    def clear_error(self):
        with self._lock:
            self._error = None

    def delete_model(self) -> bool:
        d = self.get_model_dir()
        if os.path.isdir(d):
            shutil.rmtree(d, ignore_errors=True)
        return not os.path.exists(d)

    def _download(self):
        import requests
        temp_dir = os.path.join(self._models_dir, f"{MODEL_DIR_NAME}.downloading")
        try:
            os.makedirs(temp_dir, exist_ok=True)
            session = requests.Session()
            # Sizes first, so progress covers every file
            sizes = {}
            for name in MODEL_FILES:
                head = session.head(HF_URL.format(filename=name), allow_redirects=True, timeout=30)
                sizes[name] = int(head.headers.get("content-length") or 0)
            total = max(1, sum(sizes.values()))
            done = 0
            for name in MODEL_FILES:
                resp = session.get(HF_URL.format(filename=name), stream=True, timeout=30)
                if resp.status_code == 429:
                    raise Exception("Too many requests. Try again later.")
                if resp.status_code != 200:
                    raise Exception(f"HTTP {resp.status_code} downloading {name}")
                with open(os.path.join(temp_dir, name), "wb") as f:
                    for chunk in resp.iter_content(chunk_size=1024 * 256):
                        if self._cancel:
                            raise Exception("Download cancelled")
                        f.write(chunk)
                        done += len(chunk)
                        with self._lock:
                            self._progress = min(0.99, done / total)
            final_dir = self.get_model_dir()
            if os.path.exists(final_dir):
                shutil.rmtree(final_dir)
            os.rename(temp_dir, final_dir)
            with self._lock:
                self._progress, self._downloading = 1.0, False
            logger.info("quickmt-ja-en model downloaded")
        except Exception as e:
            shutil.rmtree(temp_dir, ignore_errors=True)
            msg = str(e)
            if "ConnectionError" in type(e).__name__ or "Timeout" in type(e).__name__:
                msg = "Cannot reach the model server. Check the internet connection."
            logger.error(f"quickmt-ja-en download failed: {msg}")
            with self._lock:
                self._downloading = False
                self._error = None if msg == "Download cancelled" else msg


class QuickMTProvider(TranslationProvider):
    """Japanese -> English with quickmt-ja-en in a subprocess worker (the bundled
    Python has ctranslate2 and sentencepiece; Decky's own Python does not)."""

    def __init__(self, downloader: QuickMTDownloader, plugin_dir: str = ""):
        self._downloader = downloader
        self._plugin_dir = plugin_dir or os.environ.get(
            "DECKY_PLUGIN_DIR", "/home/deck/homebrew/plugins/deckimasu")
        self._proc: Optional[subprocess.Popen] = None
        self._loaded = False
        self._lock = threading.Lock()
        self._idle = IdleTimer(WORKER_IDLE_TIMEOUT, self.shutdown, "quickmt translation worker")
        bin_worker = os.path.join(self._plugin_dir, "bin", "py_modules", "providers", "quickmt_worker.py")
        root_worker = os.path.join(self._plugin_dir, "py_modules", "providers", "quickmt_worker.py")
        self._worker_script = bin_worker if os.path.exists(bin_worker) else root_worker
        paths = [p for p in (os.path.join(self._plugin_dir, "bin", "py_modules"),
                             os.path.join(self._plugin_dir, "py_modules")) if os.path.exists(p)]
        self._py_path = os.pathsep.join(paths)

    @property
    def name(self) -> str:
        return "Offline (quickmt ja-en)"

    @property
    def provider_type(self) -> ProviderType:
        return ProviderType.QUICKMT

    @staticmethod
    def supports(source_lang: str, target_lang: str) -> bool:
        return (source_lang or "").lower().startswith("ja") and (target_lang or "").lower().startswith("en")

    def is_available(self, source_lang: str = "ja", target_lang: str = "en") -> bool:
        return self.supports(source_lang, target_lang) and self._downloader.is_model_downloaded()

    def get_supported_languages(self) -> List[str]:
        return ["ja"]

    def _start_unlocked(self) -> bool:
        if self._proc and self._proc.poll() is None and self._loaded:
            return True
        python_path = python_runtime.find_python(self._plugin_dir)
        if not python_path:
            logger.error("quickmt: no Python interpreter found")
            return False
        env = os.environ.copy()
        env.update({"PYTHONPATH": self._py_path, "PYTHONNOUSERSITE": "1",
                    "PYTHONDONTWRITEBYTECODE": "1", "OMP_NUM_THREADS": "4"})
        self._proc = subprocess.Popen(
            [python_path, "-S", self._worker_script],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            env=env, bufsize=0,
        )
        self._loaded = False
        reply = self._send_unlocked({"cmd": "load", "model_dir": self._downloader.get_model_dir()})
        if not reply.get("ok"):
            logger.error(f"quickmt worker failed to load the model: {reply.get('error')}")
            self._kill_unlocked()
            return False
        self._loaded = True
        logger.info("quickmt translation worker ready")
        return True

    def _send_unlocked(self, cmd: dict) -> dict:
        if not self._proc or self._proc.poll() is not None:
            return {"ok": False, "error": "Worker not running"}
        try:
            self._proc.stdin.write((json.dumps(cmd) + "\n").encode("utf-8"))
            self._proc.stdin.flush()
            ready, _, _ = select.select([self._proc.stdout], [], [], WORKER_TIMEOUT)
            if not ready:
                return {"ok": False, "error": "Worker timed out"}
            line = self._proc.stdout.readline()
            if not line:
                return {"ok": False, "error": "Worker closed"}
            return json.loads(line.decode("utf-8"))
        except (BrokenPipeError, OSError, ValueError) as e:
            return {"ok": False, "error": str(e)}

    def _kill_unlocked(self):
        if self._proc:
            try:
                self._proc.kill()
                self._proc.wait(timeout=5)
            except Exception:
                pass
        self._proc, self._loaded = None, False

    def _translate_sync(self, texts: List[str]) -> List[Optional[str]]:
        with self._lock:
            if not self._start_unlocked():
                return [None] * len(texts)
            self._idle.touch()
            reply = self._send_unlocked({"cmd": "translate", "texts": texts})
            if not reply.get("ok"):
                logger.error(f"quickmt translation failed: {reply.get('error')}")
                self._kill_unlocked()
                return [None] * len(texts)
            return reply["translations"]

    async def translate(self, text: str, source_lang: str, target_lang: str) -> str:
        result = (await self.translate_batch([text], source_lang, target_lang))[0]
        return result if result is not None else text

    async def translate_batch(self, texts: List[str], source_lang: str, target_lang: str) -> List[Optional[str]]:
        import asyncio
        if not texts:
            return []
        return await asyncio.to_thread(self._translate_sync, texts)

    def shutdown(self):
        with self._lock:
            if self._proc and self._proc.poll() is None:
                try:
                    self._send_unlocked({"cmd": "shutdown"})
                    self._proc.wait(timeout=5)
                except Exception:
                    pass
            self._kill_unlocked()
        self._idle.cancel()
        logger.debug("quickmt translation worker stopped")
