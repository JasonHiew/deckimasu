// src/dictionary/romaji.ts
// Kana to Hepburn romaji for beginners who can't read kana yet. Meant for
// dictionary readings (single words), so particles are read as written
// (は = ha, not wa) and long vowels are spelled out (おう = ou, ー repeats).

const BASE: Record<string, string> = {
    あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
    か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
    さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
    た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
    な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
    は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
    ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
    や: 'ya', ゆ: 'yu', よ: 'yo',
    ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
    わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n',
    が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
    ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
    だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
    ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
    ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
    ゔ: 'vu',
    ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
};

// Two-kana combinations (yōon and the katakana extensions for loanwords)
const COMBOS: Record<string, string> = {
    きゃ: 'kya', きゅ: 'kyu', きょ: 'kyo', しゃ: 'sha', しゅ: 'shu', しょ: 'sho', しぇ: 'she',
    ちゃ: 'cha', ちゅ: 'chu', ちょ: 'cho', ちぇ: 'che', にゃ: 'nya', にゅ: 'nyu', にょ: 'nyo',
    ひゃ: 'hya', ひゅ: 'hyu', ひょ: 'hyo', みゃ: 'mya', みゅ: 'myu', みょ: 'myo',
    りゃ: 'rya', りゅ: 'ryu', りょ: 'ryo', ぎゃ: 'gya', ぎゅ: 'gyu', ぎょ: 'gyo',
    じゃ: 'ja', じゅ: 'ju', じょ: 'jo', じぇ: 'je', ぢゃ: 'ja', ぢゅ: 'ju', ぢょ: 'jo',
    びゃ: 'bya', びゅ: 'byu', びょ: 'byo', ぴゃ: 'pya', ぴゅ: 'pyu', ぴょ: 'pyo',
    ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo', てぃ: 'ti', でぃ: 'di', とぅ: 'tu', どぅ: 'du',
    うぃ: 'wi', うぇ: 'we', うぉ: 'wo', ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo',
    つぁ: 'tsa', つぃ: 'tsi', つぇ: 'tse', つぉ: 'tso', いぇ: 'ye',
};

const toHiragana = (s: string) =>
    s.replace(/[\u30a1-\u30f6]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0x60));

/** Romaji for a kana string; characters that aren't kana are kept as they are. */
export function toRomaji(kana: string): string {
    const s = toHiragana(kana);
    let out = '';
    let doubleNext = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === 'っ') {
            doubleNext = true;
            continue;
        }
        if (ch === 'ー') {
            const vowel = out.match(/[aeiou](?=[^aeiou]*$)/);
            out += vowel ? vowel[0] : '';
            continue;
        }
        let syllable = COMBOS[s.slice(i, i + 2)];
        if (syllable) i++;
        else syllable = BASE[ch] ?? ch;
        if (doubleNext) {
            // っ doubles the next consonant; before ch it is written t (matcha)
            out += syllable.startsWith('ch') ? 't' : /^[a-z]/.test(syllable) && !/^[aeiou]/.test(syllable) ? syllable[0] : '';
            doubleNext = false;
        }
        // ん before a vowel or y is written n' so it isn't read as na/ni/nya
        if (out.endsWith('n') && s[i - 1] === 'ん' && /^[aeiouy]/.test(syllable)) out += "'";
        out += syllable;
    }
    return out;
}

// Whether romaji is shown in the dictionary; a per-device preference
const ROMAJI_KEY = 'decky-ocr-notify.showRomaji';

export function getShowRomaji(): boolean {
    try {
        return localStorage.getItem(ROMAJI_KEY) === '1';
    } catch {
        return false;
    }
}

export function setShowRomaji(on: boolean): void {
    try {
        localStorage.setItem(ROMAJI_KEY, on ? '1' : '0');
    } catch {
        // not persisted
    }
}
