// src/dictionary/furigana.ts
// Furigana for the overlay's original (recognized) text. Readings come from the
// installed dictionaries by greedy longest match (backend dictionary_annotate),
// so a word with several readings, or a name, is sometimes read wrong.

import { call } from "@decky/api";

/** [text, ruby] pairs covering a caption; ruby is '' where there is none */
export type FuriganaSegments = [string, string][];

const FURIGANA_KEY = 'decky-ocr-notify.showFurigana';

// On unless turned off; a per-device preference like romaji
export function getShowFurigana(): boolean {
    try {
        return localStorage.getItem(FURIGANA_KEY) !== '0';
    } catch {
        return true;
    }
}

export function setShowFurigana(on: boolean): void {
    try {
        localStorage.setItem(FURIGANA_KEY, on ? '1' : '0');
    } catch {
        // not persisted
    }
}

/** Furigana for each text, or null when no dictionary is installed or the call failed */
export async function annotateTexts(texts: string[]): Promise<FuriganaSegments[] | null> {
    try {
        const res = await call<[string[]], { success: boolean; results?: FuriganaSegments[] }>('dictionary_annotate', texts);
        return res?.success && res.results ? res.results : null;
    } catch {
        return null;
    }
}
