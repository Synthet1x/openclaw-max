import {
  legacyInteractiveReplyToPresentation,
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationControlValue,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { MessagePresentationButton } from "openclaw/plugin-sdk/interactive-runtime";

export interface MaxButton {
  type: "callback" | "link";
  text: string;
  payload?: string;
  url?: string;
}

export interface MaxInlineKeyboardAttachment {
  type: "inline_keyboard";
  payload: {
    buttons: MaxButton[][];
  };
}

export const MAX_PRESENTATION_ROW_SIZE = 3;
export const MAX_KEYBOARD_LIMITS = {
  maxButtons: 210,
  maxRows: 30,
  maxButtonsPerRow: 7,
  maxButtonsPerRowRestricted: 3,
  maxUrlLength: 2048,
} as const;

function presentationButtonToMaxButton(button: MessagePresentationButton): MaxButton | null {
  if (button.disabled === true) return null;
  const label = typeof button.label === "string" ? button.label.trim() : "";
  if (!label) return null;
  const action = resolveMessagePresentationButtonAction(button);
  if (!action) return null;
  if ((action.type === "url" || action.type === "web-app") && action.url) {
    return { type: "link", text: label, url: action.url };
  }
  const value = resolveMessagePresentationControlValue(button);
  if (typeof value === "string" && value.trim()) {
    return { type: "callback", text: label, payload: value };
  }
  return null;
}

export function presentationToMaxButtons(rawPresentation: unknown): MaxButton[][] | null {
  const presentation = normalizeMessagePresentation(rawPresentation);
  if (!presentation) return null;
  const rows: MaxButton[][] = [];
  let row: MaxButton[] = [];
  const flush = () => {
    if (row.length > 0) {
      rows.push(row);
      row = [];
    }
  };
  for (const block of presentation.blocks) {
    if (block.type !== "buttons") continue;
    for (const button of block.buttons) {
      const rendered = presentationButtonToMaxButton(button);
      if (!rendered) continue;
      row.push(rendered);
      if (row.length === MAX_PRESENTATION_ROW_SIZE) flush();
    }
  }
  flush();
  if (rows.length === 0) return null;
  return rows;
}

export function interactiveToMaxButtons(rawInteractive: unknown): MaxButton[][] | null {
  const interactive = normalizeLegacyInteractiveReply(rawInteractive);
  if (!interactive) return null;
  const presentation = legacyInteractiveReplyToPresentation(interactive);
  if (!presentation) return null;
  return presentationToMaxButtons(presentation);
}

export function resolvePayloadKeyboardButtons(
  payload: { channelData?: unknown; interactive?: unknown; presentation?: unknown } | null | undefined,
): MaxButton[][] | null {
  if (!payload || typeof payload !== "object") return null;
  return interactiveToMaxButtons(payload.interactive) ?? presentationToMaxButtons(payload.presentation);
}

export function toInlineKeyboardAttachment(buttons: MaxButton[][]): MaxInlineKeyboardAttachment {
  return {
    type: "inline_keyboard",
    payload: { buttons },
  };
}
