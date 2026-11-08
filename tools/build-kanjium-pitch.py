#!/usr/bin/env python3
"""Builds the bundled pitch accent dictionary from Kanjium's accents.txt.

Kanjium (https://github.com/mifunetoshiro/kanjium) is licensed CC BY-SA 4.0,
so the Yomitan dictionary this produces is too.

Usage:
    python tools/build-kanjium-pitch.py accents.txt OUT.zip [kanjium-commit]

accents.txt is data/source_files/raw/accents.txt from the Kanjium repo. Each
line is "term<TAB>reading<TAB>accents": the reading is empty when the term is
already kana, and accents is a comma list of downstep positions, some prefixed
with a part of speech in parentheses, e.g. "(副)1,(形動)0".
"""

import json
import re
import sys
import zipfile

BANK_SIZE = 10000
_ACCENT = re.compile(r"^(?:\(([^)]*)\))?(\d+)$")


def parse(path):
    entries = {}
    with open(path, encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            parts = line.rstrip("\n").split("\t")
            if len(parts) != 3 or not parts[0]:
                continue
            term, reading, accents = parts
            reading = reading or term
            positions = []
            pos_tag = None
            for item in accents.split(","):
                m = _ACCENT.match(item.strip())
                if not m:
                    print(f"line {line_no}: skipping accent {item!r}", file=sys.stderr)
                    continue
                # A part-of-speech prefix applies to the numbers after it until the next one
                if m.group(1) is not None:
                    pos_tag = m.group(1)
                position = int(m.group(2))
                if position not in positions:
                    positions.append(position)
            if positions:
                key = (term, reading)
                merged = entries.setdefault(key, [])
                merged.extend(p for p in positions if p not in merged)
    return entries


def build(entries, out_zip, revision):
    rows = [[term, "pitch", {"reading": reading, "pitches": [{"position": p} for p in positions]}]
            for (term, reading), positions in entries.items()]
    index = {
        "title": "Kanjium Pitch Accents",
        "format": 3,
        "revision": revision,
        "sequenced": False,
        "author": "mifunetoshiro (Kanjium), from Uros O.'s database",
        "url": "https://github.com/mifunetoshiro/kanjium",
        "description": "Pitch accent for Japanese words, converted from Kanjium's accents.txt.",
        "attribution": "Pitch accent data from Kanjium (https://github.com/mifunetoshiro/kanjium), "
                       "provided by Uros O. through his free database. Licensed CC BY-SA 4.0 "
                       "(https://creativecommons.org/licenses/by-sa/4.0/). Converted to Yomitan "
                       "format for decky-ocr-notify.",
    }
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr("index.json", json.dumps(index, ensure_ascii=False))
        for i in range(0, len(rows), BANK_SIZE):
            z.writestr(f"term_meta_bank_{i // BANK_SIZE + 1}.json",
                       json.dumps(rows[i:i + BANK_SIZE], ensure_ascii=False, separators=(",", ":")))
    return len(rows)


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    commit = sys.argv[3] if len(sys.argv) > 3 else "unknown"
    count = build(parse(sys.argv[1]), sys.argv[2], f"kanjium-{commit}")
    print(f"Wrote {count} entries to {sys.argv[2]}")
