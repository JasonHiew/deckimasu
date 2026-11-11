// src/LiveSubtitles.tsx
// Live subtitles: while the overlay is closed, translated labels drawn over the
// running game. They sit on Steam's Notification layer (like toasts), so the
// game keeps the controller, and they ignore taps. The capture loop lives in
// GameTranslatorLogic; this file holds the shared state and the labels.

import { VFC, useEffect, useRef, useState } from "react";
import { TranslatedRegion } from "./TextTranslator";
import type { TextRegion } from "./TextRecognizer";
import { CompositionRequest, ImageState, UIComposition } from "./Overlay";
import { buildTranslatedFontFamily, resolveFontStyleCSS } from "./fonts";

type Listener = () => void;

type Rect = TextRegion['rect'];

// Text without whitespace, the form OCR passes are compared in
const squash = (text: string) => text.replace(/\s+/g, '');

// How many characters two strings share, counting repeats
function sharedChars(a: string, b: string): number {
    const counts = new Map<string, number>();
    for (const ch of a) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    let shared = 0;
    for (const ch of b) {
        const n = counts.get(ch) ?? 0;
        if (n > 0) {
            shared++;
            counts.set(ch, n - 1);
        }
    }
    return shared;
}

// Share of the smaller box covered by the other
function overlap(a: Rect, b: Rect): number {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (w <= 0 || h <= 0) return 0;
    const area = (r: Rect) => Math.max(1, (r.right - r.left) * (r.bottom - r.top));
    return (w * h) / Math.min(area(a), area(b));
}

interface TrackedLabel {
    region: TranslatedRegion;
    text: string;    // squashed source text
    missing: number; // passes in a row without a matching box
}

/**
 * Keeps live labels steady between OCR passes. On text-heavy screens OCR
 * splits and merges lines differently each pass and misreads a character or
 * two, which used to replace every label every few seconds. A fresh box that
 * overlaps a label and holds the same text (or a piece of it) keeps the old
 * label where it is; longer text in the same place (a line still being typed
 * out) or different text replaces it at once; a label is dropped only after
 * three passes without a match.
 */
export class LiveTracker {
    private labels: TrackedLabel[] = [];

    reset(): void {
        this.labels = [];
    }

    /** Boxes that need a (new) translation; call apply() with them translated. */
    update(regions: TextRegion[]): TextRegion[] {
        const matched = new Set<TrackedLabel>();
        const unmatched: { region: TextRegion; text: string }[] = [];
        // Pass 1: boxes holding a label's text, or a piece of it (re-split
        // lines, a misread character), keep that label
        for (const region of regions) {
            const text = squash(region.text);
            if (!text) continue;
            const label = this.labels.find(l =>
                overlap(l.region.rect, region.rect) >= 0.3
                && sharedChars(l.text, text) / text.length >= 0.85
                && text.length <= l.text.length * 1.15);
            if (label) {
                matched.add(label);
                label.missing = 0;
            } else {
                unmatched.push({ region, text });
            }
        }
        // Pass 2: other boxes. Over a label that is still there, only a longer
        // version of its text (a line still being typed out) replaces it;
        // anything else there is OCR grouping the same text differently.
        const fresh: TextRegion[] = [];
        const replaced = new Set<TrackedLabel>();
        for (const { region, text } of unmatched) {
            const covering = this.labels.filter(l => matched.has(l) && overlap(l.region.rect, region.rect) >= 0.3);
            const grown = covering.filter(l => sharedChars(l.text, text) / l.text.length >= 0.85);
            if (covering.length > 0 && grown.length === 0) continue;
            grown.forEach(l => replaced.add(l));
            fresh.push(region);
        }
        for (const label of this.labels) {
            if (!matched.has(label)) label.missing++;
        }
        // Gone: replaced by longer text, overlapped by new text, or missing three times
        this.labels = this.labels.filter(l =>
            !replaced.has(l)
            && l.missing < 3
            && !(l.missing > 0 && fresh.some(r => overlap(l.region.rect, r.rect) >= 0.3)));
        return fresh;
    }

