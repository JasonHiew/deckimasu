// src/tabs/TabDictionary.tsx - Install, update, order and remove lookup dictionaries

import {
    PanelSection,
    PanelSectionRow,
    DropdownItem,
    ToggleField,
    Field,
    ButtonItem,
    TextField,
    Focusable,
    DialogButton,
    ModalRoot,
    ConfirmModal,
    showModal
} from "@decky/ui";
import { call, openFilePicker } from "@decky/api";
import { VFC, useCallback, useEffect, useRef, useState } from "react";
import { useSettings } from "../SettingsContext";
import { logger } from "../Logger";
import { DictionaryState, InstalledDictionary, progressFill } from "../dictionary/types";

const autoUpdateOptions = [
    { label: "Never", data: 0 },
    { label: "Daily", data: 1 },
    { label: "Weekly", data: 7 },
    { label: "Monthly", data: 30 },
];

const KIND_LABELS: Record<string, string> = {
    terms: "Terms",
    frequency: "Frequency",
    pitch: "Pitch accent",
    ipa: "IPA",
    kanji: "Kanji",
};

function formatSize(bytes: number): string {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
    return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function formatAgo(seconds: number): string {
    if (!seconds) return "never";
    const diff = Date.now() / 1000 - seconds;
    if (diff < 90) return "just now";
    if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
    if (diff < 86400 * 2) return `${Math.round(diff / 3600)} h ago`;
    return `${Math.round(diff / 86400)} days ago`;
}

function describe(d: InstalledDictionary): string {
    const kinds = d.kinds.map(k => KIND_LABELS[k] || k).join(", ");
    const parts = [kinds, formatSize(d.sizeBytes)];
    if (!d.enabled) parts.unshift("Disabled");
    if (d.updateAvailable) parts.push("Update available");
    return parts.join(" · ");
}

async function dictionaryAction(method: string, ...args: any[]): Promise<boolean> {
    try {
        const res = await call<any[], { success: boolean; message?: string }>(method, ...args);
        if (!res?.success) logger.error('TabDictionary', `${method} failed: ${res?.message}`);
        return !!res?.success;
    } catch (e) {
        logger.error('TabDictionary', `${method} failed`, e);
        return false;
    }
}

const DictionaryDetailsModal: VFC<{
    dictionary: InstalledDictionary;
    isFirst: boolean;
    isLast: boolean;
    onChanged: () => void;
    closeModal?: () => void;
}> = ({ dictionary, isFirst, isLast, onChanged, closeModal }) => {
    const [enabled, setEnabled] = useState(dictionary.enabled);
    const d = dictionary;

    const run = async (method: string, ...args: any[]) => {
        await dictionaryAction(method, ...args);
        onChanged();
    };

    return (
        <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
            <div style={{ padding: "20px", minWidth: "420px", maxWidth: "560px" }}>
                <h2 style={{ marginBottom: "6px" }}>{d.title}</h2>
                <div style={{ color: "#aaa", fontSize: "13px", marginBottom: "12px", lineHeight: 1.5 }}>
                    <div>Revision: {d.revision}{d.updateAvailable && d.latestRevision ? ` (latest: ${d.latestRevision})` : ""}</div>
                    <div>{d.kinds.map(k => KIND_LABELS[k] || k).join(", ")} · {formatSize(d.sizeBytes)}
                        {d.counts.terms ? ` · ${d.counts.terms.toLocaleString()} terms` : ""}
                        {d.counts.termMeta ? ` · ${d.counts.termMeta.toLocaleString()} entries` : ""}</div>
                    {d.author && <div>Author: {d.author}</div>}
                    {d.description && <div>{d.description}</div>}
                    {d.attribution && <div style={{ marginTop: "6px", fontSize: "12px" }}>{d.attribution}</div>}
                </div>
                <ToggleField
                    label="Enabled"
                    checked={enabled}
                    onChange={async (value) => {
                        setEnabled(value);
                        await run('dictionary_set_enabled', d.id, value);
                    }}
                />
                <Focusable style={{ display: "flex", gap: "10px", marginTop: "16px", flexWrap: "wrap" }}>
                    <DialogButton style={{ flex: 1, minWidth: "120px" }} disabled={isFirst}
                                  onClick={async () => { await run('dictionary_move', d.id, -1); closeModal?.(); }}>
                        Move up
                    </DialogButton>
                    <DialogButton style={{ flex: 1, minWidth: "120px" }} disabled={isLast}
                                  onClick={async () => { await run('dictionary_move', d.id, 1); closeModal?.(); }}>
                        Move down
                    </DialogButton>
                </Focusable>
                <Focusable style={{ display: "flex", gap: "10px", marginTop: "10px", flexWrap: "wrap" }}>
                    {d.isUpdatable && (
                        <DialogButton style={{ flex: 1, minWidth: "120px" }}
                                      onClick={async () => { await run('dictionary_update', d.id); closeModal?.(); }}>
                            {d.updateAvailable ? "Update" : "Reinstall latest"}
                        </DialogButton>
                    )}
                    <DialogButton
                        style={{ flex: 1, minWidth: "120px" }}
                        onClick={() => {
                            showModal(
                                <ConfirmModal
                                    strTitle="Delete dictionary?"
                                    strDescription={`${d.title} will be removed from this device.`}
                                    strOKButtonText="Delete"
                                    onOK={async () => {
                                        await run('dictionary_delete', d.id);
                                        closeModal?.();
                                    }}
                                />
                            );
                        }}
                    >
                        Delete
                    </DialogButton>
                </Focusable>
                <Focusable style={{ display: "flex", justifyContent: "flex-end", marginTop: "16px" }}>
                    <DialogButton style={{ width: "120px" }} onClick={closeModal}>Close</DialogButton>
                </Focusable>
            </div>
        </ModalRoot>
    );
};

const ImportUrlModal: VFC<{ onSubmit: (url: string) => void; closeModal?: () => void }> = ({ onSubmit, closeModal }) => {
    const [url, setUrl] = useState("");
    return (
        <ModalRoot onCancel={closeModal} onEscKeypress={closeModal}>
            <div style={{ padding: "20px", minWidth: "440px" }}>
                <h2 style={{ marginBottom: "10px" }}>Install from URL</h2>
                <p style={{ marginBottom: "12px", color: "#aaa", fontSize: "13px" }}>
                    Link to a Yomitan dictionary .zip, or to its index .json for dictionaries that support updates.
                </p>
                <TextField label="URL" value={url} bShowClearAction={true} onChange={(e) => setUrl(e.target.value)} />
                <Focusable style={{ display: "flex", gap: "10px", marginTop: "20px", justifyContent: "flex-end" }}>
                    <DialogButton onClick={closeModal}>Cancel</DialogButton>
                    <DialogButton
                        disabled={!/^https?:\/\//i.test(url.trim())}
                        onClick={() => { onSubmit(url.trim()); closeModal?.(); }}
                    >
                        Install
                    </DialogButton>
                </Focusable>
            </div>
        </ModalRoot>
    );
};

export const TabDictionary: VFC = () => {
    const { settings, updateSetting } = useSettings();
    const [state, setState] = useState<DictionaryState | null>(null);
    const mounted = useRef(true);

    const refresh = useCallback(async () => {
        try {
            const s = await call<[], DictionaryState>('dictionary_get_state');
            if (mounted.current) setState(s);
        } catch (e) {
            logger.error('TabDictionary', 'Failed to load dictionary state', e);
        }
    }, []);

    useEffect(() => {
        mounted.current = true;
        refresh();
        return () => { mounted.current = false; };
    }, [refresh]);

    // Poll while a download/import/update job is running
    const busy = !!(state?.status?.busy || (state?.status?.queued ?? 0) > 0);
    useEffect(() => {
        if (!busy) return;
        const timer = setInterval(refresh, 1000);
        return () => clearInterval(timer);
    }, [busy, refresh]);

    const act = async (method: string, ...args: any[]) => {
        await dictionaryAction(method, ...args);
        refresh();
    };

    if (state && !state.available) {
        return (
            <PanelSection title="Dictionary">
                <PanelSectionRow>
                    <Field description={state.error || "The dictionary backend failed to start. Check the plugin log."}>
                        Dictionaries unavailable
                    </Field>
                </PanelSectionRow>
            </PanelSection>
        );
    }

    const dictionaries = state?.dictionaries || [];
    const missingRecommended = (state?.recommended || []).filter(r => !r.installed);
    const status = state?.status;
    const updatesAvailable = dictionaries.filter(d => d.updateAvailable).length;

    return (
        <div>
            {status && (busy || status.lastError || status.lastMessage) && (
                <PanelSection title="Status">
                    {busy && (
                        <PanelSectionRow>
                            <Field
                                childrenContainerWidth="max"
                                description={`${status.message || status.phase}${status.queued > 0 ? ` · ${status.queued} more queued` : ""}`}
                            >
                                <div style={{ width: "100%" }}>
                                    <div style={{ fontSize: "13px", marginBottom: "4px" }}>{status.title}</div>
                                    <div style={{ height: "4px", background: "rgba(255,255,255,0.15)", borderRadius: "2px" }}>
                                        <div style={{
                                            height: "4px", borderRadius: "2px", background: "#1a9fff",
                                            ...progressFill(status.progress),
                                        }} />
                                    </div>
                                </div>
                            </Field>
                        </PanelSectionRow>
                    )}
                    {busy && (
                        <PanelSectionRow>
                            <ButtonItem layout="below" onClick={() => act('dictionary_cancel')}>Cancel</ButtonItem>
                        </PanelSectionRow>
                    )}
                    {!busy && (status.lastError || status.lastMessage) && (
                        <PanelSectionRow>
                            <ButtonItem
                                layout="below"
                                description={<span style={{ color: status.lastError ? "#ff6b6b" : undefined }}>
                                    {status.lastError || status.lastMessage}
                                </span>}
                                onClick={() => act('dictionary_clear_message')}
                            >
                                Dismiss
                            </ButtonItem>
                        </PanelSectionRow>
                    )}
                </PanelSection>
            )}

            <PanelSection title="Installed Dictionaries">
                {state === null && (
                    <PanelSectionRow><Field description="Loading..." /></PanelSectionRow>
                )}
                {state !== null && dictionaries.length === 0 && (
                    <PanelSectionRow>
                        <Field description="Tap a text box on the translation overlay to look up words. Install a dictionary below to get started." />
                    </PanelSectionRow>
                )}
                {dictionaries.map((d, i) => (
                    <PanelSectionRow key={d.id}>
                        <ButtonItem
                            layout="below"
                            description={describe(d)}
                            onClick={() => showModal(
                                <DictionaryDetailsModal
                                    dictionary={d}
                                    isFirst={i === 0}
                                    isLast={i === dictionaries.length - 1}
                                    onChanged={refresh}
                                />
                            )}
                        >
                            <span style={{ opacity: d.enabled ? 1 : 0.5 }}>{i + 1}. {d.title}</span>
                        </ButtonItem>
                    </PanelSectionRow>
                ))}
                {dictionaries.length > 1 && (
                    <PanelSectionRow>
                        <Field description="Results are ordered by dictionary position. Select a dictionary to reorder, disable or delete it." />
                    </PanelSectionRow>
                )}
            </PanelSection>

            <PanelSection title="Add Dictionaries">
                {missingRecommended.length > 0 && (
                    <PanelSectionRow>
                        <ButtonItem
                            layout="below"
                            disabled={busy}
                            description={`${missingRecommended.map(r => r.name).join(", ")} · about ${missingRecommended.reduce((n, r) => n + r.approxDownloadMb, 0)} MB download, ${missingRecommended.reduce((n, r) => n + r.approxInstalledMb, 0)} MB installed`}
                            onClick={() => act('dictionary_install_recommended')}
                        >
                            Install recommended
                        </ButtonItem>
                    </PanelSectionRow>
                )}
                <PanelSectionRow>
                    <ButtonItem
                        layout="below"
                        description="Any Yomitan-format dictionary .zip on this device"
                        onClick={async () => {
                            try {
                                const res = await openFilePicker(
                                    0 /* FileSelectionType.FILE */, "/home/deck/Downloads", true, true,
                                    undefined, ["zip"],
                                );
                                if (res?.realpath || res?.path) {
                                    await act('dictionary_install_file', res.realpath || res.path);
                                }
                            } catch (e) {
                                logger.debug('TabDictionary', 'File picker closed', e);
                            }
                        }}
                    >
                        Import from file
                    </ButtonItem>
                </PanelSectionRow>
                <PanelSectionRow>
                    <ButtonItem
                        layout="below"
                        onClick={() => showModal(<ImportUrlModal onSubmit={(url) => act('dictionary_install_url', url)} />)}
                    >
                        Install from URL
                    </ButtonItem>
                </PanelSectionRow>
            </PanelSection>

            <PanelSection title="Updates">
                <PanelSectionRow>
                    <DropdownItem
                        layout="below"
                        label="Automatic Updates"
                        description="Checked when the plugin starts"
                        rgOptions={autoUpdateOptions}
                        selectedOption={settings.dictionaryAutoUpdateDays}
                        onChange={(option) => updateSetting('dictionaryAutoUpdateDays', option.data, 'Dictionary updates')}
                    />
                </PanelSectionRow>
                <PanelSectionRow>
                    <ButtonItem
                        layout="below"
                        disabled={busy || dictionaries.length === 0}
                        description={`Last checked: ${formatAgo(status?.lastUpdateCheck || 0)}`}
                        onClick={() => act('dictionary_check_updates')}
                    >
                        Check for updates
                    </ButtonItem>
                </PanelSectionRow>
                {updatesAvailable > 0 && (
                    <PanelSectionRow>
                        <ButtonItem layout="below" disabled={busy} onClick={() => act('dictionary_update')}>
                            Update all ({updatesAvailable})
                        </ButtonItem>
                    </PanelSectionRow>
                )}
            </PanelSection>

            {state?.attribution && (
                <PanelSection title="Credits">
                    <PanelSectionRow>
                        <Field description={state.attribution} />
                    </PanelSectionRow>
                </PanelSection>
            )}
        </div>
    );
};
