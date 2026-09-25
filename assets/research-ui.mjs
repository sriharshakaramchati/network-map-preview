import { createIdentity, openHandoff } from "./vault.mjs";
import {
  researchInput,
  researchKey,
  researchEligible,
  matchResearch,
  applyResearch,
  professionalDetails,
} from "./research-model.mjs";
const messages = {
  RESEARCH_NOT_CONFIGURED:
    "Web research is awaiting the owner’s free search account setup. Your contacts are saved.",
  FREE_PLAN_REQUIRED:
    "Research is paused because a free-only search account could not be verified. No paid search was made.",
  RESEARCH_LIMIT:
    "The free search allowance is used up. Progress is saved; resume after the monthly allowance resets.",
  RESEARCH_BUSY:
    "The research service is busy. Progress is saved; try Resume shortly.",
  RESEARCH_UNAVAILABLE:
    "The search service is temporarily unavailable. Progress is saved.",
  RESEARCH_SESSION_EXPIRED:
    "The research session expired. Resume to reconnect.",
};
export function mountResearch({
  $,
  current,
  save,
  showMap,
  screen,
  notice,
  config,
}) {
  let running = false,
    controller = null;
  const dataset = () => current()?.dataset;
  const settings = () => dataset()?.researchSettings || {};
  const work = (c) =>
    !c.enrichment &&
    (!c.research ||
      researchKey(c.research.input) !==
        researchKey(researchInput(c, settings())));
  async function request(path, { token, body, signal, attempt = 0 } = {}) {
    const cfg = await config;
    if (!cfg.callbackOrigin) throw new Error(messages.RESEARCH_NOT_CONFIGURED);
    let response;
    try {
      response = await fetch(cfg.callbackOrigin + path, {
        method: body ? "POST" : "GET",
        body: body ? JSON.stringify(body) : undefined,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: "Bearer " + token } : {}),
        },
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: signal || AbortSignal.timeout(65000),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error("Could not reach web research. Your progress is saved.");
    }
    if (!response.ok) {
      const b = await response.json().catch(() => ({}));
      if (b.error === "RESEARCH_BUSY" && attempt < 3) {
        await wait(1200 * (attempt + 1), signal);
        signal?.throwIfAborted();
        return request(path, { token, body, signal, attempt: attempt + 1 });
      }
      throw Object.assign(
        new Error(
          messages[b.error] ||
            "Research could not complete. Your progress is saved.",
        ),
        { code: b.error },
      );
    }
    return response.json();
  }
  const wait = (ms, signal) =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      if (signal?.aborted) done();
    });
  function render() {
    const contacts = dataset()?.contacts || [];
    const found = contacts.filter((c) => c.research?.status === "found").length,
      reviewCount = contacts.filter(
        (c) =>
          c.research?.status === "found" &&
          !c.research.confirmedAt &&
          (c.research.ambiguous ||
            c.research.candidates[0]?.confidence === "Possible"),
      ).length;
    const remaining = contacts.filter(work).length;
    $("research-summary").textContent =
      `${found} with public matches · ${reviewCount} need review · ${remaining} left to research · ${contacts.filter((c) => c.research?.status === "not-found").length} without a match`;
    $("research-run").disabled = running || !contacts.length;
    $("research-run").textContent = running
      ? "Researching…"
      : settings().enabled
        ? "Resume research"
        : "Start automatic research";
    $("research-pause").hidden = !running;
    $("research-view-map").disabled = false;
    const filter = $("research-filter").value.toLowerCase(),
      status = $("research-status-filter").value;
    const visible = contacts
      .filter((c) => {
        const d = professionalDetails(c);
        return (
          (!filter ||
            [c.name, d.role, d.company, c.block, c.unit]
              .join(" ")
              .toLowerCase()
              .includes(filter)) &&
          (status !== "review" ||
            (c.research?.status === "found" &&
              !c.research.confirmedAt &&
              (c.research.ambiguous || d.confidence === "Possible")))
        );
      })
      .slice(0, 80);
    $("research-rows").replaceChildren(
      ...visible.map((c) => {
        const d = professionalDetails(c),
          row = document.createElement("tr");
        for (const value of [
          c.name,
          [c.unit, c.block].filter(Boolean).join(" · ") || "—",
          [d.role, d.company].filter(Boolean).join(" · ") || "Not found yet",
          c.research?.status === "insufficient-context"
            ? "Needs more context"
            : c.research?.status === "not-found"
              ? "No public match"
              : d.confidence,
        ]) {
          const td = document.createElement("td");
          td.textContent = value;
          row.append(td);
        }
        const action = document.createElement("td");
        if (d.url) {
          const a = document.createElement("a");
          a.href = d.url;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = "Source ↗";
          action.append(a);
        }
        if (c.research?.candidates?.length) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "secondary";
          b.textContent = "Review";
          b.disabled = running;
          b.onclick = () => review(c);
          action.append(b);
        }
        row.append(action);
        return row;
      }),
    );
  }
  function review(contact) {
    const box = $("research-review");
    box.replaceChildren();
    box.hidden = false;
    const h = document.createElement("h2");
    h.textContent = `Review ${contact.name}`;
    box.append(h);
    const explain = document.createElement("p");
    explain.textContent =
      "These are possible professional matches, not proof that the profile belongs to this resident. Choose the person you recognise or reject the matches.";
    box.append(explain);
    contact.research.candidates.forEach((candidate, index) => {
      const section = document.createElement("article");
      section.className = "profile-candidate";
      const title = document.createElement("h3");
      title.textContent = [candidate.role, candidate.company]
        .filter(Boolean)
        .join(" · ");
      const evidence = document.createElement("p");
      evidence.textContent = candidate.evidence;
      const context = document.createElement("p");
      context.className = "fine";
      context.textContent = `${candidate.confidence} · matched context: ${candidate.matched.join(", ") || "name only"} · checked ${contact.research.checkedAt.slice(0, 10)}`;
      const a = document.createElement("a");
      a.href = candidate.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "Read evidence ↗";
      const b = document.createElement("button");
      b.type = "button";
      b.className = "secondary";
      b.textContent = "This is my contact";
      b.onclick = async () => {
        b.disabled = true;
        try {
          await save(
            applyResearch(dataset(), current().id, contact.id, {
              ...contact.research,
              selected: index,
              confirmedAt: new Date().toISOString(),
              ambiguous: false,
            }),
          );
          box.hidden = true;
          render();
        } catch (e) {
          notice(e.message);
        } finally {
          b.disabled = false;
        }
      };
      section.append(title, evidence, context, a, b);
      box.append(section);
    });
    const reject = document.createElement("button");
    reject.type = "button";
    reject.className = "secondary";
    reject.textContent = "None of these people";
    reject.onclick = async () => {
      reject.disabled = true;
      try {
        await save(
          applyResearch(dataset(), current().id, contact.id, {
            ...contact.research,
            status: "rejected",
            selected: null,
            confirmedAt: null,
          }),
        );
        box.hidden = true;
        render();
      } catch (e) {
        notice(e.message);
      } finally {
        reject.disabled = false;
      }
    };
    box.append(reject);
    box.scrollIntoView({ block: "start" });
  }
  function show() {
    screen("research");
    $("research-city").value = settings().city || "";
    $("research-community").value = settings().community || "";
    $("research-university").value = settings().university || "";
    $("research-consent").checked = !!settings().enabled;
    $("research-review").hidden = true;
    render();
  }
  async function session(signal) {
    const existing = dataset().researchSession;
    if (existing?.expiresAt > Date.now() + 60000) return existing;
    const keys = await createIdentity();
    signal.throwIfAborted();
    const created = await request("/v1/research/sessions", {
      body: { publicKey: keys.publicKey },
      signal,
    });
    signal.throwIfAborted();
    const state = { ...created, ...keys };
    await save({ ...dataset(), researchSession: state });
    return state;
  }
  async function run() {
    if (
      running ||
      !settings().enabled ||
      settings().paused ||
      !dataset()?.contacts.some(work)
    )
      return;
    running = true;
    controller = new AbortController();
    const signal = controller.signal,
      owner = current().id;
    show();
    $("research-review").hidden = true;
    $("research-progress").textContent = "Connecting to free web research…";
    try {
      let transport = await session(signal);
      for (const id of dataset()
        .contacts.filter(work)
        .map((c) => c.id)) {
        signal.throwIfAborted();
        if (current()?.id !== owner) throw new Error("The active map changed.");
        const c = dataset().contacts.find((c) => c.id === id),
          input = researchInput(c, settings());
        if (!researchEligible(input)) {
          await save(
            applyResearch(dataset(), owner, id, {
              status: "insufficient-context",
              input,
              candidates: [],
              selected: null,
              checkedAt: new Date().toISOString(),
            }),
          );
          render();
          continue;
        }
        const key = researchKey(input),
          requestId =
            c.researchWork?.key === key
              ? c.researchWork.requestId
              : crypto.randomUUID();
        if (c.researchWork?.requestId !== requestId)
          await save({
            ...dataset(),
            contacts: dataset().contacts.map((x) =>
              x.id === id ? { ...x, researchWork: { key, requestId } } : x,
            ),
          });
        $("research-progress").textContent = `Researching ${c.name}…`;
        let envelope;
        try {
          envelope = await request("/v1/research/sessions/" + transport.id, {
            token: transport.token,
            body: { requestId, input },
            signal,
          });
        } catch (error) {
          if (error.code !== "RESEARCH_SESSION_EXPIRED") throw error;
          await save({ ...dataset(), researchSession: null });
          transport = await session(signal);
          envelope = await request("/v1/research/sessions/" + transport.id, {
            token: transport.token,
            body: { requestId, input },
            signal,
          });
        }
        signal.throwIfAborted();
        const evidence = await openHandoff(
          envelope,
          transport.privateKey,
          `${transport.id}:${requestId}`,
        );
        if (evidence.kind !== "research" || evidence.requestId !== requestId)
          throw new Error("Research result belongs to another request.");
        const result = matchResearch(input, evidence.results);
        await save(applyResearch(dataset(), owner, id, result));
        render();
        await wait(1200, signal);
      }
      $("research-progress").textContent =
        "Research complete. Review uncertain matches or open your map.";
    } catch (error) {
      if (!signal.aborted) $("research-progress").textContent = error.message;
    } finally {
      if (current()?.id === owner)
        await save({
          ...dataset(),
          researchSettings: { ...settings(), paused: true },
        }).catch((e) => notice(e.message));
      running = false;
      controller = null;
      if (current()?.id === owner) render();
    }
  }
  async function stop() {
    if (controller) {
      controller.abort();
      while (running) await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  $("research-form").onsubmit = async (e) => {
    e.preventDefault();
    if (running) return;
    notice("");
    try {
      if (!$("research-consent").checked)
        throw new Error("Allow name-and-context research before starting.");
      await save({
        ...dataset(),
        researchSettings: {
          enabled: true,
          paused: false,
          city: $("research-city").value.trim(),
          community: $("research-community").value.trim(),
          university: $("research-university").value.trim(),
          consentedAt: settings().consentedAt || new Date().toISOString(),
        },
      });
      await run();
    } catch (error) {
      notice(error.message);
    }
  };
  $("research-pause").onclick = () => {
    void stop().then(() => {
      $("research-progress").textContent =
        "Paused. Your encrypted progress is saved.";
    });
  };
  $("research-view-map").onclick = () => {
    void stop()
      .then(showMap)
      .catch((e) => notice(e.message));
  };
  $("research-disable").onclick = () => {
    void stop()
      .then(async () => {
        await save({
          ...dataset(),
          researchSettings: { ...settings(), enabled: false, paused: true },
        });
        $("research-consent").checked = false;
        $("research-progress").textContent =
          "Automatic research is off. Imported contacts and saved results remain.";
        render();
      })
      .catch((e) => notice(e.message));
  };
  $("research-filter").oninput = render;
  $("research-status-filter").onchange = render;
  return {
    show,
    stop,
    isRunning: () => running,
    async afterImport() {
      if (settings().enabled && !running) {
        await save({
          ...dataset(),
          researchSettings: { ...settings(), paused: false },
        });
        void run();
      }
    },
    resume() {
      if (settings().enabled && !settings().paused) void run();
    },
  };
}
