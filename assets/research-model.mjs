// Local evidence matching. Search snippets are untrusted data, never instructions.
const text = (v, max = 500) =>
  typeof v === "string"
    ? v
        .replace(/<[^>]*>/g, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&quot;/gi, '"')
        .replace(/[\u0000-\u001f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";
const norm = (v) =>
  text(v)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const tokens = (v) => norm(v).split(" ").filter(Boolean);
const has = (haystack, needle) =>
  !!norm(needle) &&
  (" " + norm(haystack) + " ").includes(" " + norm(needle) + " ");
const rolePattern =
  /\b(?:(?:co[- ]?)?founder|chief (?:executive|technology|financial|operating|medical|product|marketing|information|revenue|scientific) officer|(?:ceo|cto|cfo|coo|cmo|cio|svp|evp|vp)|(?:senior |executive |managing |associate |assistant )?(?:vice president|director|professor|consultant|engineer|scientist|manager|partner)|cardiologist|cardiac surgeon|neurosurgeon|neurologist|oncologist|orthop(?:a|e)edic surgeon|pediatrician|paediatrician|dermatologist|dentist|physician|doctor|surgeon|architect|lawyer|advocate|chartered accountant|researcher|investor|entrepreneur|product designer|software developer|government officer)\b/i;
export function professionCategory(role) {
  if (
    /doctor|physician|surgeon|cardiolog|neuro|oncolog|dentist|pediatric|paediatric|dermatolog|medical/i.test(
      role,
    )
  )
    return "Doctors & healthcare";
  if (/founder|chief|\bceo\b|\bcto\b|\bcfo\b|\bcoo\b|entrepreneur/i.test(role))
    return "Founders & executives";
  if (/professor|scientist|researcher/i.test(role))
    return "Academics & researchers";
  if (/investor|partner/i.test(role)) return "Investors & partners";
  if (/president|director|manager|\b[se]?vp\b/i.test(role)) return "Leadership";
  if (/engineer|developer|architect|designer/i.test(role))
    return "Technology & design";
  if (/lawyer|advocate|accountant/i.test(role)) return "Professional services";
  if (/government/i.test(role)) return "Government";
  return "Other professions";
}
export function researchInput(contact, settings = {}) {
  const parts = text(contact.name, 160).split(/\s+[-–—|]\s+|-(?=iiit\b)/i);
  const name = text(
    parts.shift().replace(/^(?:dr\.?|mr\.?|mrs\.?|ms\.?)\s+/i, ""),
    100,
  );
  const label = parts.join(" ");
  const university = text(
    contact.university ||
      (/\biiit\b/i.test(label) ? "IIIT Hyderabad" : settings.university),
    100,
  );
  const company = text(
    contact.company ||
      (label &&
      !/iiit|friend|family|uncle|aunt|junior|senior|jnr|snr|school|college/i.test(
        label,
      )
        ? label
        : ""),
    100,
  );
  return {
    name,
    city: text(contact.city || settings.city, 100),
    community: text(settings.community, 100),
    company,
    university,
  };
}
export function researchKey(input) {
  return JSON.stringify(input);
}
export function researchEligible(input) {
  return (
    !/@|https?:|\d{5}/i.test(Object.values(input).join(" ")) &&
    (tokens(input.name).length >= 2 ||
      (tokens(input.name).length === 1 &&
        !!(input.company || input.university || input.community)))
  );
}
export function safeSourceURL(value) {
  try {
    const u = new URL(value);
    if (
      !["https:", "http:"].includes(u.protocol) ||
      u.username ||
      u.password ||
      !u.hostname.includes(".") ||
      /^(?:localhost|\d+\.\d+\.\d+\.\d+$|\[)/.test(u.hostname) ||
      u.hostname.endsWith(".local")
    )
      return "";
    return u.href;
  } catch {
    return "";
  }
}
function extractProfession(title, content, name, titleName) {
  const stripped = title
    .replace(/\s*[|–—-]\s*LinkedIn.*$/i, "")
    .replace(/\s*\|\s*Practo.*$/i, "");
  // A title is usable only when it names this person. In body snippets accept a
  // direct name→role statement, never a different person's role on the same page.
  let passage = titleName ? stripped : "";
  let rolePart = "";
  const segments = passage.split(/\s+[-–—|]\s+/);
  const namedIndex = segments.findIndex((s) =>
    tokens(name).every((t) => has(s, t)),
  );
  if (
    namedIndex >= 0 &&
    segments[namedIndex + 1] &&
    rolePattern.test(segments[namedIndex + 1])
  )
    rolePart = segments.slice(namedIndex + 1).join(" - ");
  if (!rolePart) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const direct = new RegExp(
      "(?:Dr\\.?\\s+)?" +
        escaped +
        "(?:\\s*,\\s*|\\s+(?:(?:is|works|serves)\\s+(?:an?\\s+|as\\s+(?:an?\\s+)?)?|[-–—]\\s*))(.+)",
      "i",
    );
    for (const sentence of [passage, ...content.split(/(?<=[.!?])\s+|\n/)]) {
      const matched = sentence.match(direct);
      if (!matched) continue;
      const fact = rolePattern.exec(matched[1]);
      // Only short professional qualifiers may precede a role; reject statements
      // such as "works with cardiologist ..." or unrelated biography paragraphs.
      if (
        fact &&
        /^(?:(?:senior|junior|principal|staff|lead|software|data|cloud|technical|technology|product|sales|marketing|engineering|business|general|independent|retired|former|consulting|interventional|pediatric|paediatric|medical|executive|associate|assistant|managing)\s+)*$/i.test(
          matched[1].slice(0, fact.index),
        )
      ) {
        passage = sentence;
        rolePart = matched[1];
        break;
      }
    }
  }
  if (!rolePart || !rolePattern.test(rolePart)) return null;
  let role = rolePart
      .split(/[|•\n]/)[0]
      .trim()
      .slice(0, 220),
    company = "";
  const split = role.match(
    /^(.{2,100}?)\s+(?:at|@)\s+(.{2,100}?)(?:\s+[|–—]|[.!](?:\s|$)|$)/i,
  );
  if (split) {
    role = split[1];
    company = split[2];
  } else {
    const pieces = role.split(/\s+[-–—]\s+/);
    if (pieces.length > 1) {
      role = pieces[0];
      company = pieces[1];
    }
  }
  role = role.replace(/\s*[.!].*$/, "").trim();
  return { role, company, evidence: passage.slice(0, 700) };
}
export function matchResearch(input, results) {
  const full = tokens(input.name),
    candidates = [];
  for (const raw of (results || []).slice(0, 6)) {
    const url = safeSourceURL(raw.url),
      title = text(raw.title, 400),
      content = text(raw.content, 2400);
    if (!url || full.length === 0) continue;
    const titleName = full.every((t) => has(title, t)),
      bodyName = full.every((t) => has(content, t));
    if (!titleName && !bodyName) continue;
    const fact = extractProfession(title, content, input.name, titleName);
    if (!fact) continue;
    const proof = title + " " + content;
    const matched = ["company", "university", "city", "community"].filter(
      (k) => input[k] && has(proof, input[k]),
    );
    const score =
      (titleName ? 40 : 20) +
      (/(^|\.)linkedin\.com$/.test(new URL(url).hostname) ? 4 : 0) +
      matched.reduce(
        (s, k) => s + (["company", "university"].includes(k) ? 20 : 6),
        0,
      );
    candidates.push({
      ...fact,
      url,
      title,
      matched,
      score,
      category: professionCategory(fact.role),
      confidence:
        full.length > 1 &&
        titleName &&
        matched.some((k) => ["company", "university"].includes(k))
          ? "Strong"
          : "Possible",
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  const unique = candidates
    .filter((c, i) => candidates.findIndex((x) => x.url === c.url) === i)
    .slice(0, 4);
  const top = unique[0],
    rival = unique[1];
  const ambiguous = !!(
    top &&
    rival &&
    top.score - rival.score < 15 &&
    norm(top.role) !== norm(rival.role) &&
    (!top.company ||
      !rival.company ||
      norm(top.company) !== norm(rival.company))
  );
  if (ambiguous) unique.forEach((c) => (c.confidence = "Possible"));
  return {
    status: unique.length ? "found" : "not-found",
    candidates: unique,
    ambiguous,
    selected: unique.length ? 0 : null,
    checkedAt: new Date().toISOString(),
    input,
  };
}
export function professionalDetails(c) {
  if (c.enrichment)
    return {
      role: c.enrichment.role || c.role,
      company: c.enrichment.company || c.company,
      url: c.enrichment.url,
      confidence: "Confirmed by you",
      category: professionCategory(c.enrichment.role),
      evidence: c.enrichment.description || "",
      source: c.enrichment.source,
    };
  const r = c.research,
    p = r?.candidates?.[r.selected];
  if (p && r.status === "found")
    return {
      role: p.role,
      company: p.company || c.company,
      url: p.url,
      confidence: r.confirmedAt ? "Confirmed by you" : p.confidence,
      category: p.category,
      evidence: p.evidence,
      source: "Public web",
      ambiguous: r.ambiguous,
    };
  return {
    role: c.role || "",
    company: c.company || "",
    url: c.profile || "",
    confidence: "Imported details",
    category: c.role ? professionCategory(c.role) : "",
    evidence: "",
    source: "",
  };
}
export function applyResearch(dataset, ownerId, id, result) {
  if (dataset.ownerId !== ownerId)
    throw new Error("This research belongs to another private map.");
  if (!dataset.contacts.some((c) => c.id === id))
    throw new Error("This contact no longer exists.");
  return {
    ...dataset,
    contacts: dataset.contacts.map((c) =>
      c.id === id ? { ...c, research: result } : c,
    ),
  };
}
