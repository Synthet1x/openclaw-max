/**
 * Unit tests for the "buried final answer" fix (v1.1.1).
 *
 * Runs the real createStreamingDeliver() from dist/channel.js against a fake
 * MAX client (see mock-client-loader.mjs). Covers:
 *   1. quiet turn        → final edits the draft in place, no delete
 *   2. user wrote        → draft deleted, final sent as a new message
 *   3. delete fails      → fallback to in-place edit, no duplicate send
 *   4. multi-segment     → inbound baseline re-captured per draft
 *   5. repeated final    → no duplicate delivery
 *   6. buried partial    → frozen partial answer also moved to the bottom
 *   7. buried + keyboard → fresh send carries the inline keyboard
 *   8. send fails once   → retry after successful deletion lands the answer
 *
 * Usage: npm run build && npm test
 */
import { register } from "node:module";
register("./mock-client-loader.mjs", import.meta.url);

const { createStreamingDeliver, bumpInboundSeq } = await import("../dist/src/channel.js");
const { mock, resetMock } = await import("./fake-client.mjs");

let passed = 0;
let failed = 0;

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function calls(fn) {
  return mock.calls.filter((c) => c.fn === fn);
}

function makeDeliverer(chatId) {
  return createStreamingDeliver(
    { accountId: "test", token: "t" },
    chatId,
    chatId,
    "direct",
    undefined,
    true,
  );
}

const USER = "6163830";

// ─── 1. Quiet turn: edit in place ────────────────────────────────────────────
{
  resetMock();
  const d = makeDeliverer("111");
  await d.startDraft();
  const draftId = `mid-${mock.seq}`;
  await d.onToolProgress("exec: ls -la");
  await d.deliver({ text: "Final answer one" });

  check("1: one draft sent", calls("sendDm").length === 1);
  check("1: no deletion", calls("deleteMessage").length === 0);
  const edits = calls("editMessage");
  const finalEdit = edits[edits.length - 1];
  check("1: final edited in place", finalEdit?.args.messageId === draftId && finalEdit?.args.text.includes("Final answer one"),
    JSON.stringify(finalEdit?.args));
  await d.deliver({ text: "" }); // stop typing timers
}

// ─── 2. User wrote during work: delete + fresh send ─────────────────────────
{
  resetMock();
  const d = makeDeliverer("222");
  await d.startDraft();
  const draftId = `mid-${mock.seq}`;
  bumpInboundSeq("test", "222");
  bumpInboundSeq("test", "222");
  bumpInboundSeq("test", "222");
  await d.deliver({ text: "Final answer two" });

  const sends = calls("sendDm");
  const dels = calls("deleteMessage");
  check("2: draft deleted", dels.length === 1 && dels[0].args.messageId === draftId, JSON.stringify(dels));
  check("2: final sent as new message", sends.length === 2 && sends[1].args.text === "Final answer two",
    JSON.stringify(sends.map((s) => s.args.text)));
  check("2: no in-place final edit", !calls("editMessage").some((c) => c.args.text.includes("Final answer two")));
  const delIdx = mock.calls.findIndex((c) => c.fn === "deleteMessage");
  const freshIdx = mock.calls.findIndex((c) => c.fn === "sendDm" && c.args.text === "Final answer two");
  check("2: delete happens before fresh send", delIdx !== -1 && freshIdx > delIdx);
}

// ─── 3. Delete fails: fallback to in-place edit ──────────────────────────────
{
  resetMock();
  mock.deleteFails = true;
  const d = makeDeliverer("333");
  await d.startDraft();
  const draftId = `mid-${mock.seq}`;
  bumpInboundSeq("test", "333");
  await d.deliver({ text: "Final answer three" });

  check("3: deletion attempted", calls("deleteMessage").length === 1);
  check("3: no second send (no duplicate)", calls("sendDm").length === 1);
  const edits = calls("editMessage");
  const finalEdit = edits[edits.length - 1];
  check("3: fallback edit in place", finalEdit?.args.messageId === draftId && finalEdit?.args.text.includes("Final answer three"),
    JSON.stringify(finalEdit?.args));
}

