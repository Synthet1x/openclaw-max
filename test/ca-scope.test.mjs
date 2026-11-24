/**
 * Unit tests for the scoped CA-trust fix (v1.2.1).
 *
 * Covers:
 *   1. isMaxInfraHost allowlist: MAX platform + media upload/download domains
 *      match (apex and subdomains); look-alike and attacker-suffix hosts don't.
 *   2. dispatcherForUrl: MAX hosts share the extended-CA dispatcher, non-MAX
 *      hosts get a distinct standard dispatcher; proxy reconfiguration keeps
 *      the two dispatchers separate.
 *   3. fetchWithScopedTrust redirect safety (local HTTP servers):
 *      - redirects are followed manually across origins
 *      - Authorization is dropped on cross-origin redirects, kept same-origin
 *      - 303 converts POST to bodyless GET
 *      - redirect loops and non-HTTP(S) locations are rejected
 *
 * Usage: npm run build && npm test
 */
import assert from "node:assert/strict";
import http from "node:http";
import {
  isMaxInfraHost,
  dispatcherForUrl,
  configureMaxTransport,
  fetchWithScopedTrust,
  MAX_INFRA_DOMAINS,
} from "../dist/src/client.js";

// ─── 1. Host allowlist ────────────────────────────────────────────────────────

const allowed = [
  "platform-api2.max.ru",
  "botapi.max.ru",
  "max.ru",
  "any.future.sub.max.ru",
  "fu.oneme.ru",
  "iu.oneme.ru",
  "oneme.ru",
  "omu.okcdn.ru",
  "omub.okcdn.ru",
  "okcdn.ru",
  "PLATFORM-API2.MAX.RU",
  "max.ru.", // trailing dot normalizes to the apex
];
for (const h of allowed) {
  assert.equal(isMaxInfraHost(h), true, `expected allow: ${h}`);
}

const denied = [
  "example.com",
  "evilmax.ru",
  "max.ru.attacker.com",
  "oneme.ru.evil.com",
  "okcdn.ru.evil.com",
  "notmax.ru",
  "max.ru.com",
  "fu.oneme.ru.evil.com",
  "",
  "localhost",
  "127.0.0.1",
];
for (const h of denied) {
  assert.equal(isMaxInfraHost(h), false, `expected deny: ${h}`);
}
assert.deepEqual([...MAX_INFRA_DOMAINS], ["max.ru", "oneme.ru", "okcdn.ru"]);

// ─── 2. Dispatcher selection ──────────────────────────────────────────────────

configureMaxTransport(); // direct (no proxy)
const maxDirect = dispatcherForUrl("https://platform-api2.max.ru/me");
const maxUpload = dispatcherForUrl("https://fu.oneme.ru/upload");
const maxCdn = dispatcherForUrl("https://omu.okcdn.ru/upload.do");
const otherDirect = dispatcherForUrl("https://example.com/file");
assert.equal(maxDirect, maxUpload, "MAX hosts must share one dispatcher");
assert.equal(maxDirect, maxCdn, "MAX CDN hosts must share the MAX dispatcher");
assert.notEqual(maxDirect, otherDirect, "non-MAX hosts must get a different dispatcher");
assert.equal(otherDirect, dispatcherForUrl("http://127.0.0.1:8080/x"));

configureMaxTransport({ httpProxy: "http://127.0.0.1:10808" });
const maxProxy = dispatcherForUrl("https://platform-api2.max.ru/me");
const otherProxy = dispatcherForUrl("https://example.com/file");
assert.notEqual(maxProxy, maxDirect, "proxy reconfig must rebuild the MAX dispatcher");
assert.notEqual(maxProxy, otherProxy, "proxy mode must keep MAX/standard dispatchers separate");
configureMaxTransport(); // restore for the redirect tests below

// ─── 3. Redirect safety (local servers) ───────────────────────────────────────

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

const seen = [];
const serverB = http.createServer((req, res) => {
  seen.push({ server: "B", method: req.method, url: req.url, auth: req.headers.authorization ?? null });
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("final-body");
});
const portB = await listen(serverB);

const serverA = http.createServer((req, res) => {
  seen.push({ server: "A", method: req.method, url: req.url, auth: req.headers.authorization ?? null });
  if (req.url === "/same-origin") {
    res.writeHead(302, { Location: "/landing" });
  } else if (req.url === "/landing") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`auth=${req.headers.authorization ?? "none"}`);
  } else if (req.url === "/post303") {
    res.writeHead(303, { Location: `http://127.0.0.1:${portB}/after303` });
  } else if (req.url === "/loop") {
    res.writeHead(302, { Location: "/loop" });
  } else if (req.url === "/badproto") {
    res.writeHead(302, { Location: "file:///etc/passwd" });
  } else {
    res.writeHead(302, { Location: `http://127.0.0.1:${portB}/final` });
  }
  res.end();
});
const portA = await listen(serverA);
const baseA = `http://127.0.0.1:${portA}`;

try {
  // Cross-origin redirect is followed; Authorization must NOT leak across origins.
  seen.length = 0;
  let res = await fetchWithScopedTrust(`${baseA}/start`, { headers: { Authorization: "secret-token" } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "final-body");
  assert.equal(seen[0].auth, "secret-token", "origin hop keeps credentials");
  assert.equal(seen[1].auth, null, "cross-origin redirect must drop Authorization");

  // Same-origin redirect keeps Authorization.
  res = await fetchWithScopedTrust(`${baseA}/same-origin`, { headers: { Authorization: "secret-token" } });
  assert.equal(await res.text(), "auth=secret-token");

  // 303 turns POST into a bodyless GET.
  seen.length = 0;
  res = await fetchWithScopedTrust(`${baseA}/post303`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ a: 1 }),
  });
  assert.equal(res.status, 200);
  assert.equal(seen[0].method, "POST");
  assert.equal(seen[1].method, "GET", "303 must switch to GET");

  // Redirect loop is rejected.
  await assert.rejects(() => fetchWithScopedTrust(`${baseA}/loop`), /too many redirects/);

  // Non-HTTP(S) redirect location is rejected.
  await assert.rejects(() => fetchWithScopedTrust(`${baseA}/badproto`), /non-HTTP/);

  console.log("ca-scope.test: all checks passed");
} finally {
  serverA.close();
  serverB.close();
}
