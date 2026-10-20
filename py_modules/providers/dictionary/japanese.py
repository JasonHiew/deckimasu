# providers/dictionary/japanese.py
# Japanese text helpers for dictionary lookups: kana conversion, width
# normalization, emphatic-sequence collapsing and furigana distribution.
# Ported from Yomitan's ext/js/language/ja/japanese.js (GPL-3.0-or-later).

HIRAGANA_SMALL_TSU = 0x3063
KATAKANA_SMALL_TSU = 0x30C3
KATAKANA_SMALL_KA = 0x30F5
KATAKANA_SMALL_KE = 0x30F6
PROLONGED_SOUND_MARK = 0x30FC

HIRAGANA_RANGE = (0x3040, 0x309F)
KATAKANA_RANGE = (0x30A0, 0x30FF)
HIRAGANA_CONVERSION_RANGE = (0x3041, 0x3096)
KATAKANA_CONVERSION_RANGE = (0x30A1, 0x30F6)
CJK_COMPATIBILITY = (0x3300, 0x33FF)

CJK_IDEOGRAPH_RANGES = (
    (0x4E00, 0x9FFF),
    (0x3400, 0x4DBF),
    (0x20000, 0x2A6DF),
    (0x2A700, 0x2B73F),
    (0x2B740, 0x2B81F),
    (0x2B820, 0x2CEAF),
    (0x2CEB0, 0x2EBEF),
    (0x30000, 0x3134F),
    (0x31350, 0x323AF),
    (0x2EBF0, 0x2EE5F),
    (0xF900, 0xFAFF),
    (0x2F800, 0x2FA1F),
)

JAPANESE_RANGES = (
    HIRAGANA_RANGE,
    KATAKANA_RANGE,
    *CJK_IDEOGRAPH_RANGES,
    (0xFF66, 0xFF9F),  # Halfwidth katakana
    (0x30FB, 0x30FC),  # Katakana punctuation
    (0xFF61, 0xFF65),  # Kana punctuation
    (0x3000, 0x303F),  # CJK punctuation
    (0xFF00, 0xFFEF),  # Fullwidth characters
)

SMALL_KANA = set("ぁぃぅぇぉゃゅょゎァィゥェォャュョヮ")

HALFWIDTH_KATAKANA_MAPPING = {
    "･": "・--", "ｦ": "ヲヺ-", "ｧ": "ァ--", "ｨ": "ィ--", "ｩ": "ゥ--", "ｪ": "ェ--",
    "ｫ": "ォ--", "ｬ": "ャ--", "ｭ": "ュ--", "ｮ": "ョ--", "ｯ": "ッ--", "ｰ": "ー--",
    "ｱ": "ア--", "ｲ": "イ--", "ｳ": "ウヴ-", "ｴ": "エ--", "ｵ": "オ--", "ｶ": "カガ-",
    "ｷ": "キギ-", "ｸ": "クグ-", "ｹ": "ケゲ-", "ｺ": "コゴ-", "ｻ": "サザ-", "ｼ": "シジ-",
    "ｽ": "スズ-", "ｾ": "セゼ-", "ｿ": "ソゾ-", "ﾀ": "タダ-", "ﾁ": "チヂ-", "ﾂ": "ツヅ-",
    "ﾃ": "テデ-", "ﾄ": "トド-", "ﾅ": "ナ--", "ﾆ": "ニ--", "ﾇ": "ヌ--", "ﾈ": "ネ--",
    "ﾉ": "ノ--", "ﾊ": "ハバパ", "ﾋ": "ヒビピ", "ﾌ": "フブプ", "ﾍ": "ヘベペ", "ﾎ": "ホボポ",
    "ﾏ": "マ--", "ﾐ": "ミ--", "ﾑ": "ム--", "ﾒ": "メ--", "ﾓ": "モ--", "ﾔ": "ヤ--",
    "ﾕ": "ユ--", "ﾖ": "ヨ--", "ﾗ": "ラ--", "ﾘ": "リ--", "ﾙ": "ル--", "ﾚ": "レ--",
    "ﾛ": "ロ--", "ﾜ": "ワ--", "ﾝ": "ン--",
}

_VOWEL_TO_KANA = {
    "a": "ぁあかがさざただなはばぱまゃやらゎわヵァアカガサザタダナハバパマャヤラヮワヵヷ",
    "i": "ぃいきぎしじちぢにひびぴみりゐィイキギシジチヂニヒビピミリヰヸ",
    "u": "ぅうくぐすずっつづぬふぶぷむゅゆるゥウクグスズッツヅヌフブプムュユルヴ",
    "e": "ぇえけげせぜてでねへべぺめれゑヶェエケゲセゼテデネヘベペメレヱヶヹ",
    "o": "ぉおこごそぞとどのほぼぽもょよろをォオコゴソゾトドノホボポモョヨロヲヺ",
    "": "のノ",
}
_KANA_TO_VOWEL = {c: v for v, chars in _VOWEL_TO_KANA.items() for c in chars}
_PROLONGED_HIRAGANA = {"a": "あ", "i": "い", "u": "う", "e": "え", "o": "う"}


