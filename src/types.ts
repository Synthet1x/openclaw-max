/**
 * TypeScript types for the MAX Bot API.
 * https://dev.max.ru/docs-api
 */

// ─── Config ───────────────────────────────────────────────────────────────────

export interface MaxAccountConfig {
  enabled?: boolean;
  /** Bot token from MAX Partner Platform */
  token?: string;
  /**
   * Public HTTPS URL for webhook delivery (e.g. https://yourdomain.com/max/webhook).
   * If omitted, the plugin falls back to long polling.
   */
  webhookUrl?: string;
  /** Secret sent in X-Max-Bot-Api-Secret header to validate webhook requests */
  webhookSecret?: string;
  /** Gateway-internal HTTP path for the webhook route (default: /max/webhook) */
  webhookPath?: string;
  /** Directory for downloaded inbound attachments (default: inbox/max) */
  inboxDir?: string;
  /** DM policy: who can send messages to the bot */
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  /** Allowlisted MAX user IDs (numeric) or usernames */
  allowFrom?: string[];
  /** Group chat policy */
  groupPolicy?: "open" | "allowlist" | "disabled";
  /** Group allowlisted user IDs */
  groupAllowFrom?: string[];
  /**
   * Optional HTTP(S) proxy for all MAX API traffic, e.g. http://user:***@host:port.
   * Useful when the gateway has no direct route to platform-api2.max.ru.
   */
  httpProxy?: string;
}

export interface MaxConfig extends MaxAccountConfig {
  accounts?: Record<string, MaxAccountConfig>;
}

export interface ResolvedMaxAccount {
  accountId: string;
  token: string;
  enabled: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath: string;
  inboxDir?: string;
  dmPolicy: "open" | "allowlist" | "pairing" | "disabled";
  allowFrom: string[];
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: string[];
  httpProxy?: string;
}

// ─── API objects ──────────────────────────────────────────────────────────────

export interface MaxUser {
  user_id: number;
  name: string;
  first_name?: string;
  last_name?: string;
  username?: string;
  is_bot?: boolean;
  last_activity_time?: number;
}

export interface MaxRecipient {
  chat_id?: number;
  user_id?: number;
  chat_type?: "dialog" | "chat" | "channel" | "group" | string;
}

export interface MaxAttachmentPayload {
  token?: string;
  url?: string;
  file_id?: string;
  name?: string;
  filename?: string;
  title?: string;
  description?: string;
  mime_type?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface MaxAttachment {
  type: "image" | "video" | "audio" | "file" | "inline_keyboard" | "sticker" | "location" | "share" | string;
  payload?: MaxAttachmentPayload;
  filename?: string;
  name?: string;
  title?: string;
  mime_type?: string;
}

export interface MaxMessageBody {
  mid: string;
  seq: number;
  text?: string;
  attachments?: MaxAttachment[];
}

export interface MaxMessageLink {
  type?: "forward" | "reply" | string;
  sender?: MaxUser;
  message?: {
    mid?: string;
    text?: string;
    attachments?: MaxAttachment[];
  };
}

export interface MaxMessage {
  sender?: MaxUser;
  recipient: MaxRecipient;
  timestamp: number;
  body?: MaxMessageBody;
  url?: string;
  link?: MaxMessageLink;
}

export interface MaxBotStartedEvent {
  chat_id: number;
  user: MaxUser;
  timestamp: number;
  payload?: string;
}

// ─── Inbound & Delivery types ─────────────────────────────────────────────────

export interface InboundImage {
  data: string; // base64
  mimeType: string;
}

export interface InboundFile {
  path: string;
  filename: string;
  mimeType: string;
  size: number;
  attachmentType: string;
  isForwarded?: boolean;
}

export interface WebhookDeliverMsg {
  text: string;
  senderId: string;
  senderName: string;
  chatId: string;
  /** The actual MAX dialog/chat ID — used for typing indicator */
  dialogChatId: string;
  chatType: "direct" | "chat" | "channel" | "group";
  messageId: string;
  accountId: string;
  images?: InboundImage[];
  files?: InboundFile[];
  isForwarded?: boolean;
  isReply?: boolean;
  linkType?: string | null;
  originalSenderName?: string | null;
  originalSenderId?: string | null;
}

// ─── Updates ──────────────────────────────────────────────────────────────────

export type MaxUpdateType =
  | "message_created"
  | "message_callback"
  | "bot_started"
  | "bot_removed"
  | "user_added"
  | "user_removed"
  | "chat_title_changed"
  | "message_removed"
  | "message_edited";

export interface MaxUpdate {
  update_type: MaxUpdateType;
  timestamp?: number;
  // message_created / message_edited
  message?: MaxMessage;
  // bot_started / bot_removed / user_added / user_removed
  chat_id?: number;
  user?: MaxUser;
  // message_callback
  callback?: {
    timestamp: number;
    callback_id: string;
    message?: MaxMessage;
    payload?: string;
    user: MaxUser;
  };
}

export interface MaxUpdatesResponse {
  updates: MaxUpdate[];
  marker?: number | null;
}
