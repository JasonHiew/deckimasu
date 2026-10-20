# providers/dictionary/lookup.py
# Yomitan-style term lookup: scan forward from a character, try every prefix
# (longest first) through text-variant preprocessing and rule deinflection,
# match the candidates against the enabled dictionaries, then group results by
# term+reading and rank them the way Yomitan's translator does.

import logging
import time

from . import japanese
from .deinflector import Deinflector

logger = logging.getLogger(__name__)

DEFAULT_SCAN_LENGTH = 16
DEFAULT_MAX_RESULTS = 32

# Characters skipped while scanning (OCR line breaks inside a box, spacing)
_SKIP_CHARS = set(" \t\r\n　")

_NO_FREQUENCY = float("inf")


class _Deinflection:
    __slots__ = ("original_text", "transformed_text", "deinflected_text", "conditions",
                 "processor_chains", "inflection_chain")

    def __init__(self, original_text, transformed_text, deinflected_text, conditions,
                 processor_chains, inflection_chain):
        self.original_text = original_text
        self.transformed_text = transformed_text
        self.deinflected_text = deinflected_text
        self.conditions = conditions
        self.processor_chains = processor_chains
        self.inflection_chain = inflection_chain


class LookupEngine:
    def __init__(self, store, deinflector=None):
        self._store = store
        self._deinflector = deinflector or Deinflector()

    # Public API

    def lookup(self, text, offset=0, scan_length=DEFAULT_SCAN_LENGTH, max_results=DEFAULT_MAX_RESULTS):
        """
        Looks up the word starting at text[offset].
        Returns {matchStart, matchEnd, entries, elapsedMs}; matchStart/End index into text.
        """
        started = time.perf_counter()
        offset = max(0, min(offset, len(text)))

        # Collapse skippable characters, remembering where each kept one came from
        scan_chars = []
        source_index = []
        for i in range(offset, len(text)):
            c = text[i]
            if c in _SKIP_CHARS:
                continue
            scan_chars.append(c)
            source_index.append(i)
            if len(scan_chars) >= scan_length:
                break
        scan_text = "".join(scan_chars)

        result = {"matchStart": offset, "matchEnd": offset, "entries": [], "elapsedMs": 0}
        if not scan_text or not japanese.is_code_point_japanese(ord(scan_text[0])):
            result["elapsedMs"] = round((time.perf_counter() - started) * 1000, 1)
            return result

        entries, match_length = self.find_terms(scan_text, max_results)
        if entries and match_length > 0:
            result["matchStart"] = source_index[0]
            result["matchEnd"] = source_index[match_length - 1] + 1
        result["entries"] = entries
        result["elapsedMs"] = round((time.perf_counter() - started) * 1000, 1)
        return result

    def find_terms(self, text, max_results=DEFAULT_MAX_RESULTS):
        """Returns (grouped_entries, longest_matched_source_length)."""
        handles = self._store.enabled_handles()
        term_dicts = [h for h in handles if h.info.get("counts", {}).get("terms")]
        meta_dicts = [h for h in handles if h.info.get("counts", {}).get("termMeta")]
        if not term_dicts:
            return [], 0

        deinflections = self._get_deinflections(text)
        by_text = {}
        for d in deinflections:
            by_text.setdefault(d.deinflected_text, []).append(d)

        # (dict_index, row id) -> [dict_index, handle, row, best deinflection, inflection chains]
        matches = {}
        for dict_index, handle in enumerate(term_dicts):
            try:
                rows = handle.find_terms(by_text.keys())
            except Exception as e:
                logger.error(f"Lookup failed in dictionary '{handle.title}': {e}")
                continue
            for row in rows:
                pos_flags = self._deinflector.condition_flags_from_parts_of_speech(row["rules"])
                keys = {row["expression"], row["reading"]}
                for key in keys:
                    for d in by_text.get(key, ()):
                        if not Deinflector.conditions_match(d.conditions, pos_flags):
                            continue
                        mkey = (dict_index, row["id"])
                        existing = matches.get(mkey)
                        if existing is None:
                            matches[mkey] = [dict_index, handle, row, d, {d.inflection_chain}]
                            continue
                        best = existing[3]
                        if self._deinflection_rank(d) < self._deinflection_rank(best):
                            existing[3] = d
                            existing[4] = {d.inflection_chain}
                        elif len(d.original_text) == len(best.original_text):
                            existing[4].add(d.inflection_chain)

        if not matches:
            return [], 0

        groups = self._group(matches.values())
        self._attach_meta(groups, meta_dicts)

        groups.sort(key=self._group_sort_key)
        groups = groups[:max_results]
        match_length = max(g["_maxOriginalLength"] for g in groups)
        return [self._finalize(g) for g in groups], match_length

    # Deinflection

    def _get_deinflections(self, text):
        deinflections = []
        cache = {}
        for length in range(len(text), 0, -1):
            raw = text[:length]
            for source, chains in japanese.get_text_variants(raw, cache).items():
                for deinflected, conditions, trace in self._deinflector.transform(source):
                    deinflections.append(_Deinflection(raw, source, deinflected, conditions, chains, trace))
        return deinflections

    @staticmethod
    def _shortest(chains):
        return min((len(c) for c in chains), default=0)

    def _deinflection_rank(self, d):
        # Longer source text wins, then fewer text-processing steps, then fewer inflections
        return (-len(d.original_text), self._shortest(d.processor_chains), len(d.inflection_chain))

    # Grouping and ranking

    def _group(self, matches):
        groups = {}
        for dict_index, handle, row, d, chains in matches:
            key = (row["expression"], row["reading"])
            g = groups.get(key)
            if g is None:
                g = {
                    "term": row["expression"],
                    "reading": row["reading"],
                    "_maxOriginalLength": 0,
                    "_processorChain": 99,
                    "_inflectionChain": 99,
                    "_exactMatch": 0,
                    "_dictIndex": dict_index,
                    "_score": row["score"],
                    "_inflections": set(),
                    "_sourceText": d.transformed_text,
                    "termTags": {},
                    "definitions": [],
                }
                groups[key] = g
            orig_len = len(d.original_text)
            if orig_len > g["_maxOriginalLength"]:
                g["_maxOriginalLength"] = orig_len
                g["_sourceText"] = d.transformed_text
                g["_processorChain"] = 99
                g["_inflectionChain"] = 99
                g["_inflections"] = set()
            if orig_len == g["_maxOriginalLength"]:
                g["_processorChain"] = min(g["_processorChain"], self._shortest(d.processor_chains))
                g["_inflectionChain"] = min(g["_inflectionChain"], min(len(c) for c in chains))
                g["_inflections"].update(chains)
                if row["expression"] == d.deinflected_text:
                    g["_exactMatch"] = 1
            g["_dictIndex"] = min(g["_dictIndex"], dict_index)
            g["_score"] = max(g["_score"], row["score"])

            tags = handle.tags()
            for t in row["termTags"]:
                g["termTags"].setdefault(t, self._tag(tags, t))
            g["definitions"].append({
                "dictionary": handle.title,
                "_dictIndex": dict_index,
                "_rowId": row["id"],
                "score": row["score"],
                "sequence": row["sequence"],
                "tags": [self._tag(tags, t) for t in row["defTags"]],
                "glossary": row["glossary"],
                "isForms": "forms" in row["defTags"],
            })
        return list(groups.values())

    @staticmethod
    def _tag(tags, name):
        t = tags.get(name)
        if t is None:
            return {"name": name, "category": "", "notes": "", "order": 0}
        return {"name": name, "category": t["category"], "notes": t["notes"], "order": t["order"]}

    @staticmethod
    def _group_sort_key(g):
        return (
            -g["_maxOriginalLength"],
            g["_processorChain"],
            g["_inflectionChain"],
            -g["_exactMatch"],
            tuple(sorted(g["_freqOrders"])) + (_NO_FREQUENCY,),
            g["_dictIndex"],
            -g["_score"],
            -len(g["term"]),
            g["term"],
        )

    # Frequency / pitch metadata

    def _attach_meta(self, groups, meta_dicts):
        terms = {g["term"] for g in groups}
        for g in groups:
            g["frequencies"] = []
            g["pitches"] = []
            # All ranks from the first frequency dictionary, best first. Comparing
            # the whole list breaks ties such as Jiten giving 昨日 rank 381 for
            # both readings but ranking the kana spelling きのう far above さくじつ.
            g["_freqOrders"] = []

        by_term = {}
        for g in groups:
            by_term.setdefault(g["term"], []).append(g)

        primary_freq_dict = None
        for handle in meta_dicts:
            try:
                rows = handle.find_term_meta(terms)
            except Exception as e:
                logger.error(f"Metadata lookup failed in '{handle.title}': {e}")
                continue
            occurrence_based = handle.info.get("index", {}).get("frequencyMode") == "occurrence-based"
            for expression, mode, data in rows:
                for g in by_term.get(expression, ()):
                    if mode == "freq":
                        freq = self._parse_frequency(data, g["reading"])
                        if freq is None:
                            continue
                        value, display = freq
                        g["frequencies"].append({"dictionary": handle.title, "value": value, "displayValue": display})
                        if primary_freq_dict in (None, handle.id) and isinstance(value, (int, float)):
                            primary_freq_dict = handle.id
                            g["_freqOrders"].append(-value if occurrence_based else value)
                    elif mode == "pitch":
                        if isinstance(data, dict) and data.get("reading") == g["reading"]:
                            positions = [p.get("position") for p in data.get("pitches", []) if isinstance(p, dict)]
                            if positions:
                                g["pitches"].append({"dictionary": handle.title, "positions": positions})

    @staticmethod
    def _parse_frequency(data, reading):
        # Reading-specific entries only apply to that reading; bare values apply to all
        if isinstance(data, dict) and "reading" in data:
            if data["reading"] != reading:
                return None
            data = data.get("frequency")
        if isinstance(data, dict):
            value = data.get("value")
            return value, str(data.get("displayValue", value))
        if isinstance(data, (int, float)):
            return data, str(data)
        if isinstance(data, str):
            return None, data
        return None

    # Output

    def _finalize(self, g):
        definitions = sorted(g["definitions"], key=lambda d: (d["isForms"], d["_dictIndex"], -d["score"], d["_rowId"]))
        for d in definitions:
            del d["_dictIndex"]
            del d["_rowId"]

        inflections = []
        for chain in sorted(g["_inflections"], key=len):
            if chain:
                inflections.append([self._deinflector.describe(t) for t in chain])

        return {
            "term": g["term"],
            "reading": g["reading"],
            "furigana": japanese.distribute_furigana(g["term"], g["reading"]),
            "matchLength": g["_maxOriginalLength"],
            "sourceText": g["_sourceText"],
            "inflections": inflections,
            "termTags": sorted(g["termTags"].values(), key=lambda t: (t["order"], t["name"])),
            "frequencies": g["frequencies"],
            "pitches": g["pitches"],
            "definitions": definitions,
        }
