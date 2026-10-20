# providers/dictionary/importer.py
# Imports a Yomitan-format dictionary zip (format 1-3) into a standalone SQLite
# database. Glossaries are stored zlib-compressed with a preset dictionary
# sampled from the dictionary's own entries, which shrinks the many small,
# repetitive structured-content JSON blobs considerably.

import json
import logging
import os
import re
import sqlite3
import time
import uuid
import zipfile
import zlib

logger = logging.getLogger(__name__)

_BANK_RE = re.compile(r"^(term_bank|term_meta_bank|kanji_bank|kanji_meta_bank|tag_bank)_(\d+)\.json$")

_SCHEMA = """
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE blobs (key TEXT PRIMARY KEY, value BLOB);
CREATE TABLE terms (
    id INTEGER PRIMARY KEY,
    expression TEXT NOT NULL,
    reading TEXT NOT NULL,
    def_tags TEXT,
    rules TEXT,
    score INTEGER,
    glossary BLOB,
    sequence INTEGER,
    term_tags TEXT
);
CREATE TABLE term_meta (expression TEXT NOT NULL, mode TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE kanji (character TEXT NOT NULL, onyomi TEXT, kunyomi TEXT, tags TEXT, meanings TEXT, stats TEXT);
CREATE TABLE kanji_meta (character TEXT NOT NULL, mode TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE tags (name TEXT PRIMARY KEY, category TEXT, sort_order INTEGER, notes TEXT, score INTEGER);
"""

_INDEXES = """
CREATE INDEX terms_expression ON terms(expression);
CREATE INDEX terms_reading ON terms(reading) WHERE reading != '';
CREATE INDEX term_meta_expression ON term_meta(expression);
CREATE INDEX kanji_character ON kanji(character);
CREATE INDEX kanji_meta_character ON kanji_meta(character);
"""

_ZDICT_SIZE = 32 * 1024


class ImportCancelled(Exception):
    pass


class DictionaryImportError(Exception):
    pass


