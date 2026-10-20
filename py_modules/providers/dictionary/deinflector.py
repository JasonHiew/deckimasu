# providers/dictionary/deinflector.py
# Rule-based Japanese deinflection. A port of Yomitan's LanguageTransformer
# (ext/js/language/language-transformer.js, GPL-3.0-or-later) driven by the rule
# table generated from japanese-transforms.js by tools/gen_japanese_transforms.mjs.

import json
import logging
import os

logger = logging.getLogger(__name__)

_RULES_PATH = os.path.join(os.path.dirname(__file__), "japanese_transforms.json")


class _Rule:
    __slots__ = ("type", "inflected", "deinflected", "conditions_in", "conditions_out")

    def __init__(self, rule_type, inflected, deinflected, conditions_in, conditions_out):
        self.type = rule_type
        self.inflected = inflected
        self.deinflected = deinflected
        self.conditions_in = conditions_in
        self.conditions_out = conditions_out

    def matches(self, text):
        if self.type == "suffix":
            return text.endswith(self.inflected)
        if self.type == "prefix":
            return text.startswith(self.inflected)
        return text == self.inflected  # wholeWord

    def apply(self, text):
        if self.type == "suffix":
            return text[:len(text) - len(self.inflected)] + self.deinflected
        if self.type == "prefix":
            return self.deinflected + text[len(self.inflected):]
        return self.deinflected


class _Transform:
    __slots__ = ("id", "name", "description", "rules", "suffixes", "prefixes", "whole_words")

    def __init__(self, transform_id, name, description, rules):
        self.id = transform_id
        self.name = name
        self.description = description
        self.rules = rules
        # Cheap pre-check standing in for Yomitan's combined "heuristic" RegExp
        self.suffixes = tuple(r.inflected for r in rules if r.type == "suffix")
        self.prefixes = tuple(r.inflected for r in rules if r.type == "prefix")
        self.whole_words = frozenset(r.inflected for r in rules if r.type == "wholeWord")

    def may_match(self, text):
        return ((self.suffixes and text.endswith(self.suffixes))
                or (self.prefixes and text.startswith(self.prefixes))
                or text in self.whole_words)


class Deinflector:
    def __init__(self, rules_path=_RULES_PATH):
        with open(rules_path, encoding="utf-8") as f:
            descriptor = json.load(f)

        self._condition_flags = self._build_condition_flags(descriptor["conditions"])
        self._part_of_speech_flags = {
            cid: self._condition_flags[cid]
            for cid, c in descriptor["conditions"].items() if c.get("isDictionaryForm")
        }

        self._transforms = []
        for tid, t in descriptor["transforms"].items():
            rules = [
                _Rule(rtype, inflected, deinflected,
                      self._flags_strict(c_in, tid), self._flags_strict(c_out, tid))
                for rtype, inflected, deinflected, c_in, c_out in t["rules"]
            ]
            self._transforms.append(_Transform(tid, t["name"], t.get("description", ""), rules))
        self._transforms_by_id = {t.id: t for t in self._transforms}

    @staticmethod
    def _build_condition_flags(conditions):
        flags_map = {}
        next_index = 0
        targets = list(conditions.items())
        while targets:
            next_targets = []
            for cid, cond in targets:
                sub = cond.get("subConditions")
                if sub is None:
                    flags_map[cid] = 1 << next_index
                    next_index += 1
                    continue
                if all(s in flags_map for s in sub):
                    flags = 0
                    for s in sub:
                        flags |= flags_map[s]
                    flags_map[cid] = flags
                else:
                    next_targets.append((cid, cond))
            if len(next_targets) == len(targets):
                raise ValueError("Cycle in deinflection subConditions")
            targets = next_targets
        return flags_map

    def _flags_strict(self, condition_ids, transform_id):
        flags = 0
        for cid in condition_ids:
            if cid not in self._condition_flags:
                raise ValueError(f"Unknown condition {cid!r} in transform {transform_id!r}")
            flags |= self._condition_flags[cid]
        return flags

    def condition_flags_from_parts_of_speech(self, parts_of_speech):
        flags = 0
        for pos in parts_of_speech:
            flags |= self._part_of_speech_flags.get(pos, 0)
        return flags

    @staticmethod
    def conditions_match(current, nxt):
        return current == 0 or (current & nxt) != 0

    def transform(self, source):
        """Returns [(text, conditions, trace)] where trace lists transform ids, outermost first."""
        results = [(source, 0, ())]
        seen_frames = [frozenset()]
        i = 0
        while i < len(results):
            text, conditions, trace = results[i]
            frames = seen_frames[i]
            for transform in self._transforms:
                if not transform.may_match(text):
                    continue
                for j, rule in enumerate(transform.rules):
                    if not (conditions == 0 or (conditions & rule.conditions_in) != 0):
                        continue
                    if not rule.matches(text):
                        continue
                    frame = (transform.id, j, text)
                    if frame in frames:
                        continue  # Cycle
                    results.append((rule.apply(text), rule.conditions_out, (transform.id,) + trace))
                    seen_frames.append(frames | {frame})
            i += 1
        return results

    def describe(self, transform_id):
        t = self._transforms_by_id.get(transform_id)
        if t is None:
            return {"name": transform_id}
        return {"name": t.name, "description": t.description} if t.description else {"name": t.name}
