import { normalizeContact, MAX_CONTACTS, text } from "./model.mjs";
const userId = (value) => String(value ?? "").replace(/^user/, "");
export function importTelegram(input) {
  if (typeof input !== "string" || input.length > 25 * 1024 * 1024)
    throw new Error("Choose a Telegram JSON export smaller than 25 MB.");
  let data;
  try {
    data = JSON.parse(input.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error(
      "This is not valid JSON. Choose Telegram Desktop’s result.json export.",
    );
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Unsupported Telegram export.");
  const known = new Map();
  let skipped = 0;
  const own = userId(data.personal_information?.user_id);
  const add = (raw, key) => {
    const c = normalizeContact({ ...raw, sourceId: key }, "TELEGRAM");
    if (!c) {
      skipped++;
      return;
    }
    if (known.size >= MAX_CONTACTS && !known.has(key))
      throw new Error("Import at most 25,000 Telegram contacts.");
    known.set(key, c);
  };
  for (const c of data.contacts?.list || []) {
    if (own && userId(c.user_id || c.id) === own) continue;
    const name = [text(c.first_name), text(c.last_name)]
      .filter(Boolean)
      .join(" ");
    const key =
      c.user_id || c.id
        ? "user:" + userId(c.user_id || c.id)
        : "contact:" + JSON.stringify([name, text(c.phone_number)]);
    add({ name, phones: c.phone_number ? [String(c.phone_number)] : [] }, key);
  }
  const chats = Array.isArray(data.chats?.list)
    ? data.chats.list
    : Array.isArray(data.messages)
      ? [data]
      : [];
  let inspected = 0;
  for (const chat of chats) {
    if (chat.type !== "personal_chat") continue;
    const peer = userId(chat.id);
    if (!peer || peer === own) continue;
    let name = text(chat.name),
      lastAt = 0,
      sent = 0,
      received = 0;
    for (const m of chat.messages || []) {
      if (++inspected > 500000)
        throw new Error(
          "This Telegram export contains too many messages. Export fewer chats.",
        );
      if (m.type !== "message") continue;
      const sender = userId(m.from_id);
      if (sender === peer) {
        received++;
        if (!name) name = text(m.from);
      } else if (sender) sent++;
      const timestamp =
        Number(m.date_unixtime) * 1000 || Date.parse(m.date) || 0;
      lastAt = Math.max(lastAt, timestamp);
      // Never read message text, entities, forwarding metadata or attachments.
    }
    const key = "user:" + peer,
      previous = known.get(key);
    add(
      {
        name,
        phones: previous?.phones || [],
        interaction: { sent, received, lastAt },
      },
      key,
    );
  }
  if (!known.size)
    throw new Error(
      "No named contacts or personal chats were found. Export contacts or personal chats as JSON; groups, bots and channels are excluded.",
    );
  return { source: "TELEGRAM", contacts: [...known.values()], skipped };
}
