// src/incognito.ts
// Shared incognito flag. The backend keeps new translations in RAM only and
// drops debug logs while it is on; the UI shows a badge and asks before saving
// a bookmark. SettingsContext sets it; the overlay and dictionary read it.

import { useEffect, useState } from "react";

let incognito = false;
const listeners = new Set<(on: boolean) => void>();

export function isIncognito(): boolean {
    return incognito;
}

export function setIncognito(on: boolean): void {
    if (incognito === on) return;
    incognito = on;
    listeners.forEach(fn => fn(on));
}

export function useIncognito(): boolean {
    const [on, setOn] = useState(incognito);
    useEffect(() => {
        setOn(incognito);
        listeners.add(setOn);
        return () => { listeners.delete(setOn); };
    }, []);
    return on;
}
