/**
 * Module loader hook: redirects every `./client.js` import coming from the
 * built plugin (dist/) to the in-memory fake client, so the streaming
 * deliverer can be unit-tested without any network access.
 */
export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier === "./client.js" || specifier.endsWith("/client.js")) &&
    context.parentURL &&
    context.parentURL.includes("/dist/")
  ) {
    return {
      url: new URL("./fake-client.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
