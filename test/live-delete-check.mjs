/**
 * Live API check for deleteMessage() against the real MAX Bot API.
 * Sends a short service message to the owner's DM, deletes it, verifies it is
 * gone. Token is read from the gateway config at runtime (never hardcoded).
 */
import { readFileSync } from "node:fs";
import { sendDm, deleteMessage, getMessage, configureMaxTransport } from "../dist/src/client.js";

const cfg = JSON.parse(readFileSync(`${process.env.HOME}/.openclaw/openclaw.json`, "utf8"));
const token = cfg.channels.max.accounts.orli.token;
const OWNER = 6163830;

configureMaxTransport({});

const mid = await sendDm(token, OWNER, "🔧 служебный тест плагина MAX — это сообщение сейчас удалится");
console.log("sent mid:", mid);
if (!mid) {
  console.log("SEND FAILED");
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 1500));

const ok = await deleteMessage(token, mid);
console.log("delete ok:", ok);

const after = await getMessage(token, mid);
console.log("get after delete:", after === null ? "gone (null)" : JSON.stringify(after).slice(0, 300));

// Double-delete must be a quiet false, not a throw.
const again = await deleteMessage(token, mid);
console.log("double delete returns:", again);

process.exit(ok ? 0 : 1);
