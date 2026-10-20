# providers/dictionary/store.py
# Installed-dictionary registry plus read access to each dictionary's SQLite file.
#
# Every imported dictionary lives in its own <id>.db so that deleting or
# updating one is a file operation (no VACUUM, disk space is freed at once).
# dictionaries.json records title/revision/order/enabled state for all of them.

import json
import logging
import os
import sqlite3
import threading
import zlib

logger = logging.getLogger(__name__)

REGISTRY_NAME = "dictionaries.json"

# Max bound parameters per query; SQLite's historical default limit is 999
_QUERY_CHUNK = 900


def decode_json_blob(blob, zdict):
    if blob is None:
        return None
    if zdict:
        d = zlib.decompressobj(zdict=zdict)
        raw = d.decompress(blob) + d.flush()
    else:
        raw = zlib.decompress(blob)
    return json.loads(raw.decode("utf-8"))


class InstalledDictionary:
    """Read-only handle on one imported dictionary database."""

    def __init__(self, info, path):
        self.info = info
        self.path = path
        self._conn = None
        self._zdict = None
        self._tags = None
        self._lock = threading.Lock()

    @property
    def id(self):
        return self.info["id"]

    @property
    def title(self):
        return self.info["title"]

    def _connection(self):
        if self._conn is None:
            uri = "file:" + self.path.replace("\\", "/") + "?mode=ro"
            self._conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
            row = self._conn.execute("SELECT value FROM blobs WHERE key='zdict'").fetchone()
            self._zdict = row[0] if row else None
        return self._conn

    def close(self):
        with self._lock:
            if self._conn is not None:
                self._conn.close()
                self._conn = None

    def find_terms(self, texts):
        """Exact matches on expression or reading. Returns raw rows with glossary decoded."""
        texts = list(texts)
        if not texts or not self.info.get("counts", {}).get("terms"):
            return []
        rows = []
        with self._lock:
            conn = self._connection()
            for i in range(0, len(texts), _QUERY_CHUNK):
                chunk = texts[i:i + _QUERY_CHUNK]
                marks = ",".join("?" * len(chunk))
                rows.extend(conn.execute(
                    "SELECT id, expression, reading, def_tags, rules, score, glossary, sequence, term_tags "
                    f"FROM terms WHERE expression IN ({marks}) "
                    "UNION "
                    "SELECT id, expression, reading, def_tags, rules, score, glossary, sequence, term_tags "
                    f"FROM terms WHERE reading IN ({marks}) AND reading != ''",
                    chunk + chunk,
                ).fetchall())
            zdict = self._zdict
        result = []
        for row_id, expression, reading, def_tags, rules, score, glossary, sequence, term_tags in rows:
            result.append({
                "id": row_id,
                "expression": expression,
                "reading": reading or expression,
                "defTags": def_tags.split() if def_tags else [],
                "rules": rules.split() if rules else [],
                "score": score or 0,
                "glossary": decode_json_blob(glossary, zdict),
                "sequence": sequence,
                "termTags": term_tags.split() if term_tags else [],
            })
        return result

    def find_term_meta(self, expressions):
        expressions = list(expressions)
        if not expressions or not self.info.get("counts", {}).get("termMeta"):
            return []
        rows = []
        with self._lock:
            conn = self._connection()
            for i in range(0, len(expressions), _QUERY_CHUNK):
                chunk = expressions[i:i + _QUERY_CHUNK]
                marks = ",".join("?" * len(chunk))
                rows.extend(conn.execute(
                    f"SELECT expression, mode, data FROM term_meta WHERE expression IN ({marks})",
                    chunk,
                ).fetchall())
        return [(e, m, json.loads(d)) for e, m, d in rows]

    def tags(self):
        if self._tags is None:
            with self._lock:
                conn = self._connection()
                self._tags = {
                    name: {"name": name, "category": category or "", "order": order or 0,
                           "notes": notes or "", "score": score or 0}
                    for name, category, order, notes, score in conn.execute(
                        "SELECT name, category, sort_order, notes, score FROM tags")
                }
        return self._tags

    def styles(self):
        with self._lock:
            row = self._connection().execute("SELECT value FROM meta WHERE key='styles'").fetchone()
        return row[0] if row else ""