    apply(translated: TranslatedRegion[]): void {
        for (const region of translated) {
            this.labels.push({ region, text: squash(region.text), missing: 0 });
        }
    }

    get regions(): TranslatedRegion[] {
        return this.labels.map(l => l.region);
    }
}

export class LiveState {
    regions: TranslatedRegion[] = [];
    frameWidth = 1280;
    frameHeight = 800;
    private listeners = new Set<Listener>();

    set(regions: TranslatedRegion[], frameWidth?: number, frameHeight?: number): void {
        this.regions = regions;
        if (frameWidth && frameHeight) {
            this.frameWidth = frameWidth;
            this.frameHeight = frameHeight;
        }
        this.listeners.forEach(fn => fn());
    }

    clear(): void {
        if (this.regions.length) this.set([]);
    }

    subscribe(fn: Listener): () => void {
        this.listeners.add(fn);
        return () => { this.listeners.delete(fn); };
    }
}

export const LiveLabels: VFC<{ live: LiveState; imageState: ImageState }> = ({ live, imageState }) => {
    const [, rerender] = useState(0);
    const [overlayVisible, setOverlayVisible] = useState(imageState.isVisible());
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => live.subscribe(() => rerender(n => n + 1)), [live]);
    useEffect(() => {
        const onChange = (visible: boolean) => setOverlayVisible(visible);
        imageState.onStateChanged(onChange);
        return () => imageState.offStateChanged(onChange);
    }, [imageState]);

    const show = live.regions.length > 0 && !overlayVisible;
    // The window the labels are drawn in (not the shared JS context's)
    const win = rootRef.current?.ownerDocument?.defaultView;
    const viewWidth = win?.innerWidth ?? live.frameWidth;
    const scale = viewWidth / live.frameWidth;
    const fontScale = imageState.getFontScale();
    const fontFamily = buildTranslatedFontFamily(imageState.getTranslatedTextFontFamily());

    return (
        <div ref={rootRef} style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 7001 }}>
            {show && <CompositionRequest level={UIComposition.Notification} />}
            {show && live.regions.map((region, i) => {
                const boxLeft = region.rect.left * scale;
                const top = region.rect.top * scale;
                const boxWidth = (region.rect.right - region.rect.left) * scale;
                const boxHeight = (region.rect.bottom - region.rect.top) * scale;
                // Sized from the line height of the text it covers, not by fitting
                // (longer) English into the Japanese box, which hit the 7 px floor
                const lines = Math.max(1, region.text.split(/\n/).length);
                const fontSize = Math.max(9, Math.min(24, (boxHeight / lines) * 0.8 * fontScale));
                // A lane centred on the box, kept on screen; the label is as wide as its text
                const laneWidth = Math.min(viewWidth * 0.9, Math.max(boxWidth * 1.6, 260));
                const laneLeft = Math.max(4, Math.min(boxLeft + boxWidth / 2 - laneWidth / 2, viewWidth - laneWidth - 4));
                return (
                    <div key={i} style={{
                        position: 'absolute',
                        left: `${laneLeft}px`,
                        top: `${top}px`,
                        width: `${laneWidth}px`,
                        display: 'flex',
                        justifyContent: 'center',
                    }}>
                        <div style={{
                            padding: '2px 6px',
                            borderRadius: '4px',
                            background: 'rgba(0, 0, 0, 0.78)',
                            color: '#fff',
                            fontSize: `${Math.round(fontSize)}px`,
                            lineHeight: 1.2,
                            textAlign: 'center',
                            fontFamily,
                            ...resolveFontStyleCSS(imageState.getTranslatedTextFontStyle()),
                        }}>
                            {(region.translatedText || region.text).replace(/\s*\n\s*/g, ' ')}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};
