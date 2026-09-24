import {
  lockVault,
  unlockVault,
  persistVault,
  listVaults,
  removeVault,
} from "./vault.mjs";
import { mapData, contactBook, scriptJson } from "./community-data.mjs";
import { newMap, upgradeMap, mergeIntoMap, SOURCES } from "./imports/model.mjs";
import { readCSV, mapCSV, readTextFile } from "./imports/csv.mjs";
import {
  loadGoogleIdentity,
  authorizeGoogle,
  importGoogleContacts,
  importGmail,
  CONTACTS_SCOPE,
  GMAIL_SCOPE,
} from "./imports/google.mjs";
import { startMyGate, pollMyGate, endMyGate } from "./imports/mygate.mjs";
const $ = (id) => document.getElementById(id);
let records = [],
  current = null,
  selected = "",
  parsed = null,
  batch = null,
  proposal = null,
  operation = null;
const configPromise = fetch("config.json", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}));
const notice = (message) => {
  $("notice").textContent = message;
};
function screen(id) {
  for (const n of ["setup", "sources", "import-panel", "review", "map-view"])
    $(n).hidden = n !== id;
  notice("");
}
function fail(error) {
  if (error.name !== "AbortError")
    notice(error.message || "Import could not complete. Please try again.");
}
async function savedMaps() {
  records = await listVaults();
  $("saved").hidden = !records.length;
  $("map-choice").replaceChildren(
    ...records.map((r, i) => {
      const o = document.createElement("option");
      o.value = r.id;
      o.textContent = `Private map ${i + 1} · ${r.id.slice(-8)}`;
      return o;
    }),
  );
}
function sources() {
  selected = "";
  screen("sources");
  $("map-frame").srcdoc = "";
  $("map-summary").textContent =
    `${current.dataset.displayName} · ${current.dataset.contacts.length} people in this map`;
  $("view-map").disabled = !current.dataset.contacts.length;
}
async function saveState(dataset = current.dataset, pending = current.pending) {
  const value = { kind: "map", dataset, ...(pending ? { pending } : {}) };
  const record = await lockVault(current.id, value, current.password);
  await persistVault(record, current.record?.ciphertext ?? null);
  current.record = record;
  current.dataset = dataset;
  current.pending = pending;
}
async function showMap() {
  const response = await fetch("assets/community-renderer.html");
  if (!response.ok)
    throw new Error(
      "The renderer could not load. Your encrypted map is still saved.",
    );
  $("map-frame").srcdoc = (await response.text())
    .replace("__COMMUNITY_DATA__", () => scriptJson(mapData(current.dataset)))
    .replace("__COMMUNITY_OWNER__", () =>
      scriptJson(current.dataset.displayName),
    )
    .replace("__COMMUNITY_CONTACTS__", () =>
      scriptJson(contactBook(current.dataset)),
    );
  screen("map-view");
}
$("create-form").onsubmit = async (e) => {
  e.preventDefault();
  notice("");
  const password = $("password").value;
  if (password !== $("confirm").value)
    return notice("The passwords do not match.");
  $("create").disabled = true;
  try {
    const id = crypto.randomUUID();
    current = {
      id,
      password,
      dataset: newMap(id, $("owner-name").value),
      record: null,
      pending: null,
    };
    await saveState();
    $("create-form").reset();
    sources();
  } catch (error) {
    current = null;
    fail(error);
  } finally {
    $("create").disabled = false;
  }
};
$("unlock-form").onsubmit = async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button");
  button.disabled = true;
  const password = $("unlock-password").value;
  $("unlock-password").value = "";
  notice("");
  try {
    const record = records.find((r) => r.id === $("map-choice").value),
      data = await unlockVault(record, password);
    if (data.kind !== "map")
      throw new Error(
        "Complete this older pending MyGate import in the previous preview.",
      );
    current = {
      id: record.id,
      password,
      record,
      dataset: upgradeMap(data.dataset, record.id),
      pending: data.pending || null,
    };
    if (current.pending) {
      await selectSource("MYGATE");
      await resumeMyGate();
    } else if (current.dataset.contacts.length) await showMap();
    else sources();
  } catch (error) {
    fail(error);
  } finally {
    button.disabled = false;
  }
};
const lock = () => location.replace("community.html");
$("lock").onclick = lock;
document.querySelectorAll(".lock-map").forEach((b) => (b.onclick = lock));
$("view-map").onclick = () => showMap().catch(fail);
$("add-contacts").onclick = sources;
const guides = {
  CSV: "<p>Upload any CSV with a name column, or separate first and last names. You choose the column mapping before anything is saved.</p>",
  LINKEDIN:
    '<p>Use LinkedIn’s official export. We do not scrape LinkedIn or use third-party data providers.</p><ol><li>Open LinkedIn Settings &amp; Privacy → Data privacy → Get a copy of your data.</li><li>Request the archive containing your connections. When LinkedIn makes it available, download and unzip it.</li><li>Choose <strong>Connections.csv</strong> below. Some connections may not share an email address.</li></ol><p><a href="https://www.linkedin.com/mypreferences/d/download-my-data" target="_blank" rel="noopener noreferrer">Open LinkedIn export settings ↗</a> · <a href="https://www.linkedin.com/help/linkedin/answer/a566336" target="_blank" rel="noopener noreferrer">Official export help</a></p>',
  GOOGLE:
    '<p>Sign in to Google and allow read-only access to your contacts. Names, email addresses, phone numbers and companies are imported directly into this browser.</p><p class="fine">No manual export is needed. Your Google token is used only for this import and is never saved.</p>',
  GMAIL:
    '<p>Find the people you actually email. We examine address headers from up to 500 sent and 500 inbox messages, then rank correspondents by frequency and recency.</p><p class="fine">We do not read message bodies, subjects or attachments. Obvious automated mail and mailing lists are skipped. This is a sample, not your entire history. You review the people before saving.</p>',
  MYGATE:
    '<p>Verify your own MyGate account with Reclaim. Only a cryptographically valid MyGate proof can add residents to this map.</p><p class="fine">The callback processes the proof in memory and returns an encrypted directory to this browser.</p>',
  TELEGRAM:
    '<p>Use Telegram Desktop’s built-in export. No Telegram login or bot is needed here.</p><ol><li>In Telegram Desktop, open Settings → Advanced → Export Telegram data, or open a chat’s menu → Export chat history.</li><li>Choose machine-readable <strong>JSON</strong> and leave media unchecked. Include contacts and personal chats if available.</li><li>Upload <strong>result.json</strong> below. Names and sender IDs form contacts; message text, media, bots, groups and channels are excluded.</li></ol><p><a href="https://telegram.org/blog/export-and-more" target="_blank" rel="noopener noreferrer">Telegram’s export guide ↗</a></p>',
};
async function selectSource(source) {
  selected = source;
  parsed = null;
  batch = null;
  proposal = null;
  screen("import-panel");
  $("source-title").textContent = SOURCES[source];
  $("source-guide").innerHTML = guides[source];
  for (const id of [
    "file-controls",
    "mapping-form",
    "google-signin",
    "mygate-start",
    "mygate-wait",
    "cancel-import",
  ])
    $(id).hidden = true;
  $("import-file").value = "";
  $("back-sources").disabled = false;
  if (["CSV", "LINKEDIN", "TELEGRAM"].includes(source)) {
    $("file-controls").hidden = false;
    $("import-file").accept =
      source === "TELEGRAM" ? ".json,application/json" : ".csv,text/csv";
  }
  if (["GOOGLE", "GMAIL"].includes(source)) {
    $("google-signin").hidden = false;
    $("google-signin").disabled = true;
    $("google-signin").textContent = "Preparing Google sign-in…";
    const config = await configPromise;
    if (!config.googleClientId) {
      $("google-signin").textContent = "Google sign-in awaits setup";
      notice(
        "The preview owner needs to connect a Google OAuth client before sign-in can work.",
      );
      return;
    }
    await loadGoogleIdentity();
    if (selected !== source) return;
    $("google-signin").textContent = "Continue with Google";
    $("google-signin").disabled = false;
  }
  if (source === "MYGATE") {
    $("mygate-start").hidden = false;
    if (!(await configPromise).callbackOrigin) {
      $("mygate-start").disabled = true;
      notice(
        "MyGate verification awaits the approved callback host and Reclaim app credentials.",
      );
    } else $("mygate-start").disabled = false;
  }
}
document
  .querySelectorAll("[data-source]")
  .forEach(
    (button) =>
      (button.onclick = () => selectSource(button.dataset.source).catch(fail)),
  );
