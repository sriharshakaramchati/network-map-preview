import { createIdentity, openHandoff } from "../vault.mjs";
import { normalizeContact } from "./model.mjs";
export async function callbackRequest(origin, path, token, options = {}) {
  const response = await fetch(origin + path, {
    ...options,
    credentials: "omit",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    signal: options.signal || AbortSignal.timeout(95000),
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
  }).catch(() => {
    options.signal?.throwIfAborted();
    throw new Error(
      "Could not reach MyGate verification. Unlock the saved import to resume.",
    );
  });
  if (!response.ok) {
    if ([404, 410].includes(response.status))
      throw Object.assign(new Error("This verification expired. Start a new verification."), { code: "SESSION_EXPIRED" });
    throw new Error(
      "MyGate verification is unavailable. Please try again later.",
    );
  }
  return response.status === 204 ? null : response.json();
}
export async function startMyGate(origin) {
  const u = new URL(origin);
  const local =
    ["localhost", "127.0.0.1"].includes(location.hostname) &&
    ["localhost", "127.0.0.1"].includes(u.hostname);
  if ((u.protocol !== "https:" && !local) || u.origin !== origin)
    throw new Error("Invalid callback configuration.");
  const keys = await createIdentity();
  const session = await callbackRequest(origin, "/v1/sessions", null, {
    method: "POST",
    body: JSON.stringify({ publicKey: keys.publicKey }),
  });
  return {
    origin,
    sessionId: session.sessionId,
    token: session.token,
    config: session.config,
    privateKey: keys.privateKey,
  };
}
export const endMyGate = (state) =>
  callbackRequest(
    state.origin,
    "/v1/sessions/" + state.sessionId,
    state.token,
    { method: "DELETE" },
  );
export const myGateStatus = (state, signal) => callbackRequest(
  state.origin, "/v1/sessions/" + encodeURIComponent(state.sessionId), state.token, { signal },
);
export async function pollMyGate(state, signal, onProgress, initialStatus) {
  const path = "/v1/sessions/" + encodeURIComponent(state.sessionId);
  while (!signal.aborted) {
    const result = initialStatus || await myGateStatus(state, signal);
    initialStatus = null;
    if (result.status === "ready") {
      const envelope = await callbackRequest(
        state.origin,
        path + "/result",
        state.token,
        { signal },
      );
      const dataset = await openHandoff(
        envelope,
        state.privateKey,
        state.sessionId,
      );
      if (
        dataset.version !== 1 ||
        dataset.source !== "MYGATE" ||
        !Array.isArray(dataset.residents)
      )
        throw new Error("Unsupported verified directory.");
      return {
        source: "MYGATE",
        contacts: dataset.residents
          .map((r) => normalizeContact({ ...r, sourceId: r.id }, "MYGATE"))
          .filter(Boolean),
        skipped: 0,
      };
    }
    onProgress(
      result.status === "verifying"
        ? "Checking your MyGate proof…"
        : "Waiting for your verified directory…",
    );
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2500);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
  throw new DOMException("Cancelled", "AbortError");
}
