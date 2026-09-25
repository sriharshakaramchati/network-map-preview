import {searchProfiles, applyEnrichment, removeEnrichment} from "./enrichment.mjs";
import {emailMapId, googleMapSecret, mountGoogleSignIn} from "./account.mjs";
import {downloadContacts} from "./export.mjs";
import {showSampleMap} from "./sample.mjs";
import {
  lockVault,
  unlockVault,
  persistVault,
  listVaults,
  clearVaults,
} from "./vault.mjs";
import { mapData, contactBook, scriptJson } from "./community-data.mjs";
import { newMap, upgradeMap, mergeIntoMap, SOURCES } from "./imports/model.mjs";
import { readCSV, mapCSV, readTextFile } from "./imports/csv.mjs";
import {
  loadGoogleIdentity,
  authorizeGoogle,
  importGoogleContacts,
  assertGoogleAccount,
  importGmail,
  CONTACTS_SCOPE,
  GMAIL_SCOPE,
} from "./imports/google.mjs";
import { startMyGate, pollMyGate, endMyGate, myGateStatus } from "./imports/mygate.mjs";
const $ = (id) => document.getElementById(id);
let records = [],
  current = null,
  selected = "",
  parsed = null,
  batch = null,
  proposal = null,
  operation = null,
  googleAutoEmail = "";