$("back-sources").onclick = () => {
  batch = null;
  parsed = null;
  sources();
};
function mappingUI() {
  const fields = [
    ["name", "Full name"],
    ["first", "First name"],
    ["middle", "Middle name"],
    ["last", "Last name"],
    ["emails", "Email columns"],
    ["phones", "Phone columns"],
    ["company", "Company"],
    ["role", "Role / position"],
    ["unit", "Unit / flat"],
    ["block", "Block / building"],
    ["profile", "LinkedIn profile URL"],
  ];
  $("mapping-fields").replaceChildren(
    ...fields.map(([key, title]) => {
      const label = document.createElement("label");
      label.textContent = title;
      const select = document.createElement("select");
      select.name = key;
      select.dataset.field = key;
      select.multiple = ["emails", "phones"].includes(key);
      if (!select.multiple) {
        const o = document.createElement("option");
        o.value = "-1";
        o.textContent = "Do not import";
        select.append(o);
      }
      parsed.headers.forEach((header, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = `${header || "Untitled column"} (${i + 1})`;
        o.selected = select.multiple
          ? parsed.mapping[key].includes(i)
          : parsed.mapping[key] === i;
        select.append(o);
      });
      if (!select.multiple) select.value = String(parsed.mapping[key]);
      label.append(select);
      return label;
    }),
  );
  $("mapping-form").hidden = false;
}
$("import-file").onchange = async () => {
  try {
    const file = $("import-file").files[0];
    if (!file) return;
    notice("Reading your file locally…");
    const input = await readTextFile(file);
    if (selected === "TELEGRAM") {
      const { importTelegram } = await import("./imports/telegram.mjs");
      showReview(importTelegram(input));
    } else {
      parsed = readCSV(input);
      mappingUI();
      notice(`${parsed.rows.length} rows found. Check the column mapping.`);
    }
  } catch (error) {
    fail(error);
  } finally {
    $("import-file").value = "";
  }
};
$("mapping-form").onsubmit = (e) => {
  e.preventDefault();
  try {
    const mapping = {};
    for (const s of document.querySelectorAll("[data-field]"))
      mapping[s.dataset.field] = s.multiple
        ? [...s.selectedOptions].map((o) => Number(o.value))
        : Number(s.value);
    showReview(mapCSV(parsed, mapping, selected));
  } catch (error) {
    fail(error);
  }
};
function showReview(value) {
  batch = value;
  proposal = mergeIntoMap(current.dataset, batch, current.id);
  screen("review");
  $("review-summary").textContent =
    `${SOURCES[batch.source]} · ${proposal.added} new people, ${proposal.updated} updated, ${proposal.unchanged} already in your map.`;
  $("review-detail").textContent = [
    batch.skipped ? `${batch.skipped} unnamed records skipped.` : "",
    proposal.ambiguous
      ? `${proposal.ambiguous} ambiguous matches kept separate.`
      : "",
    batch.source === "GMAIL"
      ? `Ranked from ${batch.sampled || 0} sampled messages. ${batch.limited ? "More mail exists beyond this sample." : ""}`
      : "",
  ]
    .filter(Boolean)
    .join(" ");
  $("preview-rows").replaceChildren(
    ...batch.contacts.slice(0, 8).map((c) => {
      const row = document.createElement("tr");
      for (const value of [
        c.name,
        c.emails[0] || c.phones[0] || "No contact detail",
        [c.company, c.unit, c.block].filter(Boolean).join(" · ") || "—",
      ]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        row.append(cell);
      }
      return row;
    }),
  );
  $("save-import").disabled = false;
}
$("save-import").onclick = async () => {
  $("save-import").disabled = true;
  try {
    const pending = current.pending;
    await saveState(proposal.dataset, null);
    if (pending) await endMyGate(pending).catch(() => {});
    batch = null;
    proposal = null;
    parsed = null;
    await showMap();
  } catch (error) {
    fail(error);
  } finally {
    $("save-import").disabled = false;
  }
};
async function cancelImport() {
  operation?.abort();
  operation = null;
  const pending = current.pending;
  if (pending) {
    await saveState(current.dataset, null);
    await endMyGate(pending).catch(() => {});
  }
  batch = null;
  proposal = null;
  parsed = null;
  sources();
}
$("discard-import").onclick = () => cancelImport().catch(fail);
$("cancel-import").onclick = () => cancelImport().catch(fail);
$("google-signin").onclick = async () => {
  $("google-signin").disabled = true;
  $("cancel-import").hidden = false;
  $("back-sources").disabled = true;
  operation = new AbortController();
  const signal = operation.signal;
  let access = null;
  try {
    const config = await configPromise; // Already resolved before this button is enabled.
    access = await authorizeGoogle(
      config.googleClientId,
      selected === "GOOGLE" ? CONTACTS_SCOPE : GMAIL_SCOPE,
    );
    signal.throwIfAborted();
    notice("Reading from Google…");
    const importer = selected === "GOOGLE" ? importGoogleContacts : importGmail;
    const result = await importer(access.token, { signal, onProgress: notice });
    signal.throwIfAborted();
    showReview(result);
  } catch (error) {
    fail(error);
  } finally {
    access = null;
    operation = null;
    $("google-signin").disabled = false;
    $("back-sources").disabled = false;
  }
};
async function resumeMyGate() {
  selected = "MYGATE";
  screen("import-panel");
  $("mygate-start").hidden = true;
  $("mygate-wait").hidden = false;
  $("cancel-import").hidden = false;
  $("back-sources").disabled = true;
  operation = new AbortController();
  const signal = operation.signal;
  const { verificationUrl } = await import("./reclaim-launch.mjs");
  $("verify").href = await verificationUrl(current.pending.config);
  try {
    const value = await pollMyGate(current.pending, signal, (message) => {
      $("progress").textContent = message;
    });
    signal.throwIfAborted();
    showReview(value);
  } finally {
    operation = null;
  }
}
$("mygate-start").onclick = async () => {
  $("mygate-start").disabled = true;
  $("back-sources").disabled = true;
  try {
    const config = await configPromise;
    const pending = await startMyGate(config.callbackOrigin);
    try {
      await saveState(current.dataset, pending);
    } catch (error) {
      await endMyGate(pending).catch(() => {});
      throw error;
    }
    await resumeMyGate();
  } catch (error) {
    fail(error);
  } finally {
    $("mygate-start").disabled = false;
    if (!current.pending) $("back-sources").disabled = false;
  }
};
savedMaps().catch(fail);