class DictionaryStore:
    def __init__(self, root_dir):
        self.root_dir = root_dir
        os.makedirs(root_dir, exist_ok=True)
        self._registry_path = os.path.join(root_dir, REGISTRY_NAME)
        self._lock = threading.RLock()
        self._entries = []
        self._handles = {}
        self._cleanup_partial_imports()
        self._load()

    def _cleanup_partial_imports(self):
        for name in os.listdir(self.root_dir):
            if name.endswith((".importing", ".importing-journal", ".download")):
                try:
                    os.remove(os.path.join(self.root_dir, name))
                    logger.info(f"Removed leftover partial dictionary file {name}")
                except OSError as e:
                    logger.warning(f"Could not remove {name}: {e}")

    def _load(self):
        entries = []
        if os.path.exists(self._registry_path):
            try:
                with open(self._registry_path, encoding="utf-8") as f:
                    entries = json.load(f).get("dictionaries", [])
            except Exception as e:
                logger.error(f"Could not read dictionary registry: {e}")
        # Drop entries whose database file went missing
        self._entries = [e for e in entries if os.path.exists(self.db_path(e["id"]))]
        if len(self._entries) != len(entries):
            self._save()

    def _save(self):
        tmp = self._registry_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "dictionaries": self._entries}, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self._registry_path)

    def db_path(self, dict_id):
        return os.path.join(self.root_dir, f"{dict_id}.db")

    def list(self):
        with self._lock:
            return [dict(e) for e in self._entries]

    def get(self, dict_id):
        with self._lock:
            for e in self._entries:
                if e["id"] == dict_id:
                    return dict(e)
        return None

    def find_by_source(self, index):
        """Finds an installed dictionary that an index.json is an update of."""
        index_url = index.get("indexUrl")
        with self._lock:
            for e in self._entries:
                if index_url and e.get("index", {}).get("indexUrl") == index_url:
                    return dict(e)
            for e in self._entries:
                if e["title"] == index.get("title"):
                    return dict(e)
        return None

    def add(self, info, replace_id=None):
        """Registers a freshly imported dictionary, optionally taking over an older one's slot."""
        old_handle = None
        with self._lock:
            if replace_id is not None:
                for i, e in enumerate(self._entries):
                    if e["id"] == replace_id:
                        info["enabled"] = e.get("enabled", True)
                        info["settings"] = e.get("settings", {})
                        self._entries[i] = info
                        old_handle = self._handles.pop(replace_id, None)
                        break
                else:
                    replace_id = None
            if replace_id is None:
                info.setdefault("enabled", True)
                self._entries.append(info)
            self._save()
        if old_handle is not None:
            old_handle.close()
        if replace_id is not None:
            self._remove_file(replace_id)

    def remove(self, dict_id):
        with self._lock:
            before = len(self._entries)
            self._entries = [e for e in self._entries if e["id"] != dict_id]
            if len(self._entries) == before:
                return False
            handle = self._handles.pop(dict_id, None)
            self._save()
        if handle is not None:
            handle.close()
        self._remove_file(dict_id)
        return True

    def _remove_file(self, dict_id):
        for suffix in ("", "-journal", "-wal", "-shm"):
            path = self.db_path(dict_id) + suffix
            if os.path.exists(path):
                try:
                    os.remove(path)
                except OSError as e:
                    logger.error(f"Could not delete {path}: {e}")

    def set_enabled(self, dict_id, enabled):
        with self._lock:
            for e in self._entries:
                if e["id"] == dict_id:
                    e["enabled"] = bool(enabled)
                    self._save()
                    return True
        return False

    def move(self, dict_id, delta):
        """Moves a dictionary up (delta<0) or down (delta>0) in priority order."""
        with self._lock:
            ids = [e["id"] for e in self._entries]
            if dict_id not in ids:
                return False
            i = ids.index(dict_id)
            j = max(0, min(len(ids) - 1, i + delta))
            if i != j:
                entry = self._entries.pop(i)
                self._entries.insert(j, entry)
                self._save()
            return True

    def update_info(self, dict_id, **fields):
        with self._lock:
            for e in self._entries:
                if e["id"] == dict_id:
                    e.update(fields)
                    self._save()
                    return True
        return False

    def enabled_handles(self):
        """Handles for enabled dictionaries, in priority order."""
        with self._lock:
            handles = []
            for e in self._entries:
                if not e.get("enabled", True):
                    continue
                handle = self._handles.get(e["id"])
                if handle is None:
                    handle = InstalledDictionary(dict(e), self.db_path(e["id"]))
                    self._handles[e["id"]] = handle
                handles.append(handle)
            return handles

    def close(self):
        with self._lock:
            handles = list(self._handles.values())
            self._handles.clear()
        for h in handles:
            h.close()
