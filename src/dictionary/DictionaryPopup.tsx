// src/dictionary/DictionaryPopup.tsx
// Yomitan-style lookup popup shown when a text box on the overlay is tapped.
// The box's recognized text is shown as a strip of tappable characters; tapping
// one scans for the longest dictionary match starting there. Sending to the
// phone (ntfy) lives here as explicit buttons so lookups never send by accident.

import { call } from "@decky/api";
import { CSSProperties, VFC, forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { logger } from "../Logger";
import type { NavButton } from "../Input";
import { Glossary, glossaryToText } from "./StructuredContent";
import { DictionaryDefinition, DictionaryEntry, DictionaryJobStatus, DictionaryTag, LookupResult } from "./types";

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
        <span lang="ja" style={{ fontSize: '30px', lineHeight: hasRuby ? '1.5' : '1.2' }}>
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

function entryToText(entry: DictionaryEntry, sentence: string): string {
    const head = entry.reading && entry.reading !== entry.term ? `${entry.term}【${entry.reading}】` : entry.term;
    const senses = entry.definitions
        .filter(d => !d.isForms)
        .slice(0, 5)
        .map((d, i) => `${i + 1}. ${glossaryToText(d.glossary)}`)
        .filter(s => s.length > 3);
    const parts = [head, ...senses];
    if (sentence) parts.push('', sentence);
    return parts.join('\n');
}

const EntryView: VFC<{
    entry: DictionaryEntry;
    selected: boolean;
    elementRef: (el: HTMLDivElement | null) => void;
    onLookupTerm: (term: string) => void;
    onSendWord: (entry: DictionaryEntry) => void;
}> = ({ entry, selected, elementRef, onLookupTerm, onSendWord }) => {
    const [showForms, setShowForms] = useState(false);
    const groups = groupByDictionary(entry.definitions.filter(d => !d.isForms));
    const forms = entry.definitions.filter(d => d.isForms);

    return (
        <div ref={elementRef} style={{
            padding: '10px 4px 12px 8px',
            borderBottom: '1px solid rgba(255,255,255,0.12)',
            borderLeft: selected ? '3px solid #4fc3f7' : '3px solid transparent',
            background: selected ? 'rgba(79, 195, 247, 0.07)' : undefined,
        }}>
            <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ minWidth: 0 }}>
                    <Headword entry={entry} />
                    {entry.reading !== entry.term && !entry.furigana.some(([, r]) => r) && (
                        <span lang="ja" style={{ fontSize: '16px', marginLeft: '8px', opacity: 0.8 }}>{entry.reading}</span>
                    )}
                </div>
                <div style={{ ...BUTTON_STYLE, padding: '4px 10px', fontSize: '12px' }}
                     onClick={() => onSendWord(entry)}>
                    <SendIcon size={14} /> Word
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
                {entry.pitches.map((p, i) => (
                    <span key={`p${i}`} style={{ fontSize: '12px', marginRight: '6px', opacity: 0.85 }}>
                        [{p.positions.join(', ')}]
                    </span>
                ))}
                {entry.termTags.map(t => <Tag key={t.name} tag={t} />)}
            </div>

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
}

const HintKey: VFC<{ label: string }> = ({ label }) => (
    <span style={{
        display: 'inline-block', minWidth: '16px', padding: '0 4px', marginRight: '3px', borderRadius: '8px',
        background: 'rgba(255,255,255,0.18)', textAlign: 'center', fontWeight: 'bold',
    }}>{label}</span>
);

export const DictionaryPopup = forwardRef<DictionaryPopupHandle, DictionaryPopupProps>(({
    text, initialOffset, side, showControllerHints = false, onClose, onSendText,
}, ref) => {
    const [history, setHistory] = useState<HistoryItem[]>([{ kind: 'scan', offset: initialOffset }]);
    const [result, setResult] = useState<LookupResult | null>(null);
    const [loading, setLoading] = useState(false);
    const [installStatus, setInstallStatus] = useState<DictionaryJobStatus | null>(null);
    const requestId = useRef(0);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Controller state: highlighted entry (Y sends it) and the word-jump trail for L1
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
            setResult(res);
            setSelectedEntry(0);
            if (scrollRef.current) scrollRef.current.scrollTop = 0;
            logger.debug('Dictionary', `Lookup took ${res?.elapsedMs}ms, ${res?.entries?.length ?? 0} entries`);
        } catch (e) {
            logger.error('Dictionary', 'Lookup failed', e);
            if (id === requestId.current) {
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

    const installRecommended = async () => {
        try {
            await call<[], any>('dictionary_install_recommended');
            setInstallStatus(await call<[], DictionaryJobStatus>('dictionary_get_status'));
        } catch (e) {
            logger.error('Dictionary', 'Failed to start dictionary install', e);
        }
    };

    const highlightStart = current.kind === 'scan' && result ? result.matchStart : -1;
    const highlightEnd = current.kind === 'scan' && result ? result.matchEnd : -1;
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
            case 'left':
            case 'right': {
                const i = stepFrom(base + (button === 'right' ? 1 : -1), button === 'right' ? 1 : -1);
                if (i !== null) {
                    wordTrail.current = [];
                    scanAt(i);
                }
                break;
            }
            case 'r1': {
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
            case 'l1': {
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
                if (entries[selectedEntry]) onSendText(entryToText(entries[selectedEntry], text));
                break;
            case 'a':
                if (noDictionaries && !installStatus) installRecommended();
                break;
            case 'b':
                if (history.length > 1) goBack();
                else onClose();
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
                position: 'fixed',
                top: '12px',
                [side]: '12px',
                width: 'min(600px, 48vw)',
                maxHeight: 'calc(100vh - 24px)',
                display: 'flex',
                flexDirection: 'column',
                background: 'rgba(22, 24, 30, 0.97)',
                color: '#fff',
                borderRadius: '10px',
                border: '1px solid rgba(255,255,255,0.15)',
                boxShadow: '0 6px 24px rgba(0,0,0,0.5)',
                zIndex: 7010,
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
                    return (
                        <span
                            key={i}
                            onClick={() => { wordTrail.current = []; scanAt(i); }}
                            style={{
                                cursor: 'pointer',
                                borderRadius: '3px',
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
                <div style={BUTTON_STYLE} onClick={() => onSendText(text)}>
                    <SendIcon /> Send to phone
                </div>
                {current.kind === 'term' && (
                    <span lang="ja" style={{ fontSize: '14px', opacity: 0.75 }}>{current.term}</span>
                )}
                <div style={{ flex: 1 }} />
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
                                    <div style={{ height: '4px', width: `${Math.round((installStatus.progress || 0) * 100)}%`, background: '#3498db', borderRadius: '2px' }} />
                                </div>
                            </>
                        ) : (
                            <>
                                <div>No dictionaries are installed.</div>
                                <div style={{ opacity: 0.7, fontSize: '13px', marginBottom: '8px' }}>
                                    JMdict, JMnedict and Jiten frequency (about 35 MB download, 215 MB on disk).
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
                            onSendWord={(e) => onSendText(entryToText(e, text))}
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
                    <span><HintKey label="◀▶" />character</span>
                    <span><HintKey label="L1" /><HintKey label="R1" />word</span>
                    <span><HintKey label="▲▼" />entry</span>
                    <span><HintKey label="X" />send text</span>
                    <span><HintKey label="Y" />send word</span>
                    <span><HintKey label="B" />{history.length > 1 ? 'back' : 'close'}</span>
                </div>
            )}
        </div>
    );
});
