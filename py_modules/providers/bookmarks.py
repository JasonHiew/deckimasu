# Saved dictionary words ("bookmarks") to look up later, e.g. on the phone in
# Shirabe Jisho. One row per (term, reading); saving the same word again keeps
# the original row and refreshes its context sentence.

import logging
import sqlite3
import threading
import time

logger = logging.getLogger(__name__)

_COLUMNS = ("id", "term", "reading", "context", "context_offset", "note", "done", "created_at", "updated_at")


def _row_to_dict(row):
    d = dict(zip(_COLUMNS, row))
    return {
        "id": d["id"],
        "term": d["term"],
        "reading": d["reading"] or "",
        "context": d["context"] or "",
        "contextOffset": d["context_offset"] or 0,
        "note": d["note"] or "",
        "done": bool(d["done"]),
        "createdAt": d["created_at"],
        "updatedAt": d["updated_at"],
    }


class BookmarkStore:
    def __init__(self, db_path):
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS bookmarks (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                term            TEXT NOT NULL,
                reading         TEXT NOT NULL DEFAULT '',
                context         TEXT,
                context_offset  INTEGER DEFAULT 0,
                note            TEXT DEFAULT '',
                done            INTEGER DEFAULT 0,
                created_at      INTEGER,
                updated_at      INTEGER,
                UNIQUE (term, reading)
            )
            """
        )
        self._conn.commit()

    def _get(self, bookmark_id):
        row = self._conn.execute(
            f"SELECT {', '.join(_COLUMNS)} FROM bookmarks WHERE id = ?", (bookmark_id,)
        ).fetchone()
        return _row_to_dict(row) if row else None

    def list(self):
        with self._lock:
            rows = self._conn.execute(
                f"SELECT {', '.join(_COLUMNS)} FROM bookmarks ORDER BY done ASC, created_at DESC, id DESC"
            ).fetchall()
        return [_row_to_dict(r) for r in rows]

    def add(self, term, reading="", context="", context_offset=0):
        term = (term or "").strip()
        if not term:
            raise ValueError("term is required")
        reading = (reading or "").strip()
        now = int(time.time())
        with self._lock:
            existing = self._conn.execute(
                "SELECT id FROM bookmarks WHERE term = ? AND reading = ?", (term, reading)
            ).fetchone()
            if existing:
                # Saving again moves it back to the open list with the newest context
                self._conn.execute(
                    "UPDATE bookmarks SET context = COALESCE(NULLIF(?, ''), context), "
                    "context_offset = CASE WHEN ? = '' THEN context_offset ELSE ? END, "
                    "done = 0, updated_at = ? WHERE id = ?",
                    (context or "", context or "", int(context_offset or 0), now, existing[0]),
                )
                bookmark_id = existing[0]
            else:
                cur = self._conn.execute(
                    "INSERT INTO bookmarks (term, reading, context, context_offset, note, done, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, '', 0, ?, ?)",
                    (term, reading, context or "", int(context_offset or 0), now, now),
                )
                bookmark_id = cur.lastrowid
            self._conn.commit()
            return self._get(bookmark_id)

    def update(self, bookmark_id, note=None, done=None):
        sets, params = [], []
        if note is not None:
            sets.append("note = ?")
            params.append(str(note))
        if done is not None:
            sets.append("done = ?")
            params.append(1 if done else 0)
        with self._lock:
            if sets:
                sets.append("updated_at = ?")
                params.extend([int(time.time()), int(bookmark_id)])
                self._conn.execute(f"UPDATE bookmarks SET {', '.join(sets)} WHERE id = ?", params)
                self._conn.commit()
            return self._get(int(bookmark_id))

    def delete(self, bookmark_id):
        with self._lock:
            cur = self._conn.execute("DELETE FROM bookmarks WHERE id = ?", (int(bookmark_id),))
            self._conn.commit()
            return cur.rowcount

    def delete_by_term(self, term, reading=""):
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM bookmarks WHERE term = ? AND reading = ?", (term, reading or "")
            )
            self._conn.commit()
            return cur.rowcount

    def delete_done(self):
        with self._lock:
            cur = self._conn.execute("DELETE FROM bookmarks WHERE done = 1")
            self._conn.commit()
            return cur.rowcount

    def close(self):
        with self._lock:
            self._conn.close()
