// src/tabs/TabBookmarks.tsx - Words saved from the dictionary to look up later

import {
    PanelSection,
    PanelSectionRow,
    ButtonItem,
    ToggleField,
    TextField,
    DialogButton,
    Focusable,
    ModalRoot,
    showModal,
} from "@decky/ui";
import { call } from "@decky/api";
import { VFC, useCallback, useEffect, useRef, useState } from "react";
import { HiCheck, HiArrowUturnLeft, HiPencilSquare, HiTrash } from "react-icons/hi2";
import { logger } from "../Logger";
import { Bookmark } from "../dictionary/types";
import { DictionaryBrowserModal } from "../dictionary/DictionaryBrowserModal";

type ActionResult<T> = { success: boolean; result?: T; message?: string };

const NoteModal: VFC<{ bookmark: Bookmark; onSave: (note: string) => void; closeModal?: () => void }> = ({ bookmark, onSave, closeModal }) => {
    const [note, setNote] = useState(bookmark.note);
    return (
        <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
            <div style={{ fontSize: "16px", fontWeight: "bold", marginBottom: "8px" }}>
                Note for <span lang="ja">{bookmark.term}</span>
            </div>
            <TextField value={note} onChange={(e) => setNote(e.target.value)} />
            <Focusable style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
                <DialogButton onClick={() => { onSave(note); closeModal?.(); }}>Save</DialogButton>
                <DialogButton onClick={closeModal}>Cancel</DialogButton>
            </Focusable>
        </ModalRoot>
    );
};

const iconButton = { minWidth: "32px", width: "32px", height: "32px", padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 };

