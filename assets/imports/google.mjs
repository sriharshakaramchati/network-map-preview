import { normalizeContact, MAX_CONTACTS, email, text } from "./model.mjs";
export const CONTACTS_SCOPE =
  "https://www.googleapis.com/auth/contacts.readonly";
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.metadata";
let identityScript;
export function loadGoogleIdentity() {
  if (globalThis.google?.accounts?.oauth2) return Promise.resolve();
  if (!identityScript)
    identityScript = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.referrerPolicy = "strict-origin-when-cross-origin";
      s.onload = () => resolve();
      s.onerror = () => {
        identityScript = null;
        s.remove();
        reject(
          new Error(
            "Google sign-in could not load. Check your connection and try again.",
          ),
        );
      };
      document.head.append(s);
    });
  return identityScript;
}
export function authorizeGoogle(clientId, scope) {
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId || ""))
    return Promise.reject(
      new Error(
        "Google sign-in is awaiting the owner’s OAuth client configuration.",
      ),
    );
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope,
      include_granted_scopes: false,
      prompt: "select_account",
      callback: (result) => {
        if (result.error || !result.access_token)
          return reject(
            new Error(
              "Google permission was not granted. No contacts were imported.",
            ),
          );
        if (!google.accounts.oauth2.hasGrantedAllScopes(result, scope))
          return reject(
            new Error("The required Google permission was not granted."),
          );
        resolve({
          token: result.access_token,
          expiresAt: Date.now() + Number(result.expires_in || 3600) * 1000,
        });
      },
      error_callback: () =>
        reject(
          new Error("Google sign-in was closed or blocked. Please try again."),
        ),
    });
    client.requestAccessToken();
  });
}
// Used directly by the browser. Tokens are never sent to our callback, URLs or storage.
export async function googleJSON(
  path,
  token,
  { signal, fetcher = fetch } = {},
) {
  const url = new URL(path);
  if (
    !["people.googleapis.com", "gmail.googleapis.com"].includes(url.hostname) ||
    url.protocol !== "https:"
  )
    throw new Error("Unsupported Google API endpoint.");
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    let response;
    try {
      response = await fetcher(url.href, {
        headers: { Authorization: "Bearer " + token },
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw new Error(
        "Google could not be reached. Nothing has been saved; try again.",
      );
    }
    if (response.ok) return response.json();
    if (response.status === 401)
      throw new Error(
        "Your Google session expired. Sign in again to continue.",
      );
    if (response.status === 403)
      throw new Error(
        "Google denied access. Check the granted permission and whether this account is allowed to test the app.",
      );
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 600 * 2 ** attempt);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("Cancelled", "AbortError"));
          },
          { once: true },
        );
      });
      continue;
    }
    throw new Error(
      "Google could not complete the import. No partial import has been saved.",
    );
  }
}
export async function importGoogleContacts(token, options = {}) {
  const contacts = [];
  let pageToken = "",
    skipped = 0;
  const seen = new Set();
  do {
    const u = new URL("https://people.googleapis.com/v1/people/me/connections");
    u.search = new URLSearchParams({
      personFields: "names,emailAddresses,phoneNumbers,organizations",
      pageSize: "1000",
      ...(pageToken ? { pageToken } : {}),
    });
    const result = await googleJSON(u.href, token, options);
    for (const person of result.connections || []) {
      if (seen.has(person.resourceName)) continue;
      seen.add(person.resourceName);
      const name =
        (person.names || []).find((n) => n.metadata?.primary)?.displayName ||
        person.names?.[0]?.displayName;
      const org =
        person.organizations?.find((o) => o.current) ||
        person.organizations?.[0];
      const c = normalizeContact(
        {
          name,
          emails: (person.emailAddresses || []).map((e) => e.value),
          phones: (person.phoneNumbers || []).map(
            (p) => p.canonicalForm || p.value,
          ),
          company: org?.name,
          role: org?.title,
          sourceId: person.resourceName,
        },
        "GOOGLE",
      );
      if (c) contacts.push(c);
      else skipped++;
      if (contacts.length > MAX_CONTACTS)
        throw new Error("This map supports up to 25,000 contacts.");
    }
    options.onProgress?.(`Read ${contacts.length} Google contacts…`);
    if (result.nextPageToken && result.nextPageToken === pageToken)
      throw new Error(
        "Google returned a repeated page. Please retry the import.",
      );
    pageToken = result.nextPageToken || "";
  } while (pageToken);
  if (!contacts.length)
    throw new Error("Google returned no named contacts for this account.");
  return { source: "GOOGLE", contacts, skipped };
}
function decodeName(value) {
  return value.replace(
    /=\?([^?]+)\?([bq])\?([^?]*)\?=/gi,
    (_m, charset, encoding, body) => {
      try {
        const raw =
          encoding.toLowerCase() === "b"
            ? atob(body)
            : body
                .replace(/_/g, " ")
                .replace(/=([a-f\d]{2})/gi, (_, h) =>
                  String.fromCharCode(parseInt(h, 16)),
                );
        return new TextDecoder(charset).decode(
          Uint8Array.from(raw, (c) => c.charCodeAt(0)),
        );
      } catch {
        return "";
      }
    },
  );
}
export function addresses(header) {
  const pieces = [];
  let part = "",
    quote = false,
    angle = 0,
    escape = false;
  for (const ch of String(header || "")) {
    if (escape) {
      part += ch;
      escape = false;
      continue;
    }
    if (ch === "\\" && quote) {
      escape = true;
      part += ch;
      continue;
    }
    if (ch === '"') quote = !quote;
    if (!quote && ch === "<") angle++;
    if (!quote && ch === ">") angle--;
    if (!quote && !angle && (ch === "," || ch === ";")) {
      pieces.push(part);
      part = "";
    } else part += ch;
  }
  pieces.push(part);
  return pieces.flatMap((piece) => {
    const bracket = piece.match(/<([^<>]+)>/),
      addr = email(bracket ? bracket[1] : piece.replace(/^.*?:\s*/, ""));
    if (!addr) return [];
    const name = decodeName(
      bracket
        ? piece
            .slice(0, piece.indexOf("<"))
            .trim()
            .replace(/^"|"$/g, "")
            .replace(/\\"/g, '"')
        : "",
    );
    return [{ email: addr, name: text(name) || addr }];
  });
}
export function rankCorrespondents(messages, ownEmail, now = Date.now()) {
  const own = new Set([email(ownEmail)]),
    byEmail = new Map();
  const headers = (m) =>
    Object.fromEntries(
      (m.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]),
    );
  for (const m of messages)
    if (m.labelIds?.includes("SENT"))
      for (const a of addresses(headers(m).from)) own.add(a.email);
  for (const m of messages) {
    if (m.labelIds?.some((l) => ["SPAM", "TRASH", "DRAFT"].includes(l)))
      continue;
    const h = headers(m),
      sent = m.labelIds?.includes("SENT");
    if (
      h["list-unsubscribe"] ||
      /bulk|list|junk/i.test(h.precedence || "") ||
      (h["auto-submitted"] && h["auto-submitted"].toLowerCase() !== "no")
    )
      continue;
    const peers = sent
      ? [...addresses(h.to), ...addresses(h.cc), ...addresses(h.bcc)]
      : addresses(h.from);
    const once = new Set();
    for (const peer of peers) {
      if (
        own.has(peer.email) ||
        once.has(peer.email) ||
        /^(no[._-]?reply|do[._-]?not[._-]?reply|mailer-daemon|notifications?)@/i.test(
          peer.email,
        )
      )
        continue;
      once.add(peer.email);
      if (!byEmail.has(peer.email))
        byEmail.set(peer.email, {
          name: peer.name,
          emails: [peer.email],
          sourceId: peer.email,
          interaction: { sent: 0, received: 0, lastAt: 0 },
        });
      const c = byEmail.get(peer.email);
      if (c.name === peer.email && peer.name !== peer.email) c.name = peer.name;
      c.interaction[sent ? "sent" : "received"]++;
      c.interaction.lastAt = Math.max(
        c.interaction.lastAt,
        Math.min(now, Number(m.internalDate) || 0),
      );
    }
  }
  const score = (c) => {
    const x = c.interaction;
    return (
      x.sent * 3 +
      x.received +
      10 * Math.exp(-(now - x.lastAt) / (30 * 86400000))
    );
  };
  return [...byEmail.values()]
    .sort((a, b) => score(b) - score(a))
    .map((c) => normalizeContact(c, "GMAIL"));
}
export async function importGmail(token, options = {}) {
  const profile = await googleJSON(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=emailAddress",
    token,
    options,
  );
  const ids = new Set();
  let limited = false;
  // Metadata scope cannot use Gmail's q search. Sample SENT and INBOX separately so frequent sent contacts are not buried by inbound mail.
  for (const label of ["SENT", "INBOX"]) {
    const url =
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?" +
      new URLSearchParams({
        labelIds: label,
        maxResults: "500",
        includeSpamTrash: "false",
        fields: "messages(id),nextPageToken",
      });
    const result = await googleJSON(url, token, options);
    limited ||= !!result.nextPageToken;
    for (const m of result.messages || []) ids.add(m.id);
  }
  const queue = [...ids],
    messages = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (cursor < queue.length) {
        const id = queue[cursor++],
          u = new URL(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/" +
              encodeURIComponent(id),
          );
        u.searchParams.set("format", "metadata");
        u.searchParams.set(
          "fields",
          "id,internalDate,labelIds,payload(headers)",
        );
        for (const name of [
          "From",
          "To",
          "Cc",
          "Bcc",
          "List-Unsubscribe",
          "Precedence",
          "Auto-Submitted",
        ])
          u.searchParams.append("metadataHeaders", name);
        messages.push(await googleJSON(u.href, token, options));
        options.onProgress?.(
          `Reading correspondents: ${messages.length} of ${queue.length} messages…`,
        );
      }
    }),
  );
  const contacts = rankCorrespondents(messages, profile.emailAddress);
  messages.length = 0;
  if (!contacts.length)
    throw new Error(
      "No personal correspondents were found in the sampled mail.",
    );
  return {
    source: "GMAIL",
    contacts,
    skipped: 0,
    limited,
    sampled: queue.length,
  };
}
