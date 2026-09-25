export const SOURCES = Object.freeze({
  MYGATE: "MyGate community",
  GOOGLE: "Google Contacts",
  GMAIL: "Gmail",
  LINKEDIN: "LinkedIn",
  TELEGRAM: "Telegram",
  CSV: "CSV",
});
export const MAX_CONTACTS = 25000;
export const text = (value) =>
  typeof value === "string"
    ? value
        .replace(/\u0000/g, "")
        .trim()
        .slice(0, 500)
    : "";
export const email = (value) => {
  const v = text(value).toLowerCase();
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v) ? v : "";
};
const unique = (values) => [...new Set(values.filter(Boolean))];
export function normalizeContact(raw, source) {
  if (!SOURCES[source]) throw new Error("Unsupported import source.");
  const name = text(raw.name);
  if (!name) return null;
  const emails = unique((raw.emails || []).map(email));
  const phones = unique(
    (raw.phones || []).map(text).filter((p) => /^[+\d\s().-]{5,40}$/.test(p)),
  );
  let profile = "";
  try {
    const u = new URL(raw.profile);
    if (
      u.protocol === "https:" &&
      /(^|\.)linkedin\.com$/.test(u.hostname) &&
      !u.username &&
      !u.password
    )
      profile = u.href;
  } catch {}
  const c = {
    id: crypto.randomUUID(),
    name,
    emails,
    phones,
    unit: text(raw.unit),
    block: text(raw.block),
    company: text(raw.company),
    city: text(raw.city),
    university: text(raw.university),
    role: text(raw.role),
    profile,
    sources: [source],
    origins: [],
  };
  // These keys stay inside the encrypted vault; never in indexes, URLs or logs.
  c.origins = [
    {
      source,
      key:
        text(raw.sourceId) ||
        JSON.stringify([
          name,
          emails,
          phones,
          c.unit,
          c.block,
          c.company,
          c.role,
        ]),
    },
  ];
  if (raw.interaction)
    c.interaction = {
      sent: Math.max(0, Number(raw.interaction.sent) || 0),
      received: Math.max(0, Number(raw.interaction.received) || 0),
      lastAt: Math.max(0, Number(raw.interaction.lastAt) || 0),
    };
  return c;
}
export function newMap(ownerId, displayName) {
  if (!ownerId || !text(displayName))
    throw new Error("Enter your name for this map.");
  return {
    version: 2,
    source: "CONTACTS",
    ownerId,
    displayName: text(displayName),
    contacts: [],
    imports: [],
  };
}
export function upgradeMap(dataset, ownerId) {
  if (dataset.version === 2) {
    if (dataset.ownerId !== ownerId)
      throw new Error("This map belongs to a different private vault.");
    return dataset;
  }
  if (
    dataset.version !== 1 ||
    dataset.source !== "MYGATE" ||
    !Array.isArray(dataset.residents)
  )
    throw new Error("Unsupported private map.");
  const batch = {
    source: "MYGATE",
    contacts: dataset.residents
      .map((r) => normalizeContact({ ...r, sourceId: r.id }, "MYGATE"))
      .filter(Boolean),
  };
  return mergeIntoMap(
    newMap(ownerId, dataset.displayName || "You"),
    batch,
    ownerId,
  ).dataset;
}
export function mergeIntoMap(existing, batch, ownerId) {
  if (existing.version !== 2 || existing.ownerId !== ownerId)
    throw new Error("Unlock your own map before adding contacts.");
  if (
    !SOURCES[batch.source] ||
    !Array.isArray(batch.contacts) ||
    batch.contacts.length > MAX_CONTACTS
  )
    throw new Error("Unsupported or oversized import.");
  const contacts = structuredClone(existing.contacts),
    byOrigin = new Map(),
    byEmail = new Map();
  function index(c) {
    for (const o of c.origins) byOrigin.set(o.source + "\0" + o.key, c);
    for (const e of c.emails) {
      if (!byEmail.has(e)) byEmail.set(e, new Set());
      byEmail.get(e).add(c);
    }
  }
  contacts.forEach(index);
  let added = 0,
    updated = 0,
    unchanged = 0,
    ambiguous = 0;
  for (const raw of batch.contacts) {
    const incoming = normalizeContact(raw, batch.source);
    if (!incoming) continue;
    incoming.origins =
      raw.origins?.filter(
        (o) => o.source === batch.source && typeof o.key === "string",
      ) || incoming.origins;
    if (!incoming.origins.length)
      throw new Error("This import has no source identity.");
    const exact = incoming.origins
      .map((o) => byOrigin.get(o.source + "\0" + o.key))
      .filter(Boolean);
    const matches = new Set(
      exact.length
        ? exact
        : incoming.emails.flatMap((e) => [...(byEmail.get(e) || [])]),
    );
    if (matches.size === 1) {
      const c = [...matches][0],
        before = JSON.stringify(c);
      c.emails = unique([...c.emails, ...incoming.emails]);
      c.phones = unique([...c.phones, ...incoming.phones]);
      c.sources = unique([...c.sources, batch.source]);
      for (const o of incoming.origins)
        if (!c.origins.some((v) => v.source === o.source && v.key === o.key))
          c.origins.push(o);
      for (const field of ["unit", "block", "company", "role", "profile", "city", "university"])
        if (!c[field] && incoming[field]) c[field] = incoming[field];
      // Re-importing an overlapping Gmail sample replaces its aggregate, never double-counts it.
      if (incoming.interaction) c.interaction = incoming.interaction;
      if (before === JSON.stringify(c)) unchanged++;
      else updated++;
      index(c);
    } else {
      if (matches.size > 1) ambiguous++;
      contacts.push(incoming);
      index(incoming);
      added++;
    }
    if (contacts.length > MAX_CONTACTS)
      throw new Error(
        "This map supports up to 25,000 contacts. Import a smaller selection.",
      );
  }
  return {
    dataset: {
      ...existing,
      contacts,
      imports: [
        ...existing.imports,
        {
          source: batch.source,
          at: new Date().toISOString(),
          added,
          updated,
          unchanged,
          skipped: batch.skipped || 0,
          limited: !!batch.limited,
        },
      ].slice(-100),
    },
    added,
    updated,
    unchanged,
    ambiguous,
  };
}
