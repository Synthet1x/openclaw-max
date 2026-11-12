/**
 * In-memory fake of src/client.ts for unit tests.
 * Records every call in `mock.calls`; behavior flags let tests simulate
 * deletion failures and one-off send failures.
 */
export const mock = {
  calls: [],
  seq: 0,
  deleteFails: false,
  failNextSend: false,
};

export function resetMock() {
  mock.calls = [];
  mock.seq = 0;
  mock.deleteFails = false;
  mock.failNextSend = false;
}

function record(fn, args) {
  mock.calls.push({ fn, args });
}

function newMid() {
  return `mid-${++mock.seq}`;
}

function sendResult() {
  if (mock.failNextSend) {
    mock.failNextSend = false;
    return null;
  }
  return newMid();
}

export async function sendDm(token, userId, text) {
  record("sendDm", { userId, text });
  return sendResult();
}

export async function sendToChat(token, chatId, text) {
  record("sendToChat", { chatId, text });
  return sendResult();
}

export async function editMessage(token, messageId, text, attachments) {
  record("editMessage", { messageId, text, attachments });
  return true;
}

export async function deleteMessage(token, messageId) {
  record("deleteMessage", { messageId });
  return !mock.deleteFails;
}

export async function sendMessageWithKeyboard(token, to, text, buttons) {
  record("sendMessageWithKeyboard", { to, text, buttons });
  return sendResult();
}

export async function sendMessageWithAttachment(token, target, text, type, attachmentToken) {
  record("sendMessageWithAttachment", { target, text, type });
  return sendResult();
}

export async function sendTypingAction() {}
export async function setMyCommands() { return true; }
export async function getUpdates() { return { updates: [] }; }
export async function subscribeWebhook() {}
export async function deleteWebhook() {}
export async function getBotInfo() { return { name: "fake", username: "fake" }; }
export async function getUploadUrl() { return null; }
export async function uploadFile() { return null; }
export function configureMaxTransport() {}
export async function downloadFile() { return null; }
export async function getMessage() { return null; }
export async function answerOnCallback() { return true; }
