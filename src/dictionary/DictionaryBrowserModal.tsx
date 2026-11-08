// src/dictionary/DictionaryBrowserModal.tsx
// The overlay's Yomitan-style dictionary popup, opened as a modal from plugin
// pages (cached translations, bookmarks). Steam's gamepad events on the modal
// are forwarded to the popup so it navigates exactly like on the overlay.

import { call, toaster } from "@decky/api";
import { Focusable, GamepadButton, GamepadEvent, ModalRoot } from "@decky/ui";
import { VFC, useRef } from "react";
import { logger } from "../Logger";
import type { NavButton } from "../Input";
import { DictionaryPopup, DictionaryPopupHandle } from "./DictionaryPopup";

const NAV_BY_GAMEPAD: Partial<Record<GamepadButton, NavButton>> = {
    [GamepadButton.OK]: 'a',
    [GamepadButton.SECONDARY]: 'x',
    [GamepadButton.OPTIONS]: 'y',
    [GamepadButton.BUMPER_LEFT]: 'l1',
    [GamepadButton.BUMPER_RIGHT]: 'r1',
    [GamepadButton.DIR_UP]: 'up',
    [GamepadButton.DIR_DOWN]: 'down',
    [GamepadButton.DIR_LEFT]: 'left',
    [GamepadButton.DIR_RIGHT]: 'right',
};

async function sendToPhone(method: 'send_ntfy_notification' | 'send_ntfy_word', text: string) {
    try {
        const res = await call<[string], { success: boolean; message?: string }>(method, text);
        toaster.toast({
            title: res?.success ? 'Sent to phone' : 'Could not send to phone',
            body: res?.success ? text : (res?.message || 'Check the ntfy settings'),
            duration: 2000,
        });
    } catch (e) {
        logger.error('Dictionary', 'Send to phone failed', e);
    }
}

export const DictionaryBrowserModal: VFC<{
    text: string;
    initialOffset?: number;
    closeModal?: () => void;
    onBookmarksChanged?: () => void;
}> = ({ text, initialOffset = 0, closeModal, onBookmarksChanged }) => {
    const popupRef = useRef<DictionaryPopupHandle>(null);
    const close = () => closeModal?.();
    const offset = Math.max(0, Math.min(initialOffset, Array.from(text).length - 1));

    const onButtonDown = (evt: GamepadEvent) => {
        const nav = NAV_BY_GAMEPAD[evt.detail.button as GamepadButton];
        if (!nav) return;
        evt.preventDefault?.();
        evt.stopPropagation?.();
        popupRef.current?.handleNav(nav);
    };

    return (
        // B goes back after following a cross-reference, otherwise closes
        <ModalRoot onCancel={() => popupRef.current?.handleNav('b')} onEscKeypress={close}>
            <Focusable
                onButtonDown={onButtonDown}
                // onActivate makes this element focusable so it receives the
                // gamepad events; A itself is handled in onButtonDown
                onActivate={() => {}}
                preferredFocus
                noFocusRing
                style={{ height: '75vh', minWidth: '560px', display: 'flex' }}
            >
                <DictionaryPopup
                    ref={popupRef}
                    text={text}
                    initialOffset={offset}
                    side="left"
                    embedded
                    showControllerHints
                    onClose={close}
                    onSendText={(t) => sendToPhone('send_ntfy_notification', t)}
                    onSendWord={(w) => sendToPhone('send_ntfy_word', w)}
                    onBookmarksChanged={onBookmarksChanged}
                />
            </Focusable>
        </ModalRoot>
    );
};
