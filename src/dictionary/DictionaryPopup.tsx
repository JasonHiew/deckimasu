// src/dictionary/DictionaryPopup.tsx
// Yomitan-style lookup popup shown when a text box on the overlay is tapped.
// The box's recognized text is shown as a strip of tappable characters; tapping
// one scans for the longest dictionary match starting there. Sending to the
// phone (ntfy) lives here as explicit buttons so lookups never send by accident.

import { call } from "@decky/api";
import { CSSProperties, VFC, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { logger } from "../Logger";
import type { NavButton } from "../Input";
import { Glossary } from "./StructuredContent";
import { PitchGraph } from "./PitchAccent";
import { getShowRomaji, toRomaji } from "./romaji";
import { Bookmark, DictionaryDefinition, DictionaryEntry, DictionaryJobStatus, DictionaryTag, LookupResult, bookmarkKey, progressFill } from "./types";

type HistoryItem =
    | { kind: 'scan'; offset: number }
    | { kind: 'term'; term: string };

const TAG_COLORS: Record<string, string> = {
    partOfSpeech: '#4a5f80',
    popular: '#2e6b48',
    frequent: '#2e6b48',
    archaism: '#7a5226',
    dictionary: '#6a4590',
    name: '#8a3a64',
    expression: '#4d6f2a',
};

// Popup size presets, cycled with the size button or Start. The last one
// leaves the bottom of the screen free for captions and subtitles.
const LAYOUTS: { label: string; width: string; maxHeight: string; narrow?: boolean; wide?: boolean }[] = [
    { label: '½', width: 'min(600px, 48vw)', maxHeight: 'calc(100vh - 24px)' },
    { label: '⅓', width: '33vw', maxHeight: 'calc(100vh - 24px)', narrow: true },
    { label: '⅔', width: '66vw', maxHeight: 'calc(100vh - 24px)' },
    // Full width, docked to the top or bottom edge; swapping moves it between them
    { label: 'Wide', width: 'calc(100vw - 24px)', maxHeight: '58vh', wide: true },
];
const LAYOUT_KEY = 'decky-ocr-notify.popupLayout';

function loadLayout(): number {
    try {
        const i = parseInt(localStorage.getItem(LAYOUT_KEY) || '0', 10);
        return i >= 0 && i < LAYOUTS.length ? i : 0;
    } catch {
        return 0;
    }
}

const BUTTON_STYLE: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    padding: '6px 12px',
    borderRadius: '14px',
    background: 'rgba(255,255,255,0.12)',
    color: '#fff',
    fontSize: '14px',
    fontWeight: 'bold',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    userSelect: 'none',
};

const SendIcon: VFC<{ size?: number }> = ({ size = 16 }) => (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#4caf50" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 2 11 13" />
        <path d="M22 2 15 22 11 13 2 9 22 2Z" />
    </svg>
);

const Tag: VFC<{ tag: DictionaryTag }> = ({ tag }) => (
    <span
        title={tag.notes || undefined}
        style={{
            display: 'inline-block',
            padding: '0 6px',
            marginRight: '4px',
            marginBottom: '2px',
            borderRadius: '4px',
            background: TAG_COLORS[tag.category] || '#555a63',
            color: '#fff',
            fontSize: '12px',
            lineHeight: '18px',
            fontWeight: 'bold',
            verticalAlign: 'middle',
        }}
    >
        {tag.name}
    </span>
);

const Headword: VFC<{ entry: DictionaryEntry }> = ({ entry }) => {
    const hasRuby = entry.furigana.some(([, ruby]) => ruby.length > 0);
    return (
        <span lang="ja" style={{ fontSize: '30px', lineHeight: hasRuby ? '1.5' : '1.2', whiteSpace: 'nowrap' }}>
            {entry.furigana.map(([text, ruby], i) =>
                ruby
                    ? <ruby key={i}>{text}<rt style={{ fontSize: '13px', opacity: 0.85 }}>{ruby}</rt></ruby>
                    : <span key={i}>{text}</span>
            )}
        </span>
    );
};