def _in_range(cp, r):
    return r[0] <= cp <= r[1]


def _in_ranges(cp, ranges):
    for lo, hi in ranges:
        if lo <= cp <= hi:
            return True
    return False


def is_code_point_kanji(cp):
    return _in_ranges(cp, CJK_IDEOGRAPH_RANGES)


def is_code_point_kana(cp):
    return _in_range(cp, HIRAGANA_RANGE) or _in_range(cp, KATAKANA_RANGE)


def is_code_point_japanese(cp):
    return _in_ranges(cp, JAPANESE_RANGES)


def is_string_partially_japanese(text):
    return any(is_code_point_japanese(ord(c)) for c in text)


def is_string_entirely_kana(text):
    return bool(text) and all(is_code_point_kana(ord(c)) for c in text)


def get_kana_mora_count(text):
    count = 0
    for c in text:
        if not (c in SMALL_KANA and count > 0):
            count += 1
    return count


def convert_katakana_to_hiragana(text, keep_prolonged_sound_marks=False):
    offset = HIRAGANA_CONVERSION_RANGE[0] - KATAKANA_CONVERSION_RANGE[0]
    result = []
    for c in text:
        cp = ord(c)
        if cp in (KATAKANA_SMALL_KA, KATAKANA_SMALL_KE):
            pass
        elif cp == PROLONGED_SOUND_MARK:
            if not keep_prolonged_sound_marks and result:
                c2 = _PROLONGED_HIRAGANA.get(_KANA_TO_VOWEL.get(result[-1]))
                if c2 is not None:
                    c = c2
        elif _in_range(cp, KATAKANA_CONVERSION_RANGE):
            c = chr(cp + offset)
        result.append(c)
    return "".join(result)


def convert_hiragana_to_katakana(text):
    offset = KATAKANA_CONVERSION_RANGE[0] - HIRAGANA_CONVERSION_RANGE[0]
    return "".join(
        chr(ord(c) + offset) if _in_range(ord(c), HIRAGANA_CONVERSION_RANGE) else c
        for c in text
    )


def convert_alphanumeric_to_full_width(text):
    out = []
    for c in text:
        cp = ord(c)
        if 0x30 <= cp <= 0x39:
            cp += 0xFF10 - 0x30
        elif 0x41 <= cp <= 0x5A:
            cp += 0xFF21 - 0x41
        elif 0x61 <= cp <= 0x7A:
            cp += 0xFF41 - 0x61
        out.append(chr(cp))
    return "".join(out)


def convert_full_width_alphanumeric_to_normal(text):
    out = []
    for c in text:
        cp = ord(c)
        if 0xFF10 <= cp <= 0xFF19:
            cp -= 0xFF10 - 0x30
        elif 0xFF21 <= cp <= 0xFF3A:
            cp -= 0xFF21 - 0x41
        elif 0xFF41 <= cp <= 0xFF5A:
            cp -= 0xFF41 - 0x61
        out.append(chr(cp))
    return "".join(out)


def convert_half_width_kana_to_full_width(text):
    out = []
    i = 0
    n = len(text)
    while i < n:
        c = text[i]
        mapping = HALFWIDTH_KATAKANA_MAPPING.get(c)
        if mapping is None:
            out.append(c)
            i += 1
            continue
        index = 0
        nxt = ord(text[i + 1]) if i + 1 < n else 0
        if nxt == 0xFF9E:
            index = 1
        elif nxt == 0xFF9F:
            index = 2
        c2 = mapping[index]
        if index > 0:
            if c2 == "-":
                c2 = mapping[0]
            else:
                i += 1
        out.append(c2)
        i += 1
    return "".join(out)


def _dakuten_allowed(cp):
    return (0x304B <= cp <= 0x3068 or 0x306F <= cp <= 0x307B
            or 0x30AB <= cp <= 0x30C8 or 0x30CF <= cp <= 0x30DB)


def _handakuten_allowed(cp):
    return 0x306F <= cp <= 0x307B or 0x30CF <= cp <= 0x30DB


def normalize_combining_characters(text):
    result = []
    i = len(text) - 1
    while i > 0:
        c = text[i]
        if c == "゙":
            prev = ord(text[i - 1])
            if _dakuten_allowed(prev):
                result.append(chr(prev + 1))
                i -= 2
                continue
        elif c == "゚":
            prev = ord(text[i - 1])
            if _handakuten_allowed(prev):
                result.append(chr(prev + 2))
                i -= 2
                continue
        result.append(c)
        i -= 1
    if i == 0:
        result.append(text[0])
    return "".join(reversed(result))


def normalize_cjk_compatibility_characters(text):
    import unicodedata
    return "".join(
        unicodedata.normalize("NFKD", c) if _in_range(ord(c), CJK_COMPATIBILITY) else c
        for c in text
    )


