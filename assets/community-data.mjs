import { SOURCES } from "./imports/model.mjs";
export function mapData(dataset) {
  let records;
  if (
    dataset?.version === 1 &&
    dataset.source === "MYGATE" &&
    Array.isArray(dataset.residents)
  ) {
    records = dataset.residents.map((r) => ({
      ...r,
      sources: ["MYGATE"],
      emails: [],
      phones: [],
      clusters: [r.block || "Community"],
    }));
  } else if (
    dataset?.version === 2 &&
    dataset.source === "CONTACTS" &&
    Array.isArray(dataset.contacts)
  ) {
    records = dataset.contacts.map((c) => ({
      ...c,
      clusters: [
        ...(c.block ? [c.block] : []),
        ...c.sources.map((s) => SOURCES[s]),
      ],
    }));
  } else throw new Error("This private map has an unsupported format.");
  if (!records.length || records.length > 25000)
    throw new Error("This map has no contacts or is too large.");
  const groups = new Map();
  for (const c of records) {
    if (
      typeof c.name !== "string" ||
      typeof c.unit !== "string" ||
      typeof c.block !== "string" ||
      !c.clusters.length ||
      c.clusters.some((s) => !s)
    )
      throw new Error("This private map has an unsupported contact.");
    for (const name of c.clusters) {
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(c);
    }
  }
  const W = 3840,
    H = 2160,
    hub = [1920, 1155.6],
    clusters = [],
    people = [];
  const ordered = [...groups].sort(([a], [b]) => a.localeCompare(b));
  ordered.forEach(([name, members], i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / ordered.length,
      R = Math.min(
        410,
        Math.max(110, Math.sqrt(members.length) * 24),
        1600 / Math.max(2, ordered.length),
      );
    clusters.push({
      name,
      x: hub[0] + Math.cos(angle) * 1180,
      y: hub[1] + Math.sin(angle) * 630,
      R,
      core: R * 0.3,
      n: members.length,
      total: members.length,
    });
  });
  const centers = new Map(clusters.map((c) => [c.name, c]));
  const placed = new Map(),
    sizes = new Map();
  records.forEach((c) =>
    sizes.set(c.clusters[0], (sizes.get(c.clusters[0]) || 0) + 1),
  );
  records.forEach((c) => {
    const primary = c.clusters[0],
      center = centers.get(primary),
      j = placed.get(primary) || 0;
    placed.set(primary, j + 1);
    const size = sizes.get(primary);
    const radius = center.R * 0.92 * Math.sqrt((j + 0.5) / size),
      theta = j * Math.PI * (3 - Math.sqrt(5));
    const verified = c.sources.includes("MYGATE"),
      conversation = !!c.interaction;
    const role =
      [c.enrichment?.role || c.role, c.enrichment?.company || c.company].filter(Boolean).join(" · ") ||
      (c.unit ? `Unit ${c.unit} · ${c.block || "Community"}` : "");
    people.push({
      id: people.length,
      name: c.name,
      role,
      link: c.enrichment?.url || c.profile || "",
      conf: [verified ? "Verified MyGate residency" : "Imported contact", c.enrichment ? `Profile confirmed by you · ${c.enrichment.source}` : ""].filter(Boolean).join(" · "),
      clusters: c.clusters,
      primary,
      extra: { flat: c.unit, org: c.enrichment?.company || c.company || "" },
      row: people.length,
      tier: verified ? "resident" : conversation ? "correspondent" : "contact",
      r: conversation
        ? Math.min(
            10,
            6 + Math.log1p(c.interaction.sent + c.interaction.received),
          )
        : 6,
      prio: conversation
        ? 40 + Math.log1p(c.interaction.sent * 3 + c.interaction.received)
        : 30,
      t: 1,
      x: center.x + Math.cos(theta) * radius,
      y: center.y + Math.sin(theta) * radius,
    });
  });
  return { W, H, hub, clusters, people };
}
export function contactBook(dataset) {
  const K = {};
  if (dataset.version === 2)
    dataset.contacts.forEach((c, id) => {
      if (c.phones.length || c.emails.length)
        K[id] = { m: 1, ph: c.phones, em: c.emails };
    });
  return { K, X: [], I: [] };
}
export function scriptJson(value) {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}