// ─── 4. Multi-segment: baseline re-captured per draft ────────────────────────
{
  resetMock();
  const d = makeDeliverer("444");
  await d.startDraft();                       // draft 1, baseline 0
  const draft1 = `mid-${mock.seq}`;
  bumpInboundSeq("test", "444");              // user writes during segment 1
  await d.deliver({ text: "Answer A" });      // buried → delete draft 1, send A fresh
  await d.onToolProgress("exec: next step");  // segment 2 → draft 2, baseline re-captured (=1)
  const draft2 = `mid-${mock.seq}`;
  await d.deliver({ text: "Answer B" });      // no new inbound → NOT buried → edit in place

  const dels = calls("deleteMessage");
  check("4: only buried draft 1 deleted", dels.length === 1 && dels[0].args.messageId === draft1, JSON.stringify(dels));
  const sends = calls("sendDm");
  check("4: three sends (draft1, A fresh, draft2)", sends.length === 3, JSON.stringify(sends.map((s) => s.args.text)));
  const edits = calls("editMessage");
  const finalEdit = edits[edits.length - 1];
  check("4: answer B edited into draft 2", finalEdit?.args.messageId === draft2 && finalEdit?.args.text.includes("Answer B"),
    JSON.stringify(finalEdit?.args));
}

// ─── 5. Repeated final: no duplicate delivery ────────────────────────────────
{
  resetMock();
  const d = makeDeliverer("555");
  await d.startDraft();
  await d.deliver({ text: "Same answer" });
  const before = mock.calls.length;
  await d.deliver({ text: "Same answer" });
  check("5: repeated final is a no-op", mock.calls.length === before, `+${mock.calls.length - before} calls`);
}

// ─── 6. Buried partial answer frozen by a new answer block ───────────────────
{
  resetMock();
  const d = makeDeliverer("666");
  await d.onPartialToken("Partial answer one");   // streaming draft 1
  const draft1 = `mid-${mock.seq}`;
  bumpInboundSeq("test", "666");                  // user writes
  await d.onPartialToken("Completely different second answer"); // new block → freeze partial 1
  await d.deliver({ text: "Completely different second answer" });

  const dels = calls("deleteMessage");
  check("6: buried partial draft deleted", dels.length === 1 && dels[0].args.messageId === draft1, JSON.stringify(dels));
  check("6: partial re-sent at bottom", calls("sendDm").some((c) => c.args.text === "Partial answer one"));
  const edits = calls("editMessage");
  const finalEdit = edits[edits.length - 1];
  check("6: second answer edits its own fresh draft", finalEdit?.args.text.includes("Completely different second answer") && finalEdit?.args.messageId !== draft1,
    JSON.stringify(finalEdit?.args));
}

// ─── 7. Buried final with inline keyboard ────────────────────────────────────
{
  resetMock();
  const d = makeDeliverer("777");
  await d.startDraft();
  bumpInboundSeq("test", "777");
  await d.deliver({
    text: "Pick an option",
    channelData: { max: { buttons: [[{ type: "callback", text: "OK", payload: "/ok" }]] } },
  });

  check("7: draft deleted", calls("deleteMessage").length === 1);
  const kb = calls("sendMessageWithKeyboard");
  check("7: fresh send carries keyboard", kb.length === 1 && kb[0].args.text === "Pick an option" && kb[0].args.buttons?.length === 1,
    JSON.stringify(kb));
  check("7: no plain duplicate send", calls("sendDm").length === 1);
}

// ─── 8. Fresh send fails once after deletion: retry lands it ─────────────────
{
  resetMock();
  const d = makeDeliverer("888");
  await d.startDraft();
  bumpInboundSeq("test", "888");
  mock.failNextSend = true; // the first fresh-send attempt fails
  await d.deliver({ text: "Survivor answer" });

  check("8: draft deleted", calls("deleteMessage").length === 1);
  const sends = calls("sendDm");
  check("8: retry delivered the answer", sends.length === 3 && sends[2].args.text === "Survivor answer",
    JSON.stringify(sends.map((s) => s.args.text)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