def _is_emphatic(cp):
    return cp in (HIRAGANA_SMALL_TSU, KATAKANA_SMALL_TSU, PROLONGED_SOUND_MARK)


def collapse_emphatic_sequences(text, full_collapse):
    left = 0
    while left < len(text) and _is_emphatic(ord(text[left])):
        left += 1
    right = len(text) - 1
    while right >= 0 and _is_emphatic(ord(text[right])):
        right -= 1
    if left > right:
        return text

    middle = []
    current = -1
    for i in range(left, right + 1):
        c = text[i]
        cp = ord(c)
        if _is_emphatic(cp):
            if current != cp:
                current = cp
                if not full_collapse:
                    middle.append(c)
        else:
            current = -1
            middle.append(c)
    return text[:left] + "".join(middle) + text[right + 1:]


# Text preprocessors, applied in this order. Each returns the variants it can
# produce (always including the input). Mirrors Yomitan's Japanese descriptor,
# minus romaji conversion and the kanji/radical variant tables.
def _p_half_width(s):
    return [s, convert_half_width_kana_to_full_width(s)]


def _p_combining(s):
    return [s, normalize_combining_characters(s)]


def _p_cjk_compat(s):
    return [s, normalize_cjk_compatibility_characters(s)]


def _p_alnum_width(s):
    return [s, convert_full_width_alphanumeric_to_normal(s), convert_alphanumeric_to_full_width(s)]


def _p_kana(s):
    return [s, convert_hiragana_to_katakana(s), convert_katakana_to_hiragana(s)]


def _p_emphatic(s):
    return [s, collapse_emphatic_sequences(s, False), collapse_emphatic_sequences(s, True)]


TEXT_PREPROCESSORS = (
    ("convertHalfWidthCharacters", _p_half_width),
    ("normalizeCombiningCharacters", _p_combining),
    ("normalizeCJKCompatibilityCharacters", _p_cjk_compat),
    ("alphanumericWidthVariants", _p_alnum_width),
    ("convertHiraganaToKatakana", _p_kana),
    ("collapseEmphaticSequences", _p_emphatic),
)


def get_text_variants(text, cache):
    """Returns {variant: [processor-chain, ...]} for every preprocessor combination."""
    variants = {text: [[]]}
    for pid, process in TEXT_PREPROCESSORS:
        new_variants = {}
        for variant, chains in variants.items():
            key = (variant, pid)
            processed_list = cache.get(key)
            if processed_list is None:
                processed_list = process(variant)
                cache[key] = processed_list
            for processed in processed_list:
                existing = new_variants.get(processed)
                if processed == variant:
                    if existing is None:
                        new_variants[processed] = chains
                elif existing is None:
                    new_variants[processed] = [chain + [pid] for chain in chains]
                else:
                    new_variants[processed] = existing + [chain + [pid] for chain in chains]
        variants = new_variants
    return variants


# Furigana distribution

def _segmentize_furigana(reading, reading_normalized, groups, start):
    group_count = len(groups) - start
    if group_count <= 0:
        return [] if len(reading) == 0 else None

    is_kana, text, text_normalized = groups[start]
    text_length = len(text)
    if is_kana:
        if text_normalized is not None and reading_normalized.startswith(text_normalized):
            segments = _segmentize_furigana(
                reading[text_length:], reading_normalized[text_length:], groups, start + 1)
            if segments is not None:
                if reading.startswith(text):
                    return [[text, ""]] + segments
                return _get_furigana_kana_segments(text, reading) + segments
        return None

    result = None
    for i in range(len(reading), text_length - 1, -1):
        segments = _segmentize_furigana(reading[i:], reading_normalized[i:], groups, start + 1)
        if segments is not None:
            if result is not None:
                return None  # Ambiguous
            result = [[text, reading[:i]]] + segments
        if group_count == 1:
            break
    return result


def _get_furigana_kana_segments(text, reading):
    segments = []
    start = 0
    state = reading[:1] == text[:1]
    for i in range(1, len(text)):
        new_state = reading[i:i + 1] == text[i]
        if state == new_state:
            continue
        segments.append([text[start:i], "" if state else reading[start:i]])
        state = new_state
        start = i
    segments.append([text[start:], "" if state else reading[start:len(text)]])
    return segments


def distribute_furigana(term, reading):
    """Splits term into [[text, ruby], ...] segments; ruby is '' for kana parts."""
    if not reading or reading == term:
        return [[term, ""]]

    groups = []
    is_kana_pre = None
    for c in term:
        is_kana = is_code_point_kana(ord(c))
        if is_kana == is_kana_pre:
            groups[-1][1] += c
        else:
            groups.append([is_kana, c, None])
            is_kana_pre = is_kana
    for group in groups:
        if group[0]:
            group[2] = convert_katakana_to_hiragana(group[1])

    segments = _segmentize_furigana(reading, convert_katakana_to_hiragana(reading), groups, 0)
    if segments is not None:
        return segments
    return [[term, reading]]