export const TabBookmarks: VFC = () => {
    const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [hideDone, setHideDone] = useState(false);
    const [newWord, setNewWord] = useState("");
    const [confirmDeleteDone, setConfirmDeleteDone] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await call<[], ActionResult<Bookmark[]>>("bookmark_list");
            if (res?.success) {
                setBookmarks(res.result || []);
                setError(null);
            } else {
                setError(res?.message || "Could not load bookmarks");
            }
        } catch (e) {
            logger.error("Bookmarks", "Failed to load bookmarks", e);
            setError(String(e));
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    const run = async <T,>(method: string, ...args: any[]) => {
        try {
            const res = await call<any[], ActionResult<T>>(method, ...args);
            if (!res?.success) setError(res?.message || `${method} failed`);
        } catch (e) {
            logger.error("Bookmarks", `${method} failed`, e);
            setError(String(e));
        }
        await load();
    };

    // A tap can fire both onClick and onActivate; open the browser once
    const lastOpen = useRef(0);
    const open = (b: Bookmark) => {
        const now = Date.now();
        if (now - lastOpen.current < 500) return;
        lastOpen.current = now;
        const inContext = b.context && b.context.includes(b.term);
        showModal(
            <DictionaryBrowserModal
                text={inContext ? b.context : b.term}
                initialOffset={inContext ? b.contextOffset : 0}
                onBookmarksChanged={load}
            />
        );
    };

    const addWord = async () => {
        const word = newWord.trim();
        if (!word) return;
        setNewWord("");
        await run("bookmark_add", word, "", "", 0);
    };

    const all = bookmarks || [];
    const doneCount = all.filter(b => b.done).length;
    const shown = hideDone ? all.filter(b => !b.done) : all;

    return (
        <div>
            <style>{`.dt-bm-focus { background: rgba(103,160,255,0.22) !important; }`}</style>
            <PanelSection title={`Bookmarks${bookmarks ? ` (${all.length})` : ""}`}>
                <PanelSectionRow>
                    <div style={{ fontSize: "12px", color: "#8b929a", lineHeight: 1.4 }}>
                        Save words with ☆ Save (or A) in the dictionary. Press A on a word here to open it in the dictionary.
                    </div>
                </PanelSectionRow>
                <PanelSectionRow>
                    <TextField
                        label="Add a word"
                        value={newWord}
                        onChange={(e) => setNewWord(e.target.value)}
                        onKeyDown={(e: any) => { if (e.key === "Enter") addWord(); }}
                    />
                </PanelSectionRow>
                {newWord.trim() && (
                    <PanelSectionRow>
                        <ButtonItem layout="below" onClick={addWord}>Save “{newWord.trim()}”</ButtonItem>
                    </PanelSectionRow>
                )}
                {doneCount > 0 && (
                    <>
                        <PanelSectionRow>
                            <ToggleField label="Hide looked-up words" checked={hideDone} onChange={setHideDone} />
                        </PanelSectionRow>
                        <PanelSectionRow>
                            <ButtonItem
                                layout="below"
                                onClick={async () => {
                                    if (!confirmDeleteDone) { setConfirmDeleteDone(true); return; }
                                    setConfirmDeleteDone(false);
                                    await run("bookmark_delete_done");
                                }}
                            >
                                <span style={{ color: confirmDeleteDone ? "#ff4d4d" : undefined }}>
                                    {confirmDeleteDone ? `Delete ${doneCount} looked-up? Press again` : `Delete looked-up words (${doneCount})`}
                                </span>
                            </ButtonItem>
                        </PanelSectionRow>
                    </>
                )}
                {error && (
                    <PanelSectionRow>
                        <div style={{ color: "#ff6b6b", fontSize: "12px" }}>{error}</div>
                    </PanelSectionRow>
                )}
            </PanelSection>

            <PanelSection>
                {bookmarks === null && <div style={{ color: "#8b929a", padding: "0 16px" }}>Loading...</div>}
                {bookmarks !== null && shown.length === 0 && (
                    <div style={{ color: "#8b929a", padding: "0 16px", fontSize: "13px" }}>
                        {all.length === 0 ? "No saved words yet." : "All saved words are looked up."}
                    </div>
                )}
                <Focusable style={{ display: "flex", flexDirection: "column", gap: "6px", padding: "0 12px" }}>
                    {shown.map(b => (
                        <Focusable
                            key={b.id}
                            focusWithinClassName="dt-bm-focus"
                            style={{ display: "flex", alignItems: "center", gap: "4px", padding: "4px 4px 4px 8px", borderRadius: "4px", background: "rgba(255,255,255,0.04)", opacity: b.done ? 0.55 : 1 }}
                        >
                            <Focusable
                                onActivate={() => open(b)}
                                onClick={() => open(b)}
                                noFocusRing
                                style={{ flex: "1 1 auto", minWidth: 0, cursor: "pointer", padding: "2px 0" }}
                            >
                                <div lang="ja" style={{ fontSize: "18px", lineHeight: 1.3, textDecoration: b.done ? "line-through" : undefined }}>
                                    {b.term}
                                    {b.reading && b.reading !== b.term && (
                                        <span style={{ fontSize: "12px", marginLeft: "6px", color: "#b8bcbf" }}>{b.reading}</span>
                                    )}
                                </div>
                                {b.note && <div style={{ fontSize: "11px", color: "#6fcf97", fontStyle: "italic", overflowWrap: "anywhere" }}>{b.note}</div>}
                                <div style={{ fontSize: "9px", color: "rgba(255,255,255,0.35)" }}>
                                    {new Date(b.createdAt * 1000).toLocaleDateString([], { day: "numeric", month: "short" })}
                                    {b.done && " · looked up"}
                                </div>
                            </Focusable>
                            <DialogButton
                                style={iconButton}
                                onClick={() => run("bookmark_update", b.id, null, !b.done)}
                            >
                                {b.done ? <HiArrowUturnLeft /> : <HiCheck />}
                            </DialogButton>
                            <DialogButton
                                style={iconButton}
                                onClick={() => showModal(<NoteModal bookmark={b} onSave={(note) => run("bookmark_update", b.id, note, null)} />)}
                            >
                                <HiPencilSquare />
                            </DialogButton>
                            <DialogButton style={iconButton} onClick={() => run("bookmark_delete", b.id)}>
                                <HiTrash />
                            </DialogButton>
                        </Focusable>
                    ))}
                </Focusable>
            </PanelSection>
        </div>
    );
};