// Groups an entry's definitions by dictionary, keeping their sorted order
function groupByDictionary(definitions: DictionaryDefinition[]): [string, DictionaryDefinition[]][] {
    const groups: [string, DictionaryDefinition[]][] = [];
    for (const d of definitions) {
        const last = groups[groups.length - 1];
        if (last && last[0] === d.dictionary) last[1].push(d);
        else groups.push([d.dictionary, [d]]);
    }
    return groups;
}

// JMdict titles carry the release date ("JMdict [2026-10-20]"); drop it for labels
function shortDictionaryName(title: string): string {
    return title.replace(/\s*\[\d{4}-\d{2}-\d{2}\]\s*$/, '');
}

const EntryView: VFC<{
    entry: DictionaryEntry;
    selected: boolean;
    elementRef: (el: HTMLDivElement | null) => void;
    onLookupTerm: (term: string) => void;
    onSendWord: (entry: DictionaryEntry) => void;
    bookmarked: boolean;
    onToggleBookmark: (entry: DictionaryEntry) => void;
    showRomaji: boolean;
}> = ({ entry, selected, elementRef, onLookupTerm, onSendWord, bookmarked, onToggleBookmark, showRomaji }) => {
    const [showForms, setShowForms] = useState(false);
    const groups = groupByDictionary(entry.definitions.filter(d => !d.isForms));
    const forms = entry.definitions.filter(d => d.isForms);
    // Accent positions from every pitch dictionary, without repeats
    const downsteps = Array.from(new Set(entry.pitches.flatMap(p => p.positions)
        .map(v => (typeof v === 'number' ? v : parseInt(String(v), 10)))
        .filter(v => Number.isInteger(v) && v >= 0)));

    return (
        <div ref={elementRef} style={{
            padding: '10px 4px 12px 8px',
            borderBottom: '1px solid rgba(255,255,255,0.12)',
            borderLeft: selected ? '3px solid #4fc3f7' : '3px solid transparent',
            background: selected ? 'rgba(79, 195, 247, 0.07)' : undefined,
        }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px 8px' }}>
                <div style={{ minWidth: 0 }}>
                    <Headword entry={entry} />
                    {entry.reading !== entry.term && !entry.furigana.some(([, r]) => r) && (
                        <span lang="ja" style={{ fontSize: '16px', marginLeft: '8px', opacity: 0.8 }}>{entry.reading}</span>
                    )}
                    {showRomaji && (
                        <div style={{ fontSize: '14px', color: '#b8bcbf', letterSpacing: '0.02em' }}>{toRomaji(entry.reading)}</div>
                    )}
                </div>
                <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                    <div style={{ ...BUTTON_STYLE, padding: '4px 10px', fontSize: '12px', color: bookmarked ? '#ffc107' : '#fff' }}
                         onClick={() => onToggleBookmark(entry)}>
                        {bookmarked ? '★ Saved' : '☆ Save'}
                    </div>
                    <div style={{ ...BUTTON_STYLE, padding: '4px 10px', fontSize: '12px' }}
                         onClick={() => onSendWord(entry)}>
                        <SendIcon size={14} /> Word
                    </div>
                </div>
            </div>

            <div style={{ marginTop: '4px', display: 'flex', flexWrap: 'wrap', alignItems: 'center' }}>
                {entry.frequencies.map((f, i) => (
                    <span key={`f${i}`} style={{
                        display: 'inline-flex', marginRight: '4px', marginBottom: '2px', borderRadius: '4px',
                        overflow: 'hidden', fontSize: '12px', lineHeight: '18px', fontWeight: 'bold',
                    }}>
                        <span style={{ background: '#2f5d8a', padding: '0 5px' }}>{shortDictionaryName(f.dictionary)}</span>
                        <span style={{ background: '#1f3f5f', padding: '0 5px' }}>{f.displayValue}</span>
                    </span>
                ))}
                {entry.termTags.map(t => <Tag key={t.name} tag={t} />)}
            </div>

            {downsteps.length > 0 && (
                <div style={{ marginTop: '6px', display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', rowGap: '4px' }}>
                    {downsteps.map(n => <PitchGraph key={n} reading={entry.reading} downstep={n} showRomaji={showRomaji} />)}
                </div>
            )}

            {entry.inflections.length > 0 && (
                <div style={{ fontSize: '13px', opacity: 0.75, marginTop: '2px' }}>
                    {entry.inflections.slice(0, 2).map((chain, i) => (
                        <div key={i} title={chain.map(c => c.description || c.name).join('\n')}>
                            {chain.map(c => `« ${c.name}`).join(' ')}
                        </div>
                    ))}
                </div>
            )}

            {groups.map(([dictionary, defs]) => (
                <div key={dictionary} style={{ marginTop: '6px' }}>
                    <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.55 }}>
                        {shortDictionaryName(dictionary)}
                    </div>
                    <ol style={{ margin: '2px 0 0', paddingLeft: defs.length > 1 ? '1.5em' : '0', listStyleType: defs.length > 1 ? 'decimal' : 'none' }}>
                        {defs.map((d, i) => (
                            <li key={i} style={{ marginBottom: '4px', fontSize: '16px', lineHeight: '1.35' }}>
                                {d.tags.filter(t => !/^\d+$/.test(t.name)).map(t => <Tag key={t.name} tag={t} />)}
                                <Glossary items={d.glossary} onLookup={onLookupTerm} />
                            </li>
                        ))}
                    </ol>
                </div>
            ))}

            {forms.length > 0 && (
                <div style={{ marginTop: '4px' }}>
                    <span style={{ fontSize: '12px', opacity: 0.7, cursor: 'pointer', textDecoration: 'underline' }}
                          onClick={() => setShowForms(v => !v)}>
                        {showForms ? 'Hide other forms' : 'Other forms'}
                    </span>
                    {showForms && forms.map((d, i) => (
                        <div key={i} lang="ja" style={{ fontSize: '14px', marginTop: '2px' }}>
                            <Glossary items={d.glossary} onLookup={onLookupTerm} />
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
};

// Lets the overlay forward controller buttons while the popup is open
export interface DictionaryPopupHandle {
    handleNav: (button: NavButton) => void;
}

interface DictionaryPopupProps {
    text: string;
    initialOffset: number;
    side: 'left' | 'right';
    showControllerHints?: boolean;
    onClose: () => void;
    onSendText: (text: string) => void;
    onSendWord: (word: string) => void;
    // Fills its parent instead of floating over the overlay (used inside modals)
    embedded?: boolean;
    // Called after a word is saved to or removed from the bookmarks
    onBookmarksChanged?: () => void;
}

const HintKey: VFC<{ label: string }> = ({ label }) => (
    <span style={{
        display: 'inline-block', minWidth: '16px', padding: '0 4px', marginRight: '3px', borderRadius: '8px',
        background: 'rgba(255,255,255,0.18)', textAlign: 'center', fontWeight: 'bold',
    }}>{label}</span>
);

export const DictionaryPopup = forwardRef<DictionaryPopupHandle, DictionaryPopupProps>(({
    text, initialOffset, side, showControllerHints = false, onClose, onSendText, onSendWord,
    embedded = false, onBookmarksChanged,
}, ref) => {
    const [history, setHistory] = useState<HistoryItem[]>([{ kind: 'scan', offset: initialOffset }]);
    const [result, setResult] = useState<LookupResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [installStatus, setInstallStatus] = useState<DictionaryJobStatus | null>(null);
    // Placement on the overlay: starts away from the tapped box, can be swapped;
    // the size preset is remembered between popups
    const [popupSide, setPopupSide] = useState<'left' | 'right'>(side);
    const [layoutIndex, setLayoutIndex] = useState(loadLayout);
    // Read once per popup; toggled in the Dictionary tab
    const [showRomaji] = useState(getShowRomaji);
    const layout = LAYOUTS[layoutIndex];
    // The wide layout swaps between top and bottom instead of left and right;
    // it starts at the top, since captions are usually at the bottom
    const [popupEdge, setPopupEdge] = useState<'top' | 'bottom'>('top');
    const swapSide = () => {
        if (layout.wide) setPopupEdge(e => (e === 'top' ? 'bottom' : 'top'));
        else setPopupSide(s => (s === 'left' ? 'right' : 'left'));
    };
    const cycleLayout = () => setLayoutIndex(i => {
        const next = (i + 1) % LAYOUTS.length;
        try { localStorage.setItem(LAYOUT_KEY, String(next)); } catch { /* not persisted */ }
        return next;
    });
    const requestId = useRef(0);
    // The history item the shown result was looked up for. Until a new lookup
    // returns, the old result's match must not be drawn under the new cursor.
    const resultFor = useRef<HistoryItem | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Controller state: highlighted entry (Y sends it) and the word-jump trail for ◀
    const [selectedEntry, setSelectedEntry] = useState(0);
    const [controllerActive, setControllerActive] = useState(showControllerHints);
    const entryRefs = useRef<(HTMLDivElement | null)[]>([]);
    const wordTrail = useRef<number[]>([]);
    const lastScanOffset = useRef(initialOffset);

    const current = history[history.length - 1];
    if (current.kind === 'scan') lastScanOffset.current = current.offset;
    const chars = useMemo(() => Array.from(text), [text]);

    const runLookup = useCallback(async (item: HistoryItem) => {
        const id = ++requestId.current;
        setLoading(true);
        try {
            const res = item.kind === 'scan'
                ? await call<[string, number], LookupResult>('dictionary_lookup', text, item.offset)
                : await call<[string, number], LookupResult>('dictionary_lookup', item.term, 0);
            if (id !== requestId.current) return;
            resultFor.current = item;
            setResult(res);
            setSelectedEntry(0);
            if (scrollRef.current) scrollRef.current.scrollTop = 0;
            logger.debug('Dictionary', `Lookup took ${res?.elapsedMs}ms, ${res?.entries?.length ?? 0} entries`);
        } catch (e) {
            logger.error('Dictionary', 'Lookup failed', e);
            if (id === requestId.current) {
                resultFor.current = item;
                setResult({ success: false, error: 'lookup_error', message: String(e), matchStart: 0, matchEnd: 0, entries: [] });
            }
        } finally {
            if (id === requestId.current) setLoading(false);
        }
    }, [text]);

    // The overlay remounts this component (via key) for each new tap, so
    // initialOffset only seeds the first history entry
    useEffect(() => { runLookup(current); }, [current, runLookup]);

    // Poll install progress while the recommended dictionaries download
    useEffect(() => {
        if (!installStatus) return;
        if (!installStatus.busy && installStatus.queued === 0) {
            setInstallStatus(null);
            runLookup(current);
            return;
        }
        const timer = setTimeout(async () => {
            try {
                setInstallStatus(await call<[], DictionaryJobStatus>('dictionary_get_status'));
            } catch {
                setInstallStatus(null);
            }
        }, 1000);
        return () => clearTimeout(timer);
    }, [installStatus, current, runLookup]);

    const scanAt = (offset: number) => setHistory([{ kind: 'scan', offset }]);
    const lookupTerm = (term: string) => setHistory(h => [...h, { kind: 'term', term }]);
    const goBack = () => setHistory(h => (h.length > 1 ? h.slice(0, -1) : h));

    // Saved words, so each entry can show whether it is bookmarked
    const [bookmarks, setBookmarks] = useState<Set<string>>(new Set());
    useEffect(() => {
        call<[], { success: boolean; result?: Bookmark[] }>('bookmark_list')
            .then(res => { if (res?.success) setBookmarks(new Set((res.result || []).map(b => bookmarkKey(b.term, b.reading)))); })
            .catch(e => logger.error('Dictionary', 'Failed to load bookmarks', e));
    }, []);

    const toggleBookmark = async (entry: DictionaryEntry) => {
        const key = bookmarkKey(entry.term, entry.reading);
        const saved = bookmarks.has(key);
        try {
            const res = saved
                ? await call<[string, string], { success: boolean; message?: string }>('bookmark_delete_term', entry.term, entry.reading)
                : await call<[string, string, string, number], { success: boolean; message?: string }>(
                    'bookmark_add', entry.term, entry.reading,
                    // The sentence it came from, so the bookmark reopens in context
                    current.kind === 'scan' ? text : '',
                    current.kind === 'scan' && result ? result.matchStart : 0);
            if (!res?.success) {
                logger.error('Dictionary', `Bookmark failed: ${res?.message}`);
                return;
            }
            setBookmarks(prev => {
                const next = new Set(prev);
                if (saved) next.delete(key); else next.add(key);
                return next;
            });
            onBookmarksChanged?.();
        } catch (e) {
            logger.error('Dictionary', 'Bookmark failed', e);
        }
    };

    const installRecommended = async () => {
        try {
            await call<[], any>('dictionary_install_recommended');
            setInstallStatus(await call<[], DictionaryJobStatus>('dictionary_get_status'));
        } catch (e) {
            logger.error('Dictionary', 'Failed to start dictionary install', e);
        }
    };

    // Only highlight a match that belongs to the cursor's current position; while
    // the next lookup is pending, just the cursor underline shows
    const resultIsCurrent = current.kind === 'scan' && result !== null && resultFor.current === current;
    const highlightStart = resultIsCurrent ? result!.matchStart : -1;
    const highlightEnd = resultIsCurrent ? result!.matchEnd : -1;
    const cursor = current.kind === 'scan' ? current.offset : -1;

    const entries = result?.entries || [];
    const noDictionaries = result?.success && result.hasDictionaries === false;

    // Next character index in direction dir starting at start, skipping
    // whitespace and punctuation (nothing to look up at 、 or 「)
    const stepFrom = (start: number, dir: 1 | -1): number | null => {
        for (let i = start; i >= 0 && i < chars.length; i += dir) {
            if (!/[\s\p{P}\p{S}]/u.test(chars[i])) return i;
        }
        return null;
    };

    const selectEntry = (index: number) => {
        const next = Math.max(0, Math.min(entries.length - 1, index));
        setSelectedEntry(next);
        if (next === 0 && scrollRef.current) scrollRef.current.scrollTop = 0;
        else entryRefs.current[next]?.scrollIntoView({ block: 'nearest' });
    };

    const navRef = useRef<(button: NavButton) => void>(() => {});
    navRef.current = (button: NavButton) => {
        setControllerActive(true);
        const base = current.kind === 'scan' ? current.offset : lastScanOffset.current;
        switch (button) {
            // L1/R1 move one character, the D-pad / sticks move one word
            case 'l1':
            case 'r1': {
                const i = stepFrom(base + (button === 'r1' ? 1 : -1), button === 'r1' ? 1 : -1);
                if (i !== null) {
                    wordTrail.current = [];
                    scanAt(i);
                }
                break;
            }
            case 'right': {
                // Jump past the highlighted word
                const end = current.kind === 'scan' && result && result.matchEnd > result.matchStart
                    ? result.matchEnd : base + 1;
                const i = stepFrom(end, 1);
                if (i !== null) {
                    wordTrail.current.push(base);
                    scanAt(i);
                }
                break;
            }
            case 'left': {
                const previous = wordTrail.current.pop();
                const i = previous !== undefined ? previous : stepFrom(base - 1, -1);
                if (i !== null) scanAt(i);
                break;
            }
            case 'up':
            case 'down':
                if (entries.length > 0) {
                    selectEntry(selectedEntry + (button === 'down' ? 1 : -1));
                } else if (scrollRef.current) {
                    scrollRef.current.scrollTop += button === 'down' ? 120 : -120;
                }
                break;
            case 'x':
                onSendText(text);
                break;
            case 'y':
                if (entries[selectedEntry]) onSendWord(entries[selectedEntry].term);
                break;
            case 'a':
                if (noDictionaries) {
                    if (!installStatus) installRecommended();
                } else if (entries[selectedEntry]) {
                    toggleBookmark(entries[selectedEntry]);
                }
                break;
            case 'b':
                if (history.length > 1) goBack();
                else onClose();
                break;
            case 'select':
                if (!embedded) swapSide();
                break;
            case 'start':
                if (!embedded) cycleLayout();
                break;
        }
    };

    useImperativeHandle(ref, () => ({
        handleNav: (button: NavButton) => navRef.current(button),
    }), []);

    return (
        <div
            onClick={(e) => e.stopPropagation()}
            style={{
                ...(embedded
                    ? { position: 'relative', width: '100%', height: '100%' }
                    : layout.wide
                        ? { position: 'fixed', [popupEdge]: '12px', left: '12px', right: '12px', maxHeight: layout.maxHeight, zIndex: 7010 }
                        : { position: 'fixed', top: '12px', [popupSide]: '12px', width: layout.width, maxHeight: layout.maxHeight, zIndex: 7010 }),
                display: 'flex',
                flexDirection: 'column',
                background: 'rgba(22, 24, 30, 0.97)',
                color: '#fff',
                borderRadius: '10px',
                border: '1px solid rgba(255,255,255,0.15)',
                boxShadow: embedded ? undefined : '0 6px 24px rgba(0,0,0,0.5)',
                overflow: 'hidden',
                animation: 'dtDictFadeIn 0.15s ease-out forwards',
            } as CSSProperties}
        >
            <style>{`
                @keyframes dtDictSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
                @keyframes dtDictFadeIn { from { opacity: 0; } to { opacity: 1; } }
            `}</style>

            {/* Source text strip: tap a character to look up from there */}
            <div lang="ja" style={{
                padding: '10px 12px 8px',
                flexShrink: 0,
                fontSize: '22px',
                lineHeight: '1.45',
                maxHeight: '30vh',
                overflowY: 'auto',
                background: 'rgba(255,255,255,0.05)',
                borderBottom: '1px solid rgba(255,255,255,0.12)',
                wordBreak: 'break-all',
            }}>
                {Array.from(text).map((ch, i) => {
                    if (ch === '\n') return <br key={i} />;
                    const highlighted = i >= highlightStart && i < highlightEnd;
                    // One rounded block per word: round only its outer corners
                    const first = i === highlightStart;
                    const last = i === highlightEnd - 1;
                    return (
                        <span
                            key={i}
                            onClick={() => { wordTrail.current = []; scanAt(i); }}
                            style={{
                                cursor: 'pointer',
                                borderRadius: highlighted
                                    ? `${first ? 4 : 0}px ${last ? 4 : 0}px ${last ? 4 : 0}px ${first ? 4 : 0}px`
                                    : '3px',
                                background: highlighted ? 'rgba(255, 193, 7, 0.45)' : undefined,
                                boxShadow: i === cursor && !highlighted ? 'inset 0 -2px 0 #ffc107' : undefined,
                            }}
                        >
                            {ch}
                        </span>
                    );
                })}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', flexWrap: 'wrap', flexShrink: 0 }}>
                {history.length > 1 && (
                    <div style={BUTTON_STYLE} onClick={goBack}>‹ Back</div>
                )}
                {/* Icon only in the narrow layout, so the action row stays on one line */}
                <div style={BUTTON_STYLE} onClick={() => onSendText(text)} title="Send to phone">
                    <SendIcon />{!(layout.narrow && !embedded) && ' Send to phone'}
                </div>
                {current.kind === 'term' && (
                    <span lang="ja" style={{ fontSize: '14px', opacity: 0.75 }}>{current.term}</span>
                )}
                <div style={{ flex: 1 }} />
                {!embedded && (
                    <>
                        <div style={{ ...BUTTON_STYLE, padding: '6px 10px' }} onClick={swapSide}
                             title={layout.wide ? 'Move to the other edge' : 'Move to the other side'}>
                            {layout.wide ? '⇅' : '⇄'}
                        </div>
                        <div style={{ ...BUTTON_STYLE, padding: '6px 10px', minWidth: '28px', justifyContent: 'center' }}
                             onClick={cycleLayout} title="Change size">{layout.label}</div>
                    </>
                )}
                {loading && <div className="loader" style={{
                    border: '2px solid #f3f3f3', borderTop: '2px solid #3498db', borderRadius: '50%',
                    width: '14px', height: '14px', animation: 'dtDictSpin 1.2s linear infinite',
                }} />}
                <div style={{ ...BUTTON_STYLE, padding: '6px 10px' }} onClick={onClose}>✕</div>
            </div>

            {/* Results */}
            <div ref={scrollRef} style={{ overflowY: 'auto', padding: '0 12px 8px', flex: 1, minHeight: 0 }}>
                {noDictionaries ? (
                    <div style={{ padding: '12px 0', fontSize: '15px', lineHeight: 1.5 }}>
                        {installStatus ? (
                            <>
                                <div>{installStatus.title || 'Installing dictionaries'}</div>
                                <div style={{ opacity: 0.7, fontSize: '13px' }}>
                                    {installStatus.message}{installStatus.queued > 0 ? ` (${installStatus.queued} more queued)` : ''}
                                </div>
                                <div style={{ height: '4px', background: 'rgba(255,255,255,0.15)', borderRadius: '2px', marginTop: '6px' }}>
                                    <div style={{ height: '4px', ...progressFill(installStatus.progress), background: '#3498db', borderRadius: '2px' }} />
                                </div>
                            </>
                        ) : (
                            <>
                                <div>No dictionaries are installed.</div>
                                <div style={{ opacity: 0.7, fontSize: '13px', marginBottom: '8px' }}>
                                    JMdict, JMnedict, Jiten frequency and Kanjium pitch accents (about 35 MB download, 230 MB on disk).
                                    You can manage them in the plugin's Dictionary tab.
                                </div>
                                <div style={BUTTON_STYLE} onClick={installRecommended}>Install recommended dictionaries</div>
                            </>
                        )}
                    </div>
                ) : result && !result.success ? (
                    <div style={{ padding: '12px 0', color: '#ff8a80' }}>Lookup failed: {result.message || result.error}</div>
                ) : result && entries.length === 0 && !loading ? (
                    <div style={{ padding: '12px 0', opacity: 0.7 }}>
                        No matches. Tap a character above to look up from there.
                    </div>
                ) : (
                    entries.map((entry, i) => (
                        <EntryView
                            key={`${entry.term}|${entry.reading}|${i}`}
                            entry={entry}
                            selected={controllerActive && i === selectedEntry}
                            elementRef={(el) => { entryRefs.current[i] = el; }}
                            onLookupTerm={lookupTerm}
                            onSendWord={(e) => onSendWord(e.term)}
                            bookmarked={bookmarks.has(bookmarkKey(entry.term, entry.reading))}
                            onToggleBookmark={toggleBookmark}
                            showRomaji={showRomaji}
                        />
                    ))
                )}
            </div>

            {/* Controller hints */}
            {controllerActive && (
                <div style={{
                    flexShrink: 0,
                    padding: '6px 12px',
                    fontSize: '11px',
                    lineHeight: '18px',
                    opacity: 0.75,
                    borderTop: '1px solid rgba(255,255,255,0.12)',
                    display: 'flex',
                    flexWrap: 'wrap',
                    columnGap: '10px',
                }}>
                    <span><HintKey label="◀▶" />word</span>
                    <span><HintKey label="L1" /><HintKey label="R1" />character</span>
                    <span><HintKey label="▲▼" />entry</span>
                    <span><HintKey label="A" />save</span>
                    <span><HintKey label="X" />send text</span>
                    <span><HintKey label="Y" />send word</span>
                    <span><HintKey label="B" />{history.length > 1 ? 'back' : 'close'}</span>
                    {!embedded && <span><HintKey label="Select" />side</span>}
                    {!embedded && <span><HintKey label="Start" />size</span>}
                </div>
            )}
        </div>
    );
});
