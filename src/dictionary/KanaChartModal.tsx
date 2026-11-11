// src/dictionary/KanaChartModal.tsx
// Hiragana / katakana reference for beginners: the gojūon table, voiced
// (dakuten) rows and the combined yōon sounds, each with its romaji.

import { DialogButton, Focusable, ModalRoot } from "@decky/ui";
import { VFC, useState } from "react";
import { toRomaji } from "./romaji";

// Consonant groups, each listing its a/i/u/e/o kana; '_' leaves a cell empty.
// Drawn transposed (a vowel per row, a group per column) so it fits the screen.
const BASIC = [
    'あいうえお', 'かきくけこ', 'さしすせそ', 'たちつてと', 'なにぬねの',
    'はひふへほ', 'まみむめも', 'や_ゆ_よ', 'らりるれろ', 'わ___を', 'ん____',
];
const VOICED = ['がぎぐげご', 'ざじずぜぞ', 'だぢづでど', 'ばびぶべぼ', 'ぱぴぷぺぽ'];
const COMBOS = ['き', 'し', 'ち', 'に', 'ひ', 'み', 'り', 'ぎ', 'じ', 'び', 'ぴ']
    .map(base => ['ゃ', 'ゅ', 'ょ'].map(small => base + small));

// Turns groups (one per column) into rows
const transpose = (groups: string[][]) =>
    groups[0].map((_, row) => groups.map(group => group[row] ?? '_'));

const toKatakana = (s: string) =>
    s.replace(/[\u3041-\u3096]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60));

const Cell: VFC<{ kana: string; katakana: boolean }> = ({ kana, katakana }) => (
    <td style={{ padding: '1px 2px', textAlign: 'center', minWidth: '28px' }}>
        {kana && kana !== '_' && (
            <>
                <div lang="ja" style={{ fontSize: '17px', lineHeight: 1.15 }}>{katakana ? toKatakana(kana) : kana}</div>
                <div style={{ fontSize: '9px', color: '#b8bcbf', lineHeight: 1.1 }}>{toRomaji(kana)}</div>
            </>
        )}
    </td>
);

const Table: VFC<{ rows: string[][]; katakana: boolean }> = ({ rows, katakana }) => (
    <table style={{ borderCollapse: 'collapse', marginBottom: '6px' }}>
        <tbody>
            {rows.map((row, i) => (
                <tr key={i} style={{ background: i % 2 ? 'rgba(255,255,255,0.04)' : undefined }}>
                    {row.map((kana, j) => <Cell key={j} kana={kana} katakana={katakana} />)}
                </tr>
            ))}
        </tbody>
    </table>
);

export const KanaChartModal: VFC<{ closeModal?: () => void }> = ({ closeModal }) => {
    const [katakana, setKatakana] = useState(false);
    const split = (row: string) => Array.from(row);
    return (
        <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
            <Focusable style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
                <div style={{ fontSize: '18px', fontWeight: 'bold', flex: 1 }}>
                    {katakana ? 'Katakana' : 'Hiragana'}
                </div>
                <DialogButton style={{ width: 'auto', minWidth: 0, padding: '6px 14px' }}
                              onClick={() => setKatakana(k => !k)}>
                    Show {katakana ? 'hiragana' : 'katakana'}
                </DialogButton>
            </Focusable>
            <Focusable style={{ maxHeight: '70vh', overflowY: 'auto', display: 'flex', flexWrap: 'wrap', columnGap: '14px' }}
                       onActivate={() => {}} noFocusRing>
                <div>
                    <div style={{ fontSize: '11px', opacity: 0.6, marginBottom: '2px' }}>Basic</div>
                    <Table rows={transpose(BASIC.map(split))} katakana={katakana} />
                    <div style={{ fontSize: '11px', opacity: 0.6, marginBottom: '2px' }}>Combined (small ゃ ゅ ょ)</div>
                    <Table rows={transpose(COMBOS)} katakana={katakana} />
                </div>
                <div>
                    <div style={{ fontSize: '11px', opacity: 0.6, marginBottom: '2px' }}>Voiced (゛ and ゜)</div>
                    <Table rows={transpose(VOICED.map(split))} katakana={katakana} />
                </div>
                <div style={{ fontSize: '11px', color: '#b8bcbf', width: '100%', lineHeight: 1.4 }}>
                    A small っ doubles the next consonant (がっこう gakkou). In katakana, ー makes the
                    vowel before it long (コーヒー koohii). は, へ and を are read wa, e and o when they
                    are particles.
                </div>
            </Focusable>
        </ModalRoot>
    );
};