const configPromise = fetch("config.json", { cache: "no-store" })
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}));
const notice = (message) => {
  $("notice").textContent = message;
};
function screen(id) {
  $("demo-section").hidden = id !== "setup";
  for (const n of ["setup", "sources", "import-panel", "review", "map-view", "enrichment"])
    $(n).hidden = n !== id;
  notice("");
}
function fail(error) {
  if (error.name !== "AbortError")
    notice(error.message || "Import could not complete. Please try again.");
}
async function savedMaps() {
  const all = await listVaults();
  $("reset-preview").hidden = !all.length;
  records = all.filter(r=>r.auth?.method!=="google");
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
  googleAutoEmail = "";
  screen("sources");
  $("map-frame").srcdoc = "";
  $("map-summary").textContent =
    `${current.dataset.displayName} · ${current.dataset.contacts.length} people in this map`;
  $("view-map").disabled = !current.dataset.contacts.length;
  $("open-enrichment").disabled = !current.dataset.contacts.length;
}
async function saveState(dataset = current.dataset, pending = current.pending) {
  const value = { kind: "map", dataset, ...(pending ? { pending } : {}) };
  const record = await lockVault(current.id, value, current.password, current.auth);
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
async function enterMap(record,password,id,displayName,auth) {
  const data = record ? await unlockVault(record,password) : {kind:'map',dataset:newMap(id,displayName)};
  if (data.kind !== 'map') throw new Error('Open this older import from the saved maps section.');
  current={id,password,auth,record:record||null,dataset:upgradeMap(data.dataset,id),pending:data.pending||null};
  if (!record) await saveState();
  if(current.pending){await selectSource('MYGATE');void resumeMyGate().catch(fail);}
  else if(current.dataset.contacts.length) await showMap(); else sources();
}
$('create-form').onsubmit = async e => {
  e.preventDefault();notice('');$('create').disabled=true;
  try {
    const email=$('owner-email').value.trim().toLowerCase(),id=await emailMapId(email);
    const record=(await listVaults()).find(r=>r.id===id);
    await enterMap(record,$('password').value,id,email.split('@')[0]);
    $('create-form').reset();
  } catch(error){current=null;fail(error);} finally{$('create').disabled=false;}
};
async function prepareGoogleLogin() {
  const button=$('google-login-start');
  button.disabled=true;
  button.textContent='Loading Google sign-in…';
  try {
    await mountGoogleSignIn($('google-login'),await configPromise,async account=>{
      const record=(await listVaults()).find(r=>r.id===account.id);
      const {password,auth}=googleMapSecret(account,record);
      await enterMap(record,password,account.id,account.name,auth);
      if (!current.pending && !current.dataset.imports.some(i => i.source === "GOOGLE")) {
        await selectSource("GOOGLE");
        googleAutoEmail = account.email;
        $("skip-google").hidden = false;
        await $("google-signin").onclick();
      }
    },fail,busy=>{
      $('create').disabled=busy;
      if(busy) notice('Signing in… The free service may take a moment to wake up.');
    });
    button.hidden=true;
  } catch(error) {
    button.disabled=false;
    button.textContent='Retry Google sign-in';
    $('google-login').textContent='Google sign-in is temporarily unavailable. You can use email below.';
  }
}
$('google-login-start').onclick=()=>{ $('google-login').replaceChildren(); void prepareGoogleLogin(); };
void prepareGoogleLogin();
$('export-contacts').onclick=()=>{if(current)downloadContacts(current.dataset.contacts);};
showSampleMap().catch(()=>{$('sample-loading').textContent='The sample could not load. Refresh to try again.';});
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
const signOut = () => { globalThis.google?.accounts?.id?.disableAutoSelect?.(); location.replace("index.html"); };
$("lock").onclick = signOut;
document.querySelectorAll(".lock-map").forEach((b) => (b.onclick = signOut));
$("reset-preview").onclick = async () => {
  if (!confirm("Delete all saved maps and unfinished imports from this preview on this device? This cannot be undone. Your Google Contacts, MyGate account and original demo will not be changed.")) return;
  $("reset-preview").disabled = true;
  try {
    operation?.abort();
    if (current?.pending) await endMyGate(current.pending).catch(() => {});
    await clearVaults();
    current = null; records = []; batch = null; proposal = null; parsed = null;
    $("map-frame").srcdoc = "";
    globalThis.google?.accounts?.id?.disableAutoSelect?.();
    screen("setup");
    await savedMaps();
    notice("Saved preview data cleared. You can start from the beginning.");
  } catch (error) { fail(error); }
  finally { $("reset-preview").disabled = false; }
};
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
    '<p>Import your community into your own private map.</p><p>Your map is encrypted on this device. It is not published or shared with other users.</p><p class="fine">Reclaim handles your MyGate sign-in. Our service briefly checks the proof to build your map, then returns an encrypted result. We do not log your contacts or proof contents. <a href="https://blog.reclaimprotocol.org/posts/security-faq" target="_blank" rel="noopener noreferrer">How Reclaim protects your data ↗</a></p>',
  TELEGRAM:
    '<p>Use Telegram Desktop’s built-in export. No Telegram login or bot is needed here.</p><ol><li>In Telegram Desktop, open Settings → Advanced → Export Telegram data, or open a chat’s menu → Export chat history.</li><li>Choose machine-readable <strong>JSON</strong> and leave media unchecked. Include contacts and personal chats if available.</li><li>Upload <strong>result.json</strong> below. Names and sender IDs form contacts; message text, media, bots, groups and channels are excluded.</li></ol><p><a href="https://telegram.org/blog/export-and-more" target="_blank" rel="noopener noreferrer">Telegram’s export guide ↗</a></p>',
};
async function selectSource(source) {
  selected = source;
  googleAutoEmail = "";
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
    "skip-google",
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
    $("google-signin").textContent = source === "GOOGLE" ? "Import from Google Contacts" : "Continue with Google";
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
  const unchanged = proposal.added === 0 && proposal.updated === 0;
  $("review-status").textContent = unchanged ? "Already saved" : "Import preview";
  $("review-title").textContent = unchanged ? "Your map is up to date" : "Review your import";
  $("review-summary").textContent = unchanged
    ? `${proposal.unchanged.toLocaleString("en-US")} ${proposal.unchanged === 1 ? "contact" : "contacts"} from ${SOURCES[batch.source]} ${proposal.unchanged === 1 ? "is" : "are"} already in your map. No new contacts or changes were found.`
    : `${SOURCES[batch.source]} · ${[
        proposal.added ? `${proposal.added} new ${proposal.added === 1 ? "contact" : "contacts"}` : "",
        proposal.updated ? `${proposal.updated} updated` : "",
        proposal.unchanged ? `${proposal.unchanged} already saved` : "",
      ].filter(Boolean).join(", ")}.`;
  $("review-preview").hidden = unchanged;
  $("review-help").hidden = unchanged;
  $("save-import").textContent = unchanged ? "View my map" : "Add to my map";
  $("discard-import").textContent = unchanged ? "Back to imports" : "Discard import";
  $("review-detail").textContent = [
    batch.skipped ? `${batch.skipped} records had no name and were skipped.` : "",
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
    const changed = proposal.added > 0 || proposal.updated > 0;
    if (changed || pending) await saveState(changed ? proposal.dataset : current.dataset, null);
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
$("skip-google").onclick = () => { operation?.abort(); googleAutoEmail = ""; sources(); };
$("google-signin").onclick = async () => {
  const autoEmail = googleAutoEmail;
  $("google-signin").disabled = true;
  $("cancel-import").hidden = false;
  $("back-sources").disabled = true;
  const controller = new AbortController();
  operation = controller;
  const signal = controller.signal;
  let access = null;
  try {
    const config = await configPromise; // Already resolved before this button is enabled.
    access = await authorizeGoogle(
      config.googleClientId,
      selected === "GOOGLE" ? CONTACTS_SCOPE + (autoEmail ? " openid email" : "") : GMAIL_SCOPE,
      {loginHint: autoEmail, signal},
    );
    signal.throwIfAborted();
    if (autoEmail) await assertGoogleAccount(access.token, autoEmail, signal);
    signal.throwIfAborted();
    notice("Reading from Google…");
    const importer = selected === "GOOGLE" ? importGoogleContacts : importGmail;
    const result = await importer(access.token, { signal, onProgress: notice });
    signal.throwIfAborted();
    if (autoEmail) {
      const imported = mergeIntoMap(current.dataset, result, current.id);
      await saveState(imported.dataset);
      signal.throwIfAborted();
      googleAutoEmail = "";
      await showMap();
      notice(`Imported ${result.contacts.length} Google contacts into your private map.`);
    } else showReview(result);
  } catch (error) {
    fail(error);
  } finally {
    access = null;
    if (operation === controller) operation = null;
    $("google-signin").disabled = false;
    $("back-sources").disabled = false;
  }
};
async function resumeMyGate() {
  if (operation) return;
  selected = "MYGATE";
  screen("import-panel");
  $("mygate-start").hidden = true;
  $("mygate-wait").hidden = false;
  $("cancel-import").hidden = false;
  $("back-sources").disabled = true;
  $("verify").hidden = true;
  $("verify").removeAttribute("href");
  $("retry-mygate").hidden = true;
  $("restart-mygate").hidden = true;
  $("progress").textContent = "Checking your saved import…";
  const controller = new AbortController();
  operation = controller;
  const signal = controller.signal, pending = current.pending;
  let launchFailed = false;
  try {
    // A completed callback must remain recoverable even after Reclaim expires.
    const status = await myGateStatus(pending, signal);
    signal.throwIfAborted();
    if (status.status === "pending") {
      try {
        let url = pending.verificationUrl;
        if (!url) {
          const { verificationUrl } = await import("./reclaim-launch.mjs");
          url = await verificationUrl(pending.config);
          signal.throwIfAborted();
          // Keep the launch URL in the encrypted vault, alongside the session.
          await saveState(current.dataset, { ...pending, verificationUrl: url });
        }
        signal.throwIfAborted();
        $("verify").href = url;
        $("verify").hidden = false;
      } catch (error) {
        signal.throwIfAborted();
        launchFailed = true;
        $("restart-mygate").hidden = false;
        $("progress").textContent = "This verification link could not reopen. We’re still checking for a completed import. You can also start a new verification.";
      }
    }
    const value = await pollMyGate(pending, signal, (message) => {
      if (!launchFailed || message === "Checking your MyGate proof…")
        $("progress").textContent = message;
    }, status);
    signal.throwIfAborted();
    showReview(value);
  } catch (error) {
    if (signal.aborted) return;
    if (error.code === "SESSION_EXPIRED") {
      $("verify").hidden = true;
      $("progress").textContent = "This verification has expired. Start a new verification to continue.";
      $("restart-mygate").hidden = false;
    } else {
      $("progress").textContent = "We couldn’t check your import. Your saved map is safe. Try checking again.";
      $("retry-mygate").hidden = false;
    }
  } finally {
    if (operation === controller) operation = null;
  }
}
$("retry-mygate").onclick = () => resumeMyGate().catch(fail);
$("restart-mygate").onclick = async () => {
  $("restart-mygate").disabled = true;
  try {
    await cancelImport();
    await selectSource("MYGATE");
    await $("mygate-start").onclick();
  } catch (error) { fail(error); }
  finally { $("restart-mygate").disabled = false; }
};
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

// Public lookups are opt-in and stay separate from automatic contact import.
let enrichmentAbort = null, enrichmentCandidate = null, enrichmentNextSearch = 0;
function resetEnrichmentResults() {
  enrichmentAbort?.abort(); enrichmentAbort = null; enrichmentCandidate = null;
  $("enrichment-submit").disabled = false;
  $("enrichment-results").replaceChildren(); $("enrichment-confirm").hidden = true;
  $("enrichment-status").textContent = "";
}
function chooseEnrichmentContact() {
  resetEnrichmentResults();
  const contact = current.dataset.contacts.find(c=>c.id===$("enrichment-contact").value);
  $("enrichment-query").value = contact?.name || "";
  $("enrichment-submit").disabled = !contact;
  $("enrichment-remove").hidden = !contact?.enrichment;
  $("enrichment-existing").textContent = contact ? `Current details: ${[contact.enrichment?.role || contact.role,contact.enrichment?.company || contact.company].filter(Boolean).join(" · ") || "Role not provided"}` : "No contacts match your search.";
}
function filterEnrichmentContacts() {
  const query = $("enrichment-filter").value.trim().toLocaleLowerCase();
  const matches = current.dataset.contacts.filter(c=>[c.name,c.company,c.role].join(" ").toLocaleLowerCase().includes(query)).slice(0,100);
  $("enrichment-contact").replaceChildren(...matches.map(c=>{
    const option=document.createElement("option");option.value=c.id;
    option.textContent=[c.name,c.company,c.unit,c.block].filter(Boolean).join(" · ");return option;
  }));
  chooseEnrichmentContact();
}
$("open-enrichment").onclick=()=>{ screen("enrichment");$("enrichment-filter").value="";filterEnrichmentContacts(); };
$("enrichment-filter").oninput=filterEnrichmentContacts;
$("enrichment-contact").onchange=chooseEnrichmentContact;
$("enrichment-query").oninput=resetEnrichmentResults;
$("enrichment-source").onchange=resetEnrichmentResults;
$("enrichment-back").onclick=()=>{ resetEnrichmentResults();void showMap().catch(fail); };
$("enrichment-search").onsubmit=async e=>{
  e.preventDefault();resetEnrichmentResults();notice("");
  if(Date.now()<enrichmentNextSearch){$("enrichment-status").textContent="Please wait a few seconds before another search.";return;}
  enrichmentNextSearch=Date.now()+10000;
  const controller=new AbortController();enrichmentAbort=controller;
  $("enrichment-submit").disabled=true;$("enrichment-status").textContent="Searching public profiles…";
  try {
    const candidates=await searchProfiles($("enrichment-query").value,$("enrichment-source").value,{signal:controller.signal});
    if(controller.signal.aborted)return;
    $("enrichment-status").textContent=candidates.length ? `${candidates.length} possible ${candidates.length===1?"match":"matches"}. Check the person before saving.` : "No public matches found. Your contact is unchanged. Try another source or a more complete name.";
    for(const candidate of candidates){
      const article=document.createElement("article");article.className="profile-candidate";
      const title=document.createElement("h2");title.textContent=candidate.name;
      const description=document.createElement("p");description.textContent=candidate.description || "No public description provided.";
      const detail=document.createElement("p");detail.className="fine";detail.textContent=[candidate.source,candidate.role,candidate.company].filter(Boolean).join(" · ");
      const button=document.createElement("button");button.className="secondary";button.type="button";button.textContent="Review this match";
      button.onclick=()=>{
        enrichmentCandidate=candidate;$("enrichment-confirm").hidden=false;
        $("enrichment-evidence").textContent=`${candidate.name} · ${candidate.source}: ${candidate.description || "No description"}. ${candidate.source==='GitHub'?'GitHub has no occupation field. Only enter a profession explicitly supported by this bio or profile.':'Occupation and employer are public Wikidata statements; check that they are current.'}`;
        $("enrichment-link").href=candidate.url;$("enrichment-role").value=candidate.role;$("enrichment-company").value=candidate.company;$("enrichment-identity").checked=false;
        $("enrichment-confirm").scrollIntoView({block:"start"});
      };
      article.append(title,description,detail,button);$("enrichment-results").append(article);
    }
  }catch(error){if(!controller.signal.aborted)$("enrichment-status").textContent=error.name==='TimeoutError'?"The public source took too long. Please try later.":error.message;}
  finally{if(enrichmentAbort===controller){enrichmentAbort=null;$("enrichment-submit").disabled=false;}}
};
$("enrichment-confirm").onsubmit=async e=>{
  e.preventDefault();const button=e.target.querySelector("button");button.disabled=true;
  try{
    if(!enrichmentCandidate)throw new Error("Choose a public profile first.");
    const dataset=applyEnrichment(current.dataset,current.id,$("enrichment-contact").value,enrichmentCandidate,{role:$("enrichment-role").value,company:$("enrichment-company").value,confirmed:$("enrichment-identity").checked});
    await saveState(dataset);resetEnrichmentResults();await showMap();
  }catch(error){fail(error);}finally{button.disabled=false;}
};
$("enrichment-remove").onclick=async()=>{
  $("enrichment-remove").disabled=true;
  try{await saveState(removeEnrichment(current.dataset,current.id,$("enrichment-contact").value));chooseEnrichmentContact();notice("Added profile details removed. Original imported details restored.");}
  catch(error){fail(error);}finally{$("enrichment-remove").disabled=false;}
};
