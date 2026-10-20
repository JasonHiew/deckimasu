// src/dictionary/types.ts - Shapes returned by the dictionary_* backend methods

export interface DictionaryTag {
    name: string;
    category: string;
    notes: string;
    order: number;
}

export interface DictionaryDefinition {
    dictionary: string;
    score: number;
    sequence: number | null;
    tags: DictionaryTag[];
    glossary: any[];
    isForms: boolean;
}

export interface DictionaryEntry {
    term: string;
    reading: string;
    furigana: [string, string][];
    matchLength: number;
    sourceText: string;
    inflections: { name: string; description?: string }[][];
    termTags: DictionaryTag[];
    frequencies: { dictionary: string; value: number | null; displayValue: string }[];
    pitches: { dictionary: string; positions: (number | string)[] }[];
    definitions: DictionaryDefinition[];
}

export interface LookupResult {
    success: boolean;
    error?: string;
    message?: string;
    matchStart: number;
    matchEnd: number;
    entries: DictionaryEntry[];
    elapsedMs?: number;
    hasDictionaries?: boolean;
}

export interface InstalledDictionary {
    id: string;
    title: string;
    revision: string;
    enabled: boolean;
    kinds: string[];
    counts: { terms?: number; termMeta?: number; kanji?: number; kanjiMeta?: number; tags?: number };
    sizeBytes: number;
    importedAt: number;
    author: string;
    attribution: string;
    description: string;
    url: string;
    isUpdatable: boolean;
    latestRevision: string | null;
    updateAvailable: boolean;
}

export interface RecommendedDictionary {
    key: string;
    name: string;
    description: string;
    indexUrl: string;
    downloadUrl: string;
    approxDownloadMb: number;
    approxInstalledMb: number;
    installed: boolean;
}

export interface DictionaryJobStatus {
    busy: boolean;
    title: string;
    phase: string;
    progress: number;
    message: string;
    queued: number;
    lastError: string | null;
    lastMessage: string | null;
    lastUpdateCheck: number;
}

export interface DictionaryState {
    available: boolean;
    error?: string;
    dictionaries?: InstalledDictionary[];
    recommended?: RecommendedDictionary[];
    status?: DictionaryJobStatus;
    attribution?: string;
}
