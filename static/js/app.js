// ===================================================================
// Spark Tracker — frontend
// ===================================================================

const state = {
  meta: null,
  settings: null,
  lastOdometer: null,
  periods: {
    log: { unit: "week", anchor: new Date() },
    expenses: { unit: "month", anchor: new Date() },
    stats: { unit: "week", anchor: new Date() },
  },
  chart: null,
};

// ---------------------------------------------------------- helpers ---

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function money(n, decimals = 2) {
  if (n == null || isNaN(n)) return "—";
  return "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function num(n, decimals = 1) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: decimals });
}

function hoursLabel(h) {
  if (!h) return "0h";
  const mins = Math.round(h * 60);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

function pad(n) { return String(n).padStart(2, "0"); }
function isoDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function isoLocal(d) { return `${isoDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function parseISODate(s) { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); }
function timeLabel(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function dayLabel(d) {
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function numOrNull(v) { return v === "" || v == null ? null : Number(v); }

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

async function guard(fn) {
  try { return await fn(); } catch (e) { toast(e.message, true); }
}

// ---------------------------------------------------------- periods ---

function periodRange({ unit, anchor }) {
  const a = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  if (unit === "week") {
    const weekStart = Number(state.settings.week_start || 0); // 0 = Mon
    const offset = (a.getDay() + 6 - weekStart) % 7; // JS: 0 = Sun
    const start = new Date(a); start.setDate(a.getDate() - offset);
    const end = new Date(start); end.setDate(start.getDate() + 6);
    return { start, end, granularity: "day" };
  }
  if (unit === "month") {
    return { start: new Date(a.getFullYear(), a.getMonth(), 1), end: new Date(a.getFullYear(), a.getMonth() + 1, 0), granularity: "day" };
  }
  return { start: new Date(a.getFullYear(), 0, 1), end: new Date(a.getFullYear(), 11, 31), granularity: "month" };
}

function periodLabel(p) {
  const { start, end } = periodRange(p);
  if (p.unit === "year") return String(start.getFullYear());
  if (p.unit === "month") return start.toLocaleDateString([], { month: "long", year: "numeric" });
  const opts = { month: "short", day: "numeric" };
  return `${start.toLocaleDateString([], opts)} – ${end.toLocaleDateString([], opts)}`;
}

function shiftPeriod(p, dir) {
  const a = new Date(p.anchor);
  if (p.unit === "week") a.setDate(a.getDate() + 7 * dir);
  else if (p.unit === "month") a.setMonth(a.getMonth() + dir, 1);
  else a.setFullYear(a.getFullYear() + dir);
  p.anchor = a;
}

function rangeQuery(p) {
  const { start, end, granularity } = periodRange(p);
  return `start=${isoDate(start)}&end=${isoDate(end)}&granularity=${granularity}`;
}

function renderPeriodNav(key, units, onChange) {
  const el = $(`.period-nav[data-for="${key}"]`);
  const p = state.periods[key];
  el.innerHTML = `
    <div class="seg">${units.map((u) => `<button data-unit="${u}" class="${u === p.unit ? "on" : ""}">${u[0].toUpperCase() + u.slice(1)}</button>`).join("")}</div>
    <button class="btn small arrow" data-dir="-1">‹</button>
    <div class="label">${periodLabel(p)}</div>
    <button class="btn small arrow" data-dir="1">›</button>`;
  el.onclick = (e) => {
    const unitBtn = e.target.closest("[data-unit]");
    const dirBtn = e.target.closest("[data-dir]");
    if (unitBtn) { p.unit = unitBtn.dataset.unit; p.anchor = new Date(); }
    else if (dirBtn) shiftPeriod(p, Number(dirBtn.dataset.dir));
    else return;
    renderPeriodNav(key, units, onChange);
    onChange();
  };
}

// ---------------------------------------------------------- tabs ---

const TAB_TITLES = { home: "Spark Tracker", log: "Shift Log", expenses: "Expenses", stats: "Stats", settings: "Settings" };
const TAB_LOADERS = {
  home: () => loadHome(),
  log: () => loadLog(),
  expenses: () => loadExpenses(),
  stats: () => loadStats(),
  settings: () => renderSettings(),
};

function showTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  $$(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $("#page-title").textContent = TAB_TITLES[name];
  window.scrollTo(0, 0);
  guard(TAB_LOADERS[name]);
}

function currentTab() {
  return $(".tabbar button.active").dataset.tab;
}

function refreshCurrent() {
  guard(TAB_LOADERS[currentTab()]);
}

// ---------------------------------------------------------- modal ---

function openModal(title, html, onMount) {
  const body = $("#modal-body");
  body.onclick = body.oninput = body.onchange = null;
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = html;
  $("#modal").hidden = false;
  document.body.style.overflow = "hidden";
  if (onMount) onMount($("#modal-body"));
}

function closeModal() {
  $("#modal").hidden = true;
  $("#modal-body").innerHTML = "";
  document.body.style.overflow = "";
}

// ---------------------------------------------------------- meta ---

async function loadMeta() {
  state.meta = await api("GET", "/api/meta");
  state.settings = state.meta.settings;
  $("#store-list").innerHTML = state.meta.stores.map((s) => `<option value="${esc(s)}">`).join("");
}

function addStoreSuggestion(store) {
  if (store && !state.meta.stores.includes(store)) {
    state.meta.stores.unshift(store);
    $("#store-list").insertAdjacentHTML("afterbegin", `<option value="${esc(store)}">`);
  }
}

// ---------------------------------------------------------- home ---

const DRAFT_KEY = "spark-shift-draft";

function readDraft() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY)); } catch { return null; }
}
function writeDraft(form) {
  // An untouched form isn't worth keeping (it would pin an old date).
  const typed = ["start", "end", "start_odometer", "end_odometer", "miles", "notes"].some((k) => form[k])
    || form.trips.some((t) => tripTotal(t) || t.miles || t.notes);
  if (!typed) return clearDraft();
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(form)); } catch {}
}
function clearDraft() {
  try { localStorage.removeItem(DRAFT_KEY); } catch {}
}

// Shifts are usually logged the next morning, so default to yesterday before noon.
function defaultShiftDate() {
  const d = new Date();
  if (d.getHours() < 12) d.setDate(d.getDate() - 1);
  return isoDate(d);
}

function blankShiftForm(date) {
  return { date: date || defaultShiftDate(), start: "", end: "", start_odometer: "", end_odometer: "", miles: "", notes: "", trips: [{}] };
}

async function loadHome() {
  const since = new Date(); since.setDate(since.getDate() - 60);
  const [recent] = await Promise.all([
    api("GET", `/api/shifts?start=${isoDate(since)}`),
    renderWeekHero(),
  ]);
  state.lastOdometer = (recent.find((s) => s.end_odometer != null) || {}).end_odometer ?? null;

  // Only build the form once so a refresh never wipes what's being typed.
  if (!$("#home-form").childElementCount) renderHomeForm(readDraft() || blankShiftForm());
  else $("#home-form").dispatchEvent(new Event("input"));

  $("#recent-list").innerHTML = recent.length
    ? recent.slice(0, 6).map((s) => shiftRowHTML(s, true)).join("")
    : `<li class="empty">Your logged shifts will show up here.</li>`;
  $$("#recent-list [data-shift]").forEach((li) => {
    li.onclick = () => openShiftModal(recent.find((x) => x.id === Number(li.dataset.shift)));
  });
}

function renderHomeForm(form) {
  const root = $("#home-form");
  root.innerHTML = shiftFormHTML(form, { isNew: true });
  bindShiftForm(root, null, {
    onChange: writeDraft,
    onSaved: async (saved) => {
      clearDraft();
      // Keep the date: several shifts in one day is common.
      renderHomeForm(blankShiftForm(saved.start_time.slice(0, 10)));
      await loadHome();
      window.scrollTo({ top: 0, behavior: "smooth" });
    },
  });
}

async function renderWeekHero() {
  const p = { unit: "week", anchor: new Date() };
  const stats = await api("GET", `/api/stats?${rangeQuery(p)}`);
  const t = stats.totals;
  $("#week-gross").textContent = money(t.gross);
  $("#week-stats").innerHTML = `
    <div><b>${hoursLabel(t.hours)}</b><span>on shift</span></div>
    <div><b>${num(t.miles, 0)}</b><span>miles</span></div>
    <div><b>${t.net_per_hour != null ? money(t.net_per_hour) : "—"}</b><span>net / hr</span></div>`;
  const goal = Number(state.settings.weekly_goal || 0);
  $("#week-goal-wrap").hidden = !goal;
  if (goal) {
    const pct = Math.min(100, (t.gross / goal) * 100);
    $("#week-goal-fill").style.width = `${pct}%`;
    const left = goal - t.gross;
    $("#week-goal-text").textContent = left > 0
      ? `${Math.round(pct)}% of ${money(goal, 0)} goal · ${money(left)} to go`
      : `Goal of ${money(goal, 0)} reached 🎉`;
  }
}

function shiftRowHTML(s, showDate = false) {
  const range = `${timeLabel(s.start_time)} – ${s.end_time ? timeLabel(s.end_time) : "?"}`;
  const title = showDate ? `${dayLabel(parseISODate(s.start_time))} · ${range}` : range;
  const milesTag = !s.total_miles ? ' <span class="tag warn">no miles</span>' : "";
  return `<li class="tappable" data-shift="${s.id}">
    <div class="grow">
      <div class="title">${title}${milesTag}</div>
      <div class="sub">${hoursLabel(s.hours)} · ${s.trips.length} offer${s.trips.length === 1 ? "" : "s"} · ${num(s.total_miles)} mi${s.fuel_cost ? ` · ~${money(s.fuel_cost)} gas` : ""}${s.hours > 0.05 ? ` · ${money(s.gross / s.hours)}/hr` : ""}</div>
    </div>
    <div class="amt">${money(s.gross)}</div>
  </li>`;
}

// ---------------------------------------------------------- shift form ---
// One form for both logging a new shift (Home) and editing one (modal).

function shiftToForm(s) {
  return {
    date: s.start_time.slice(0, 10),
    start: s.start_time.slice(11, 16),
    end: s.end_time ? s.end_time.slice(11, 16) : "",
    start_odometer: s.start_odometer ?? "",
    end_odometer: s.end_odometer ?? "",
    miles: s.miles ?? "",
    notes: s.notes || "",
    trips: s.trips,
  };
}

function tripCardHTML(t, n) {
  return `<div class="trip-edit" data-trip-id="${t.id || ""}">
    <div class="trip-edit-head"><span data-trip-num>Offer ${n}</span><button type="button" class="btn small" data-remove>Remove</button></div>
    ${tripFieldsHTML(t)}
    <div class="offer-preview" data-trip-preview></div>
  </div>`;
}

function shiftFormHTML(f, { isNew }) {
  return `
    <div class="card">
      ${isNew ? "<h2>Log a shift</h2>" : ""}
      <label>Date<input type="date" data-s="date" value="${esc(f.date)}" required></label>
      <div class="grid2">
        <label>Start time<input type="time" data-s="start" value="${esc(f.start)}" required></label>
        <label>End time<input type="time" data-s="end" value="${esc(f.end)}" required></label>
      </div>
      <div class="grid3">
        <label>Start odo<input type="number" inputmode="decimal" step="0.1" data-s="start_odometer" value="${esc(f.start_odometer)}"></label>
        <label>End odo<input type="number" inputmode="decimal" step="0.1" data-s="end_odometer" value="${esc(f.end_odometer)}"></label>
        <label>Or miles<input type="number" inputmode="decimal" step="0.1" data-s="miles" value="${esc(f.miles)}"></label>
      </div>
      <div class="hint" data-odo-hint></div>
      <label>Notes<input type="text" data-s="notes" value="${esc(f.notes)}" placeholder="optional"></label>
    </div>
    <div data-trips>${(f.trips || []).map((t, i) => tripCardHTML(t, i + 1)).join("")}</div>
    <button type="button" class="btn ghost full" data-add-trip>+ Add another offer</button>
    <div class="shift-totals" data-totals></div>
    <div class="modal-actions">
      ${isNew ? '<button type="button" class="btn ghost" data-clear>Clear</button>' : '<button type="button" class="btn danger" data-delete>Delete</button>'}
      <button type="button" class="btn primary" data-save>Save shift</button>
    </div>`;
}

function readShiftForm(root) {
  const f = {};
  $$("[data-s]", root).forEach((el) => (f[el.dataset.s] = el.value));
  f.trips = $$(".trip-edit", root).map((card) => ({
    id: card.dataset.tripId ? Number(card.dataset.tripId) : undefined,
    ...readFields(card),
  }));
  return f;
}

// "HH:MM" on a date; an end time earlier than the start means the shift ran past midnight.
function formTimes(f) {
  if (!f.date || !f.start) return {};
  const start = `${f.date}T${f.start}`;
  if (!f.end) return { start };
  let endDate = f.date;
  if (f.end <= f.start) {
    const d = parseISODate(f.date); d.setDate(d.getDate() + 1); endDate = isoDate(d);
  }
  return { start, end: `${endDate}T${f.end}` };
}

function tripTotal(t) {
  return (Number(t.base_pay) || 0) + (Number(t.tip) || 0) + (Number(t.incentive) || 0);
}

function bindShiftForm(root, shift, { onChange, onSaved }) {
  const isNew = !shift;
  const gasPerMile = () => (state.meta.latest_fill ? state.meta.latest_fill.cost_per_mile : null);

  const renumber = () => $$("[data-trip-num]", root).forEach((el, i) => (el.textContent = `Offer ${i + 1}`));

  const update = () => {
    const f = readShiftForm(root);
    const gpm = gasPerMile();

    // Odometer hint, with a shortcut to carry over the last shift's ending odometer.
    const a = numOrNull(f.start_odometer), b = numOrNull(f.end_odometer);
    const hint = $("[data-odo-hint]", root);
    if (a != null && b != null) {
      hint.innerHTML = b >= a ? `Odometer: <b>${num(b - a)} miles</b>` : `<span class="warn-text">End odometer is lower than start.</span>`;
    } else if (isNew && a == null && state.lastOdometer != null) {
      hint.innerHTML = `Last shift ended at ${num(state.lastOdometer)}. <button type="button" class="link-btn" data-use-last>Use it</button>`;
    } else {
      hint.textContent = "Odometer readings make the strongest mileage record for the IRS.";
    }

    // Per-offer previews
    $$(".trip-edit", root).forEach((card) => {
      const t = readFields(card);
      const total = tripTotal(t), miles = Number(t.miles) || 0;
      let html = "";
      if (total) {
        html = `Total <b>${money(total)}</b>`;
        if (miles) {
          const pm = total / miles;
          html += ` · <b class="${pm >= 2 ? "good" : pm >= 1.25 ? "meh" : "bad"}">${money(pm)}/mi</b>`;
          if (gpm != null) html += ` · ≈ <b>${money(total - miles * gpm)}</b> after gas`;
        }
      }
      $("[data-trip-preview]", card).innerHTML = html;
    });

    // Shift totals
    const trips = f.trips.filter((t) => tripTotal(t));
    const gross = trips.reduce((sum, t) => sum + tripTotal(t), 0);
    const { start, end } = formTimes(f);
    const hours = start && end ? (new Date(end) - new Date(start)) / 3.6e6 : 0;
    const miles = a != null && b != null && b >= a ? b - a
      : numOrNull(f.miles) ?? trips.reduce((sum, t) => sum + (Number(t.miles) || 0), 0);
    const gas = gpm != null && miles ? miles * gpm : null;
    const bits = [
      `${trips.length} offer${trips.length === 1 ? "" : "s"}`,
      hours ? hoursLabel(hours) : null,
      miles ? `${num(miles)} mi` : null,
      gas != null ? `~${money(gas)} gas` : null,
      hours && gross ? `${money((gross - (gas || 0)) / hours)}/hr net` : null,
    ].filter(Boolean);
    $("[data-totals]", root).innerHTML = `<div class="shift-total-amt">${money(gross)}</div><div class="sub">${bits.join(" · ")}</div>`;

    if (onChange) onChange(f);
  };

  root.oninput = update;
  root.onchange = update;
  root.onclick = (e) => {
    if (e.target.closest("[data-use-last]")) {
      $("[data-s=start_odometer]", root).value = state.lastOdometer;
      update();
      $("[data-s=end_odometer]", root).focus();
    } else if (e.target.closest("[data-remove]")) {
      e.target.closest(".trip-edit").remove();
      renumber();
      update();
    } else if (e.target.closest("[data-add-trip]")) {
      // New offers usually come from the same store and are the same type as the last one.
      const cards = $$(".trip-edit", root);
      const prev = cards.length ? readFields(cards[cards.length - 1]) : {};
      $("[data-trips]", root).insertAdjacentHTML("beforeend",
        tripCardHTML({ offer_type: prev.offer_type, store: prev.store }, cards.length + 1));
      $(".trip-edit:last-child [data-f=base_pay]", root).focus();
      update();
    } else if (e.target.closest("[data-clear]")) {
      if (!confirm("Clear this form?")) return;
      clearDraft();
      renderHomeForm(blankShiftForm());
    } else if (e.target.closest("[data-delete]")) {
      guard(async () => {
        if (!confirm("Delete this shift and all its offers?")) return;
        await api("DELETE", `/api/shifts/${shift.id}`);
        toast("Shift deleted");
        if (onSaved) await onSaved(null);
      });
    } else if (e.target.closest("[data-save]")) {
      guard(() => save());
    }
  };

  const save = async () => {
    const f = readShiftForm(root);
    const { start, end } = formTimes(f);
    if (!f.date) throw new Error("Pick the shift's date.");
    if (!start || !end) throw new Error("Enter a start and end time.");
    const trips = f.trips.filter((t) => t.id || tripTotal(t));
    const body = {
      start_time: start,
      end_time: end,
      start_odometer: f.start_odometer,
      end_odometer: f.end_odometer,
      miles: f.miles,
      notes: f.notes,
      trips,
    };
    const saved = isNew ? await api("POST", "/api/shifts", body) : await api("PUT", `/api/shifts/${shift.id}`, body);
    trips.forEach((t) => addStoreSuggestion(t.store));
    const gas = saved.fuel_cost != null ? ` · ~${money(saved.fuel_cost)} gas` : "";
    toast(`Saved: ${money(saved.gross)} · ${num(saved.total_miles)} mi${gas}`);
    if (onSaved) await onSaved(saved);
  };

  update();
}

function openShiftModal(shift) {
  openModal("Edit shift", shiftFormHTML(shiftToForm(shift), { isNew: false }), (root) => {
    bindShiftForm(root, shift, {
      onSaved: async () => {
        closeModal();
        refreshCurrent();
      },
    });
  });
}

// ---------------------------------------------------------- trip edit ---

function tripFieldsHTML(t = {}) {
  const types = state.meta.offer_types
    .map((o) => `<option ${o === (t.offer_type || "Curbside") ? "selected" : ""}>${esc(o)}</option>`)
    .join("");
  const v = (x) => (x == null || x === 0 ? "" : x);
  return `
    <div class="grid2">
      <label>Type<select data-f="offer_type">${types}</select></label>
      <label>Store<input type="text" data-f="store" list="store-list" value="${esc(t.store)}"></label>
    </div>
    <div class="grid3">
      <label>Base<input type="number" inputmode="decimal" step="0.01" data-f="base_pay" value="${v(t.base_pay)}"></label>
      <label>Tip<input type="number" inputmode="decimal" step="0.01" data-f="tip" value="${v(t.tip)}"></label>
      <label>Incentive<input type="number" inputmode="decimal" step="0.01" data-f="incentive" value="${v(t.incentive)}"></label>
    </div>
    <div class="grid2">
      <label>Offer miles<input type="number" inputmode="decimal" step="0.1" data-f="miles" value="${v(t.miles)}"></label>
      <label>Deliveries<input type="number" inputmode="numeric" min="1" data-f="deliveries" value="${t.deliveries || 1}"></label>
    </div>
    <label>Notes<input type="text" data-f="notes" value="${esc(t.notes)}"></label>`;
}

function readFields(root) {
  const out = {};
  $$("[data-f]", root).forEach((el) => (out[el.dataset.f] = el.value));
  return out;
}

// ---------------------------------------------------------- bonus edit ---

function openBonusModal(bonus) {
  const isNew = !bonus;
  const b = bonus || { date: isoDate(new Date()), amount: "", description: "" };
  openModal(isNew ? "Add bonus / incentive" : "Edit bonus", `
    <div class="card">
      <div class="grid2">
        <label>Date<input type="date" id="b-date" value="${esc(b.date)}"></label>
        <label>Amount<input type="number" inputmode="decimal" step="0.01" id="b-amount" value="${esc(b.amount)}"></label>
      </div>
      <label>Description<input type="text" id="b-desc" value="${esc(b.description)}" placeholder="Weekly challenge, referral…"></label>
      <p class="hint">For money not tied to one offer, like weekly trip challenges or referral bonuses.</p>
    </div>
    <div class="modal-actions">
      ${isNew ? "" : '<button class="btn danger" id="b-delete">Delete</button>'}
      <button class="btn primary" id="b-save">Save</button>
    </div>`, () => {
    $("#b-save").onclick = () => guard(async () => {
      const body = { date: $("#b-date").value, amount: $("#b-amount").value, description: $("#b-desc").value };
      if (!Number(body.amount)) throw new Error("Enter an amount.");
      if (isNew) await api("POST", "/api/bonuses", body);
      else await api("PUT", `/api/bonuses/${b.id}`, body);
      closeModal();
      toast("Saved");
      refreshCurrent();
    });
    if (!isNew) {
      $("#b-delete").onclick = () => guard(async () => {
        if (!confirm("Delete this bonus?")) return;
        await api("DELETE", `/api/bonuses/${b.id}`);
        closeModal();
        refreshCurrent();
      });
    }
  });
}

// ---------------------------------------------------------- log ---

function summaryStripHTML(t) {
  return `
    <div><b>${money(t.gross, 0)}</b><span>earned</span></div>
    <div><b>${hoursLabel(t.hours)}</b><span>hours</span></div>
    <div><b>${num(t.miles, 0)}</b><span>miles</span></div>
    <div><b>${t.per_hour ? money(t.per_hour) : "—"}</b><span>per hour</span></div>`;
}

async function loadLog() {
  renderPeriodNav("log", ["week", "month"], loadLog);
  const q = rangeQuery(state.periods.log);
  const [shifts, bonuses, stats] = await Promise.all([
    api("GET", `/api/shifts?${q}`),
    api("GET", `/api/bonuses?${q}`),
    api("GET", `/api/stats?${q}`),
  ]);
  $("#log-summary").innerHTML = summaryStripHTML(stats.totals);

  const days = new Map();
  const dayOf = (key) => {
    if (!days.has(key)) days.set(key, { shifts: [], bonuses: [], total: 0 });
    return days.get(key);
  };
  shifts.forEach((s) => { const d = dayOf(s.start_time.slice(0, 10)); d.shifts.push(s); d.total += s.gross; });
  bonuses.forEach((b) => { const d = dayOf(b.date); d.bonuses.push(b); d.total += b.amount; });
  const keys = [...days.keys()].sort().reverse();

  if (!keys.length) {
    $("#log-list").innerHTML = `<div class="card"><ul class="list"><li class="empty">Nothing logged for this period.</li></ul></div>`;
    return;
  }

  $("#log-list").innerHTML = keys.map((key) => {
    const d = days.get(key);
    const rows = [
      ...d.shifts.map((s) => shiftRowHTML(s)),
      ...d.bonuses.map((b) => `<li class="tappable" data-bonus="${b.id}">
          <div class="grow"><div class="title">Bonus <span class="tag">extra</span></div><div class="sub">${esc(b.description) || "Incentive"}</div></div>
          <div class="amt">${money(b.amount)}</div>
        </li>`),
    ];
    return `<div class="day-group">
      <div class="day-head"><span>${dayLabel(parseISODate(key))}</span><span>${money(d.total)}</span></div>
      <ul class="list card">${rows.join("")}</ul>
    </div>`;
  }).join("");

  $$("#log-list [data-shift]").forEach((li) => {
    li.onclick = () => openShiftModal(shifts.find((x) => x.id === Number(li.dataset.shift)));
  });
  $$("#log-list [data-bonus]").forEach((li) => {
    li.onclick = () => openBonusModal(bonuses.find((x) => x.id === Number(li.dataset.bonus)));
  });
}

// ---------------------------------------------------------- expenses ---

function expenseHint() {
  const isVehicle = state.meta.vehicle_categories.includes($("#exp-category").value);
  $("#exp-hint").textContent = isVehicle
    ? "Tracked for your real costs, but not deducted separately: the standard mileage rate already covers repairs and insurance."
    : "Deductible on top of the mileage deduction.";
}

async function loadFuel() {
  const fills = await api("GET", "/api/fuel");
  state.meta.latest_fill = fills[0] || null;
  const f = fills[0];
  $("#fuel-current").innerHTML = f
    ? `Using <b>${money(f.price_per_gallon, 3)}/gal</b> at <b>${num(f.mpg)} MPG</b> = <b>${money(f.cost_per_mile)}</b> per Spark mile. Update this at each fill-up; only your logged Spark miles are counted, so personal driving doesn't matter.`
    : "Enter what you paid per gallon and your car's average MPG. Gas cost is estimated from your Spark miles only, so personal driving doesn't skew it.";
  $("#fuel-price").placeholder = f ? f.price_per_gallon : "3.199";
  $("#fuel-mpg").placeholder = f ? f.mpg : "24.5";
  $("#fuel-list").innerHTML = fills.slice(0, 5).map((x) => `<li class="tappable" data-fill="${x.id}">
      <div class="grow">
        <div class="title">${money(x.price_per_gallon, 3)}/gal · ${num(x.mpg)} MPG</div>
        <div class="sub">${dayLabel(parseISODate(x.date))}</div>
      </div>
      <div class="amt">${money(x.cost_per_mile)}/mi</div>
    </li>`).join("");
  $$("#fuel-list [data-fill]").forEach((li) => {
    li.onclick = () => openFuelModal(fills.find((x) => x.id === Number(li.dataset.fill)));
  });
}

async function addFuel(e) {
  e.preventDefault();
  await guard(async () => {
    await api("POST", "/api/fuel", {
      date: $("#fuel-date").value,
      price_per_gallon: $("#fuel-price").value,
      mpg: $("#fuel-mpg").value,
    });
    $("#fuel-price").value = "";
    $("#fuel-mpg").value = "";
    toast("Gas price saved");
    await loadExpenses();
  });
}

function openFuelModal(fill) {
  openModal("Edit fill-up", `
    <div class="card">
      <label>Fill-up date<input type="date" id="f-date" value="${esc(fill.date)}"></label>
      <div class="grid2">
        <label>$/gallon<input type="number" inputmode="decimal" step="0.001" id="f-price" value="${fill.price_per_gallon}"></label>
        <label>Avg MPG<input type="number" inputmode="decimal" step="0.1" id="f-mpg" value="${fill.mpg}"></label>
      </div>
      <p class="hint">Shifts use the most recent fill-up on or before their date.</p>
    </div>
    <div class="modal-actions">
      <button class="btn danger" id="f-delete">Delete</button>
      <button class="btn primary" id="f-save">Save</button>
    </div>`, () => {
    $("#f-save").onclick = () => guard(async () => {
      await api("PUT", `/api/fuel/${fill.id}`, {
        date: $("#f-date").value, price_per_gallon: $("#f-price").value, mpg: $("#f-mpg").value,
      });
      closeModal();
      toast("Fill-up updated");
      refreshCurrent();
    });
    $("#f-delete").onclick = () => guard(async () => {
      if (!confirm("Delete this fill-up?")) return;
      await api("DELETE", `/api/fuel/${fill.id}`);
      closeModal();
      refreshCurrent();
    });
  });
}

function categoryOptions(selected) {
  return state.meta.expense_categories.map((c) => `<option ${c === selected ? "selected" : ""}>${esc(c)}</option>`).join("");
}

async function loadExpenses() {
  renderPeriodNav("expenses", ["week", "month", "year"], loadExpenses);
  if (!$("#exp-category").options.length) {
    $("#exp-category").innerHTML = categoryOptions(state.meta.expense_categories[0]);
    $("#exp-date").value = isoDate(new Date());
    $("#fuel-date").value = isoDate(new Date());
    expenseHint();
  }
  await loadFuel();
  const q = rangeQuery(state.periods.expenses);
  const [rows, stats] = await Promise.all([api("GET", `/api/expenses?${q}`), api("GET", `/api/stats?${q}`)]);
  const t = stats.totals;
  $("#expense-summary").innerHTML = `
    <div><b>${t.has_fuel ? money(t.fuel_cost, 0) : "—"}</b><span>est. gas</span></div>
    <div><b>${money(t.vehicle_expenses, 0)}</b><span>other vehicle</span></div>
    <div><b>${money(t.deductible_expenses, 0)}</b><span>deductible</span></div>
    <div><b>${t.vehicle_cost_per_mile ? money(t.vehicle_cost_per_mile) : "—"}</b><span>car cost/mi</span></div>`;

  $("#expense-list").innerHTML = rows.length
    ? rows.map((e) => `<li class="tappable" data-exp="${e.id}">
        <div class="grow">
          <div class="title">${esc(e.category)}${e.is_vehicle ? "" : ' <span class="tag">deductible</span>'}</div>
          <div class="sub">${dayLabel(parseISODate(e.date))}${e.description ? " · " + esc(e.description) : ""}</div>
        </div>
        <div class="amt">${money(e.amount)}</div>
      </li>`).join("")
    : `<li class="empty">No expenses for this period.</li>`;
  $$("#expense-list [data-exp]").forEach((li) => {
    li.onclick = () => openExpenseModal(rows.find((x) => x.id === Number(li.dataset.exp)));
  });
}

async function addExpense(e) {
  e.preventDefault();
  await guard(async () => {
    await api("POST", "/api/expenses", {
      date: $("#exp-date").value,
      amount: $("#exp-amount").value,
      category: $("#exp-category").value,
      description: $("#exp-desc").value,
    });
    $("#exp-amount").value = "";
    $("#exp-desc").value = "";
    toast("Expense added");
    await loadExpenses();
  });
}

function openExpenseModal(exp) {
  openModal("Edit expense", `
    <div class="card">
      <div class="grid2">
        <label>Date<input type="date" id="e-date" value="${esc(exp.date)}"></label>
        <label>Amount<input type="number" inputmode="decimal" step="0.01" id="e-amount" value="${exp.amount}"></label>
      </div>
      <label>Category<select id="e-cat">${categoryOptions(exp.category)}</select></label>
      <label>Note<input type="text" id="e-desc" value="${esc(exp.description)}"></label>
    </div>
    <div class="modal-actions">
      <button class="btn danger" id="e-delete">Delete</button>
      <button class="btn primary" id="e-save">Save</button>
    </div>`, () => {
    $("#e-save").onclick = () => guard(async () => {
      await api("PUT", `/api/expenses/${exp.id}`, {
        date: $("#e-date").value, amount: $("#e-amount").value, category: $("#e-cat").value, description: $("#e-desc").value,
      });
      closeModal();
      toast("Expense updated");
      refreshCurrent();
    });
    $("#e-delete").onclick = () => guard(async () => {
      if (!confirm("Delete this expense?")) return;
      await api("DELETE", `/api/expenses/${exp.id}`);
      closeModal();
      refreshCurrent();
    });
  });
}

// ---------------------------------------------------------- stats ---

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function seriesLabel(key, granularity, unit) {
  if (granularity === "month") return parseISODate(key + "-01").toLocaleDateString([], { month: "short" });
  const d = parseISODate(key);
  return unit === "week" ? d.toLocaleDateString([], { weekday: "short" }) : String(d.getDate());
}

async function loadStats() {
  renderPeriodNav("stats", ["week", "month", "year"], loadStats);
  const p = state.periods.stats;
  const stats = await api("GET", `/api/stats?${rangeQuery(p)}`);
  const t = stats.totals;

  $("#stats-kpis").innerHTML = `
    <div class="feature"><b>${money(t.gross)}</b><span>gross earnings · ${t.trips} offers · ${t.deliveries} deliveries</span></div>
    <div><b>${t.per_hour ? money(t.per_hour) : "—"}</b><span>gross / hr</span></div>
    <div><b>${t.per_mile ? money(t.per_mile) : "—"}</b><span>gross / mile</span></div>
    <div><b>${t.per_trip ? money(t.per_trip) : "—"}</b><span>avg offer</span></div>
    <div><b>${hoursLabel(t.hours)}</b><span>${t.shifts} shifts</span></div>
    <div><b>${num(t.miles, 0)}</b><span>miles</span></div>
    <div><b>${t.tip_share != null ? num(t.tip_share, 0) + "%" : "—"}</b><span>from tips</span></div>
    <div><b>${t.net_per_hour != null ? money(t.net_per_hour) : "—"}</b><span>net / hr</span></div>
    <div><b>${t.has_fuel ? money(t.fuel_cost) : "—"}</b><span>est. gas</span></div>
    <div><b>${t.vehicle_cost_per_mile ? money(t.vehicle_cost_per_mile) : "—"}</b><span>car cost / mi</span></div>`;

  // Chart
  const labels = stats.series.map((s) => seriesLabel(s.key, stats.granularity, p.unit));
  const pay = stats.series.map((s) => +(s.gross - s.tips).toFixed(2));
  const tips = stats.series.map((s) => s.tips);
  if (state.chart) state.chart.destroy();
  const grid = cssVar("--border");
  const muted = cssVar("--muted");
  state.chart = new Chart($("#chart-earnings"), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Pay + bonuses", data: pay, backgroundColor: cssVar("--accent"), borderRadius: 4, stack: "e" },
        { label: "Tips", data: tips, backgroundColor: cssVar("--gold"), borderRadius: 4, stack: "e" },
      ],
    },
    options: {
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: muted, boxWidth: 12 } },
        tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${money(c.raw)}` } },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: muted, autoSkip: true, maxRotation: 0 } },
        y: { stacked: true, grid: { color: grid }, ticks: { color: muted, callback: (v) => "$" + v } },
      },
    },
  });

  // Taxes
  const rateNote = Object.entries(state.settings.mileage_rates || {})
    .filter(([y]) => Number(y) >= periodRange(p).start.getFullYear() && Number(y) <= periodRange(p).end.getFullYear())
    .map(([y, r]) => `${y}: $${r}`).join(", ");
  $("#tax-table").innerHTML = `
    <tr><td>Gross earnings</td><td>${money(t.gross)}</td></tr>
    <tr><td class="minus">− Mileage deduction (${num(t.miles, 0)} mi${rateNote ? ` @ ${rateNote}` : ""})</td><td class="minus">−${money(t.mileage_deduction)}</td></tr>
    <tr><td class="minus">− Other deductible expenses</td><td class="minus">−${money(t.deductible_expenses)}</td></tr>
    <tr><td><b>Taxable profit</b></td><td>${money(t.taxable_profit)}</td></tr>
    <tr><td>Self-employment tax (15.3%)</td><td>${money(t.se_tax)}</td></tr>
    <tr><td>Income tax set-aside (${num(state.settings.income_tax_pct)}%)</td><td>${money(t.income_tax)}</td></tr>
    <tr class="total"><td>Set aside</td><td>${money(t.set_aside)}</td></tr>
    <tr><td class="minus">− ${t.has_fuel ? "Est. gas + logged expenses" : "Logged expenses (add gas price on Expenses tab)"}</td><td class="minus">−${money(t.costs)}</td></tr>
    <tr><td>Take-home after gas, costs &amp; taxes</td><td>${money(t.net_cash - t.set_aside)}</td></tr>`;

  // Offer types
  $("#type-table").innerHTML = stats.by_type.length
    ? `<tr><th>Type</th><th>Offers</th><th>Avg</th><th>Avg tip</th><th>$/mi</th></tr>` +
      stats.by_type.map((r) => `<tr><td>${esc(r.offer_type)}</td><td>${r.count}</td><td>${money(r.avg)}</td><td>${money(r.avg_tip)}</td><td>${r.per_mile ? money(r.per_mile) : "—"}</td></tr>`).join("")
    : `<tr><td class="muted">No offers yet.</td></tr>`;

  // Weekdays
  const worked = stats.by_weekday.filter((d) => d.shifts);
  const best = Math.max(...worked.map((d) => d.net_per_hour || 0));
  $("#weekday-table").innerHTML = worked.length
    ? `<tr><th>Day</th><th>Hours</th><th>Earned</th><th>$/hr</th><th>After gas</th></tr>` +
      worked.map((d) => `<tr><td>${d.day}</td><td>${num(d.hours)}</td><td>${money(d.gross, 0)}</td><td>${d.per_hour ? money(d.per_hour) : "—"}</td><td class="${d.net_per_hour === best ? "best" : ""}">${d.net_per_hour ? money(d.net_per_hour) : "—"}</td></tr>`).join("")
    : `<tr><td class="muted">No shifts yet.</td></tr>`;

  // Stores
  $("#store-table").innerHTML = stats.by_store.length
    ? `<tr><th>Store</th><th>Offers</th><th>Avg</th><th>Avg tip</th></tr>` +
      stats.by_store.map((r) => `<tr><td>${esc(r.store)}</td><td>${r.count}</td><td>${money(r.avg)}</td><td>${money(r.avg_tip)}</td></tr>`).join("")
    : `<tr><td class="muted">Add a store name to your offers to compare them.</td></tr>`;
}

// ---------------------------------------------------------- settings ---

function rateRowHTML(year = "", rate = "") {
  return `<div class="rate-row">
    <label>Year<input type="number" data-r="year" value="${esc(year)}"></label>
    <label>Rate<input type="number" step="0.001" inputmode="decimal" data-r="rate" value="${esc(rate)}"></label>
    <button type="button" class="btn small" data-remove-rate>✕</button>
  </div>`;
}

function renderSettings() {
  const s = state.settings;
  $("#set-goal").value = s.weekly_goal || "";
  $("#set-income-tax").value = s.income_tax_pct;
  $("#set-week-start").value = s.week_start;
  $("#set-purpose").value = s.trip_purpose;
  $("#rate-rows").innerHTML = Object.entries(s.mileage_rates || {})
    .sort(([a], [b]) => b - a)
    .map(([y, r]) => rateRowHTML(y, r))
    .join("");

  const thisYear = new Date().getFullYear();
  $("#export-year").innerHTML = [0, 1, 2, 3].map((i) => `<option>${thisYear - i}</option>`).join("");
}

async function saveSettings(e) {
  e.preventDefault();
  const rates = {};
  $$("#rate-rows .rate-row").forEach((row) => {
    const y = $("[data-r=year]", row).value;
    const r = $("[data-r=rate]", row).value;
    if (y && r) rates[y] = Number(r);
  });
  await guard(async () => {
    state.settings = await api("PUT", "/api/settings", {
      weekly_goal: $("#set-goal").value || 0,
      income_tax_pct: $("#set-income-tax").value || 0,
      week_start: $("#set-week-start").value,
      trip_purpose: $("#set-purpose").value,
      mileage_rates: rates,
    });
    renderSettings();
    toast("Settings saved");
  });
}

// ---------------------------------------------------------- init ---

function bindEvents() {
  $$(".tabbar button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  // Only the ✕ closes a dialog, so a stray tap outside it can't throw away what was typed.
  $("#modal-close").onclick = closeModal;

  $("#btn-log-add-shift").onclick = () => showTab("home");
  $("#btn-log-add-bonus").onclick = () => openBonusModal(null);

  $("#expense-form").onsubmit = addExpense;
  $("#fuel-form").onsubmit = addFuel;
  $("#exp-category").onchange = expenseHint;

  $("#settings-form").onsubmit = saveSettings;
  $("#btn-add-rate").onclick = () => $("#rate-rows").insertAdjacentHTML("afterbegin", rateRowHTML(new Date().getFullYear() + 1, ""));
  $("#rate-rows").onclick = (e) => { if (e.target.closest("[data-remove-rate]")) e.target.closest(".rate-row").remove(); };
  $$("[data-export]").forEach((a) => {
    a.onclick = () => { a.href = `/export/${a.dataset.export}.csv?year=${$("#export-year").value}`; };
  });

  // Coming back to the app refreshes the view (the Home form itself is never rebuilt).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && $("#modal").hidden) refreshCurrent();
  });
}

async function init() {
  bindEvents();
  await guard(async () => {
    await loadMeta();
    await loadHome();
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

init();
