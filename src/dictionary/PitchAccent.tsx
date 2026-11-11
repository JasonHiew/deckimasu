// src/dictionary/PitchAccent.tsx
// Draws a pitch accent the way most dictionaries do: a dot per mora at a high
// or low level, joined by lines, so each rise or drop shows as a diagonal. A
// hollow dot after the word stands for a following particle (が, は), which is
// what tells 平板 (stays high) apart from 尾高 (drops onto the particle).

import { VFC } from "react";
import { toRomaji } from "./romaji";

const SMALL_KANA = /[ゃゅょぁぃぅぇぉゎャュョァィゥェォヮㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ]/;

// Splits a reading into morae: small ゃ/ょ etc. join the kana before them,
// while っ and ー count as morae of their own
export function splitMorae(reading: string): string[] {
    const morae: string[] = [];
    for (const ch of Array.from(reading)) {
        if (SMALL_KANA.test(ch) && morae.length > 0) morae[morae.length - 1] += ch;
        else morae.push(ch);
    }
    return morae;
}

// true = high, for each mora plus one trailing particle
export function pitchPattern(moraCount: number, downstep: number): boolean[] {
    const levels: boolean[] = [];
    for (let i = 1; i <= moraCount + 1; i++) {
        if (downstep === 0) levels.push(i > 1);              // 平板: low, then high, particle stays high
        else if (downstep === 1) levels.push(i === 1);       // 頭高: high, then low
        else levels.push(i > 1 && i <= downstep);            // 中高 / 尾高: low, high up to the drop, then low
    }
    return levels;
}

export function patternName(moraCount: number, downstep: number): string {
    if (downstep === 0) return "平板 heiban";
    if (downstep === 1) return "頭高 atamadaka";
    if (downstep === moraCount) return "尾高 odaka";
    return "中高 nakadaka";
}

const MORA_WIDTH = 17;
const HIGH_Y = 5;
const LOW_Y = 17;
const TEXT_Y = 35;
const COLOR = "#4fc3f7";
const ROMAJI_Y = 48;

// Romaji under each mora: っ shows the consonant it doubles, ー the vowel it lengthens
function moraRomaji(morae: string[], i: number): string {
    const m = morae[i];
    if (m === 'っ' || m === 'ッ') {
        const next = i + 1 < morae.length ? toRomaji(morae[i + 1]) : '';
        return next.startsWith('ch') ? 't' : next[0] && !/[aeiou]/.test(next[0]) ? next[0] : '';
    }
    if (m === 'ー') {
        const prev = i > 0 ? moraRomaji(morae, i - 1) : '';
        return prev.slice(-1);
    }
    return toRomaji(m);
}

export const PitchGraph: VFC<{ reading: string; downstep: number; showRomaji?: boolean }> = ({ reading, downstep, showRomaji = false }) => {
    const morae = splitMorae(reading);
    if (morae.length === 0 || downstep < 0 || downstep > morae.length) return null;
    const levels = pitchPattern(morae.length, downstep);
    const x = (i: number) => i * MORA_WIDTH + MORA_WIDTH / 2;
    const y = (i: number) => (levels[i] ? HIGH_Y : LOW_Y);
    const width = (morae.length + 1) * MORA_WIDTH;
    const last = morae.length; // index of the particle point
    const height = showRomaji ? 52 : 40;

    return (
        <span style={{ display: "inline-flex", alignItems: "flex-end", gap: "4px", marginRight: "10px", verticalAlign: "middle" }}
              title={`[${downstep}] ${patternName(morae.length, downstep)}`}>
            <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block", overflow: "visible" }}>
                {/* Word: solid line through the morae */}
                <polyline
                    points={morae.map((_, i) => `${x(i)},${y(i)}`).join(" ")}
                    fill="none" stroke={COLOR} strokeWidth={2} strokeLinejoin="round"
                />
                {/* Into the particle: dashed */}
                <line x1={x(last - 1)} y1={y(last - 1)} x2={x(last)} y2={y(last)}
                      stroke={COLOR} strokeWidth={2} strokeDasharray="3 2" />
                {morae.map((_, i) => (
                    <circle key={i} cx={x(i)} cy={y(i)} r={3.5} fill={COLOR} />
                ))}
                <circle cx={x(last)} cy={y(last)} r={3.5} fill="rgba(22,24,30,1)" stroke={COLOR} strokeWidth={1.5} />
                {morae.map((m, i) => (
                    <text key={`t${i}`} x={x(i)} y={TEXT_Y} textAnchor="middle" fontSize={m.length > 1 ? 11 : 14}
                          fill="#fff" lang="ja">{m}</text>
                ))}
                {showRomaji && morae.map((_, i) => (
                    <text key={`r${i}`} x={x(i)} y={ROMAJI_Y} textAnchor="middle" fontSize={9}
                          fill="#b8bcbf">{moraRomaji(morae, i)}</text>
                ))}
            </svg>
            <span style={{ fontSize: "11px", opacity: 0.6, lineHeight: "14px", paddingBottom: "4px" }}>
                [{downstep}] {patternName(morae.length, downstep).split(" ")[0]}
            </span>
        </span>
    );
};