def _compact(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def read_index(zip_path):
    with zipfile.ZipFile(zip_path) as z:
        return _read_index(z, _member_map(z))


def _member_map(z):
    """Maps bare file names to zip members (some zips nest everything in a folder)."""
    members = {}
    for info in z.infolist():
        if info.is_dir():
            continue
        base = info.filename.rsplit("/", 1)[-1]
        members.setdefault(base, info.filename)
    return members


def _read_index(z, members):
    if "index.json" not in members:
        raise DictionaryImportError("Not a Yomitan dictionary (index.json missing)")
    try:
        index = json.loads(z.read(members["index.json"]).decode("utf-8-sig"))
    except Exception as e:
        raise DictionaryImportError(f"index.json is not valid JSON: {e}")
    if not index.get("title") or not index.get("revision"):
        raise DictionaryImportError("index.json is missing title or revision")
    version = index.get("format", index.get("version"))
    if version not in (1, 2, 3):
        raise DictionaryImportError(f"Unsupported dictionary format: {version}")
    index["format"] = version
    return index


def _build_zdict(sample_rows):
    """Concatenates sampled glossary JSON, most representative entries last."""
    parts = []
    size = 0
    for row in sample_rows:
        s = _compact(row).encode("utf-8")
        if size + len(s) > _ZDICT_SIZE:
            break
        parts.append(s)
        size += len(s)
    return b"".join(reversed(parts)) if parts else None


def import_dictionary(zip_path, out_dir, progress=None, cancel_event=None):
    """
    Imports zip_path into out_dir/<new id>.db.
    Returns the registry info dict for the new dictionary.
    progress(fraction, message) is called as banks are processed.
    """
    started = time.time()

    def report(fraction, message):
        if progress:
            progress(fraction, message)

    def check_cancel():
        if cancel_event is not None and cancel_event.is_set():
            raise ImportCancelled()

    with zipfile.ZipFile(zip_path) as z:
        members = _member_map(z)
        index = _read_index(z, members)
        version = index["format"]

        banks = {}
        for base, name in members.items():
            m = _BANK_RE.match(base)
            if m:
                banks.setdefault(m.group(1), []).append((int(m.group(2)), name))
        for kind in banks:
            banks[kind].sort()
        total_banks = sum(len(v) for v in banks.values()) or 1

        dict_id = uuid.uuid4().hex[:12]
        final_path = os.path.join(out_dir, f"{dict_id}.db")
        temp_path = final_path + ".importing"

        conn = sqlite3.connect(temp_path)
        try:
            conn.execute("PRAGMA journal_mode=OFF")
            conn.execute("PRAGMA synchronous=OFF")
            conn.executescript(_SCHEMA)

            counts = {"terms": 0, "termMeta": 0, "kanji": 0, "kanjiMeta": 0, "tags": 0}
            meta_modes = set()
            done = 0

            # Tags declared in old-style index.json
            for name, t in (index.get("tagMeta") or {}).items():
                conn.execute("INSERT OR REPLACE INTO tags VALUES (?,?,?,?,?)",
                             (name, t.get("category", ""), t.get("order", 0), t.get("notes", ""), t.get("score", 0)))
                counts["tags"] += 1

            for _, name in banks.get("tag_bank", []):
                check_cancel()
                rows = json.loads(z.read(name).decode("utf-8-sig"))
                conn.executemany("INSERT OR REPLACE INTO tags VALUES (?,?,?,?,?)", [
                    (r[0], r[1] if len(r) > 1 else "", r[2] if len(r) > 2 else 0,
                     r[3] if len(r) > 3 else "", r[4] if len(r) > 4 else 0)
                    for r in rows
                ])
                counts["tags"] += len(rows)
                done += 1
                report(done / total_banks, "Importing tags")

            zdict = None
            # Priming a compressor with the preset dictionary is the expensive
            # part, so prime one and clone it per row.
            base_compressor = None
            term_banks = banks.get("term_bank", [])
            for bank_no, (_, name) in enumerate(term_banks):
                check_cancel()
                rows = json.loads(z.read(name).decode("utf-8-sig"))
                if version == 3:
                    norm = [(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]) for r in rows]
                else:
                    norm = [(r[0], r[1], r[2], r[3], r[4], list(r[5:]), None, "") for r in rows]

                if bank_no == 0:
                    step = max(1, len(norm) // 400)
                    zdict = _build_zdict(g for i, (*_, g, _s, _t) in enumerate(norm) if i % step == 0)
                    if zdict:
                        conn.execute("INSERT INTO blobs VALUES ('zdict', ?)", (zdict,))
                        base_compressor = zlib.compressobj(level=6, zdict=zdict)
                    else:
                        base_compressor = zlib.compressobj(level=6)

                def pack(glossary):
                    c = base_compressor.copy()
                    return c.compress(_compact(glossary).encode("utf-8")) + c.flush()

                conn.executemany(
                    "INSERT INTO terms (expression, reading, def_tags, rules, score, glossary, sequence, term_tags) "
                    "VALUES (?,?,?,?,?,?,?,?)",
                    [(e, rd or "", dt or "", ru or "", sc or 0, pack(g), sq, tt or "")
                     for e, rd, dt, ru, sc, g, sq, tt in norm],
                )
                counts["terms"] += len(norm)
                done += 1
                report(done / total_banks, f"Importing terms ({counts['terms']:,})")

            for _, name in banks.get("term_meta_bank", []):
                check_cancel()
                rows = json.loads(z.read(name).decode("utf-8-sig"))
                conn.executemany("INSERT INTO term_meta VALUES (?,?,?)",
                                 [(r[0], r[1], _compact(r[2])) for r in rows])
                meta_modes.update(r[1] for r in rows)
                counts["termMeta"] += len(rows)
                done += 1
                report(done / total_banks, f"Importing term metadata ({counts['termMeta']:,})")

            for _, name in banks.get("kanji_bank", []):
                check_cancel()
                rows = json.loads(z.read(name).decode("utf-8-sig"))
                if version == 3:
                    norm = [(r[0], r[1], r[2], r[3], _compact(r[4]), _compact(r[5] if len(r) > 5 else {}))
                            for r in rows]
                else:
                    norm = [(r[0], r[1], r[2], r[3], _compact(list(r[4:])), "{}") for r in rows]
                conn.executemany("INSERT INTO kanji VALUES (?,?,?,?,?,?)", norm)
                counts["kanji"] += len(rows)
                done += 1
                report(done / total_banks, f"Importing kanji ({counts['kanji']:,})")

            for _, name in banks.get("kanji_meta_bank", []):
                check_cancel()
                rows = json.loads(z.read(name).decode("utf-8-sig"))
                conn.executemany("INSERT INTO kanji_meta VALUES (?,?,?)",
                                 [(r[0], r[1], _compact(r[2])) for r in rows])
                counts["kanjiMeta"] += len(rows)
                done += 1
                report(done / total_banks, "Importing kanji metadata")

            if not any(counts[k] for k in ("terms", "termMeta", "kanji", "kanjiMeta")):
                raise DictionaryImportError("Dictionary contains no entries")

            styles = ""
            if "styles.css" in members:
                styles = z.read(members["styles.css"]).decode("utf-8", errors="replace")
            conn.execute("INSERT INTO meta VALUES ('index', ?)", (_compact(index),))
            conn.execute("INSERT INTO meta VALUES ('styles', ?)", (styles,))

            check_cancel()
            report(0.99, "Building search index")
            conn.executescript(_INDEXES)
            conn.commit()
        except BaseException:
            conn.close()
            if os.path.exists(temp_path):
                os.remove(temp_path)
            raise
        conn.close()

    os.replace(temp_path, final_path)

    kinds = []
    if counts["terms"]:
        kinds.append("terms")
    for mode, label in (("freq", "frequency"), ("pitch", "pitch"), ("ipa", "ipa")):
        if mode in meta_modes:
            kinds.append(label)
    if counts["kanji"] or counts["kanjiMeta"]:
        kinds.append("kanji")

    info = {
        "id": dict_id,
        "title": index["title"],
        "revision": index["revision"],
        "kinds": kinds,
        "counts": counts,
        "sizeBytes": os.path.getsize(final_path),
        "importedAt": time.time(),
        "index": {k: index[k] for k in (
            "title", "revision", "format", "author", "url", "description", "attribution",
            "isUpdatable", "indexUrl", "downloadUrl", "sequenced", "frequencyMode",
            "sourceLanguage", "targetLanguage",
        ) if k in index},
    }
    logger.info(f"Imported dictionary '{index['title']}' in {time.time() - started:.1f}s: {counts}")
    return info
