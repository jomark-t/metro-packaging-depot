const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const CURRENT_USER = window.CURRENT_USER || {
  display_name: null, is_superuser: false, is_manager: false, staff_name: null,
};
const IS_SUPERUSER = !!CURRENT_USER.is_superuser;
// Superuser or Clare - the only roles that get Payroll and Employees.
const IS_MANAGER = !!CURRENT_USER.is_manager;

const userMenuBtn = document.getElementById("userMenuBtn");
const userMenu = document.getElementById("userMenu");
if (userMenuBtn && userMenu) {
  userMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    userMenu.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!userMenu.classList.contains("hidden") && !userMenu.contains(e.target)) {
      userMenu.classList.add("hidden");
    }
  });
}

// Staff without the Employees tab still need to be able to change their
// own PIN - same self-service endpoint their Employees card used to hit.
// There are two of these: the desktop account dropdown and the phone's
// hamburger menu.
document.querySelectorAll(".change-pin-btn").forEach((changePinBtn) => {
  changePinBtn.addEventListener("click", async () => {
    const pin = window.prompt("Enter your new PIN (at least 4 characters):");
    if (!pin) return;
    if (pin.length < 4) {
      alert("PIN must be at least 4 characters.");
      return;
    }
    if (window.prompt("Type the new PIN again to confirm:") !== pin) {
      alert("The PINs didn't match. Nothing was changed.");
      return;
    }
    const res = await fetch(`/api/staff/${encodeURIComponent(CURRENT_USER.staff_name)}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json().catch(() => ({}));
    alert(res.ok ? "PIN changed. Use it the next time you log in." : data.message || "Could not change your PIN.");
  });
});

// Mobile nav: the tab strip collapses behind a hamburger below `sm`.
// Tailwind's `sm:flex` wins over the `hidden` class at desktop widths, so
// toggling `hidden` here only ever affects the phone layout.
const navToggle = document.getElementById("navToggle");
const navTabs = document.getElementById("navTabs");
if (navToggle && navTabs) {
  const setNavOpen = (open) => {
    navTabs.classList.toggle("hidden", !open);
    document.getElementById("navIconOpen").classList.toggle("hidden", open);
    document.getElementById("navIconClose").classList.toggle("hidden", !open);
    navToggle.setAttribute("aria-expanded", String(open));
  };
  navToggle.addEventListener("click", () => setNavOpen(navTabs.classList.contains("hidden")));
  // picking a destination closes the menu, the way a phone nav should
  navTabs.addEventListener("click", (e) => {
    if (e.target.closest(".tab-btn")) setNavOpen(false);
  });
}

const monthSelect = document.getElementById("monthSelect");
const yearSelect = document.getElementById("yearSelect");
const generateBtn = document.getElementById("generateBtn");
const downloadPdfBtn = document.getElementById("downloadPdfBtn");
const snapshotSelect = document.getElementById("snapshotSelect");
const createSnapshotBtn = document.getElementById("createSnapshotBtn");
const restoreSnapshotBtn = document.getElementById("restoreSnapshotBtn");
const summaryEl = document.getElementById("summary");
const tableHeadRow = document.getElementById("tableHeadRow");
const tableBody = document.getElementById("tableBody");
const emptyState = document.getElementById("emptyState");
const scheduleTable = document.getElementById("scheduleTable");

function initSelectors() {
  MONTH_NAMES.forEach((name, i) => {
    const opt = document.createElement("option");
    opt.value = i + 1;
    opt.textContent = name;
    monthSelect.appendChild(opt);
  });

  const now = new Date();
  monthSelect.value = now.getMonth() + 1;

  const currentYear = now.getFullYear();
  for (let y = currentYear - 1; y <= currentYear + 2; y++) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    if (y === currentYear) opt.selected = true;
    yearSelect.appendChild(opt);
  }
}

// Tailwind utility classes per shift label - chip background/text/border
// Sales shifts use soft/light badges; machine-op days use bold solid
// badges so Printer/Checker read as clearly distinct from Half Day/Closing
// and from each other.
const CHIP_CLASSES = {
  Opening: "bg-blue-50 text-brand-blue border-l-2 border-brand-blue",
  Closing: "bg-gray-100 text-black border-l-2 border-black",
  "Half Day": "bg-[#F4EBDF] text-brand-tan border-l-2 border-brand-tan",
  Inventory: "bg-green-50 text-brand-green border-l-2 border-brand-green",
  Printer: "bg-[#e3d1ba] text-[#8a6a3e] border-l-2 border-[#8a6a3e]",
  Checker: "bg-gray-300 text-black border-l-2 border-black",
  "Paid Time Off": "bg-purple-50 text-purple-700 border-l-2 border-purple-700",
};

function chipClasses(label) {
  return CHIP_CLASSES[label] || "bg-gray-50 text-black border-l-2 border-gray-300";
}

// Shifts a person can be manually reassigned to, keyed by staff category.
// Mirrors EDITABLE_OPTIONS in app.py.
const EDITABLE_OPTIONS = {
  manager: ["Opening", "Closing", "Half Day", "Inventory", "Paid Time Off", "Off"],
  sales: ["Opening", "Closing", "Half Day", "Inventory", "Paid Time Off", "Off"],
  sales_pt: ["Opening", "Closing", "Half Day", "Inventory", "Paid Time Off", "Off"],
  machine: ["Printer", "Checker", "Half Day", "Inventory", "Paid Time Off", "Off"],
};

function cellDisplayHtml(label, timeRange) {
  if (!label || label === "Off") {
    return `<span class="inline-block bg-gray-50 border border-gray-200 text-gray-400 text-xs rounded-md px-2 py-1">Off</span>`;
  }
  return `<span class="inline-flex flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-xs leading-tight ${chipClasses(label)}">
             <span class="font-semibold">${label}</span>
             <span class="font-mono text-[10px] opacity-70">${timeRange}</span>
           </span>`;
}

async function updateEntry(name, date, label) {
  const res = await fetch("/api/schedule/entry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, date, label }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || "Update failed");
  }
  return res.json();
}

function openCellEditor(td) {
  const options = EDITABLE_OPTIONS[td.dataset.category] || ["Off"];
  const current = td.dataset.label;

  const select = document.createElement("select");
  select.className =
    "text-xs border border-gray-300 rounded-md px-1.5 py-1 font-mono bg-white focus:outline-none focus:ring-2 focus:ring-brand-blue";
  options.forEach((opt) => {
    const o = document.createElement("option");
    o.value = opt;
    o.textContent = opt;
    if (opt === current) o.selected = true;
    select.appendChild(o);
  });

  td.innerHTML = "";
  td.appendChild(select);
  select.focus();

  let saving = false;

  select.addEventListener("blur", () => {
    if (saving) return;
    td.innerHTML = cellDisplayHtml(td.dataset.label, td.dataset.timeRange);
  });

  select.addEventListener("change", async () => {
    saving = true;
    select.disabled = true;
    try {
      const result = await updateEntry(td.dataset.name, td.dataset.date, select.value);
      td.dataset.label = result.label;
      td.dataset.timeRange = result.time_range || "";
      await loadSchedule();
    } catch (err) {
      alert("Could not update the schedule. Please try again.");
      td.innerHTML = cellDisplayHtml(td.dataset.label, td.dataset.timeRange);
    }
  });
}

async function loadSchedule() {
  const year = yearSelect.value;
  const month = monthSelect.value;
  const res = await fetch(`/api/schedule?year=${year}&month=${month}`);
  const data = await res.json();
  loadSnapshots();
  renderLastEdited(data.last_edited);

  if (!data.days || data.days.length === 0 || Object.values(data.staff_counts).every((c) => c === 0)) {
    scheduleTable.style.display = "none";
    emptyState.style.display = "block";
    if (summaryEl) summaryEl.innerHTML = "";
    downloadPdfBtn.disabled = true;
    return;
  }

  scheduleTable.style.display = "table";
  emptyState.style.display = "none";
  downloadPdfBtn.disabled = false;

  renderSummary(data.staff, data.staff_counts);
  renderTable(data.days, data.staff);
}

function renderLastEdited(lastEdited) {
  const el = document.getElementById("lastEditedLabel");
  if (!el) return;
  if (!lastEdited) {
    el.textContent = "";
    return;
  }
  const when = new Date(lastEdited.at).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
  el.textContent = `Last edited by ${lastEdited.by} · ${when} · ${lastEdited.action}`;
}

async function loadSnapshots() {
  // the snapshot controls only exist for the superuser
  if (!snapshotSelect || !restoreSnapshotBtn) return;
  const year = yearSelect.value;
  const month = monthSelect.value;
  const res = await fetch(`/api/schedule/snapshots?year=${year}&month=${month}`);
  const data = await res.json();

  if (!data.snapshots.length) {
    snapshotSelect.innerHTML = `<option value="">No snapshots</option>`;
    restoreSnapshotBtn.disabled = true;
    return;
  }
  snapshotSelect.innerHTML = data.snapshots.map((s) => `<option value="${s.id}">${s.label}</option>`).join("");
  restoreSnapshotBtn.disabled = !IS_SUPERUSER;
}

async function createSnapshot() {
  if (!IS_SUPERUSER) return;
  createSnapshotBtn.disabled = true;
  const original = createSnapshotBtn.textContent;
  createSnapshotBtn.textContent = "Saving…";
  try {
    const res = await fetch("/api/schedule/snapshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ year: yearSelect.value, month: monthSelect.value }),
    });
    const data = await res.json();
    if (!res.ok) {
      alert(data.message || "Could not create a snapshot.");
      return;
    }
    await loadSnapshots();
    snapshotSelect.value = data.id;
  } finally {
    createSnapshotBtn.disabled = !IS_SUPERUSER;
    createSnapshotBtn.textContent = original;
  }
}

async function restoreSnapshot() {
  if (!IS_SUPERUSER) return;
  const snapshotId = snapshotSelect.value;
  if (!snapshotId) return;
  const label = snapshotSelect.options[snapshotSelect.selectedIndex].textContent;
  const monthName = MONTH_NAMES[parseInt(monthSelect.value, 10) - 1];
  const confirmed = window.confirm(
    `Restore "${label}"?\n\n` +
      `This replaces the entire current schedule for ${monthName} ${yearSelect.value} with what was saved in that snapshot - any changes made since won't be recoverable unless you snapshot first.`
  );
  if (!confirmed) return;

  restoreSnapshotBtn.disabled = true;
  const original = restoreSnapshotBtn.textContent;
  restoreSnapshotBtn.textContent = "Restoring…";
  try {
    const res = await fetch(`/api/schedule/snapshot/${snapshotId}/restore`, { method: "POST" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      alert(data.message || "Could not restore that snapshot.");
      return;
    }
    await loadSchedule();
  } finally {
    restoreSnapshotBtn.disabled = !IS_SUPERUSER;
    restoreSnapshotBtn.textContent = original;
  }
}

function renderSummary(staff, counts) {
  if (!summaryEl) return; // day-count cards are branch-only
  summaryEl.innerHTML = "";
  staff.forEach((s) => {
    const card = document.createElement("div");
    card.className = "bg-white border border-gray-200 rounded-xl px-4 py-3.5 shadow-sm";
    const targetLabel = s.target ? `/ ${s.target} target` : "";
    card.innerHTML = `
      <p class="font-display font-semibold text-base leading-tight mb-0.5">${s.name}</p>
      <p class="text-[11px] text-gray-500 mb-2.5">${s.role} · ${s.employment}</p>
      <span class="font-mono text-xl text-brand-blue font-medium">${counts[s.name] ?? 0}</span>
      <span class="text-[11px] text-gray-500 ml-1">days ${targetLabel}</span>
    `;
    summaryEl.appendChild(card);
  });
}

function renderTable(days, staff) {
  tableHeadRow.innerHTML =
    `<th class="text-left text-sm font-mono uppercase tracking-wide font-medium px-3.5 py-2.5 min-w-[70px]">Date</th>` +
    staff.map((s) => `<th class="text-left text-sm font-mono uppercase tracking-wide font-medium px-3.5 py-2.5">${s.name}</th>`).join("") +
    `<th class="text-left text-sm font-mono uppercase tracking-wide font-medium px-3.5 py-2.5">Off Today</th>`;

  tableBody.innerHTML = "";
  days.forEach((day) => {
    const tr = document.createElement("tr");
    const wd = day.weekday;
    if (wd === "Sunday") tr.className = "bg-green-50/40";
    else if (wd === "Saturday") tr.className = "bg-gray-50";

    const dateTd = document.createElement("td");
    dateTd.className = "px-3.5 py-2.5 align-top whitespace-nowrap";
    dateTd.innerHTML = `<span class="font-mono font-medium text-[15px]">${day.day_num}</span><span class="block text-[10px] uppercase tracking-wide text-gray-500 mt-0.5">${day.weekday_short}</span>`;
    tr.appendChild(dateTd);

    staff.forEach((s) => {
      const td = document.createElement("td");
      // only managers can reassign shifts, so only they get the clickable
      // affordance - everyone else sees a plain read-only cell
      td.className = IS_MANAGER
        ? "px-3.5 py-2.5 align-top cursor-pointer hover:bg-blue-50/40 transition schedule-cell"
        : "px-3.5 py-2.5 align-top";
      td.dataset.name = s.name;
      td.dataset.date = day.date;
      td.dataset.category = s.category;
      const entry = day.entries.find((e) => e.name === s.name) || null;
      td.dataset.label = entry ? entry.shift_label : "Off";
      td.dataset.timeRange = entry ? entry.time_range : "";
      td.innerHTML = cellDisplayHtml(td.dataset.label, td.dataset.timeRange);
      tr.appendChild(td);
    });

    const offTd = document.createElement("td");
    offTd.className = "px-3.5 py-2.5 align-top";
    offTd.innerHTML = day.off.length
      ? day.off
          .map((n) => `<span class="inline-block bg-gray-50 border border-gray-200 rounded-md px-2 py-0.5 mr-1 mb-1 text-[11px] text-gray-500">${n}</span>`)
          .join("")
      : `<span class="text-gray-300">—</span>`;
    tr.appendChild(offTd);

    tableBody.appendChild(tr);
  });
}

async function generateSchedule() {
  if (!IS_SUPERUSER) return;
  const monthName = MONTH_NAMES[parseInt(monthSelect.value, 10) - 1];
  const confirmed = window.confirm(
    `Regenerate the schedule for ${monthName} ${yearSelect.value}?\n\n` +
      "This replaces the entire saved schedule for that month, including any manual reassignments (Paid Time Off, edited shifts, etc.) - they'll be lost."
  );
  if (!confirmed) return;

  generateBtn.disabled = true;
  generateBtn.textContent = "Generating…";
  try {
    await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ year: yearSelect.value, month: monthSelect.value }),
    });
    await loadSchedule();
  } finally {
    generateBtn.disabled = !IS_SUPERUSER;
    generateBtn.textContent = "Generate schedule";
  }
}

async function downloadPdf() {
  downloadPdfBtn.disabled = true;
  const original = downloadPdfBtn.innerHTML;
  downloadPdfBtn.textContent = "Preparing…";
  try {
    const year = yearSelect.value;
    const month = monthSelect.value;
    const res = await fetch(`/api/schedule/pdf?year=${year}&month=${month}`);
    if (!res.ok) throw new Error("PDF generation failed");
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `duty-roster-${year}-${String(month).padStart(2, "0")}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  } catch (err) {
    alert("Could not generate the PDF. Try generating the schedule first.");
  } finally {
    downloadPdfBtn.innerHTML = original;
    downloadPdfBtn.disabled = false;
  }
}

// Generate/snapshot/restore aren't rendered for anyone but the superuser,
// so these are all conditional now.
if (generateBtn) generateBtn.addEventListener("click", generateSchedule);
if (createSnapshotBtn) createSnapshotBtn.addEventListener("click", createSnapshot);
if (restoreSnapshotBtn) restoreSnapshotBtn.addEventListener("click", restoreSnapshot);
downloadPdfBtn.addEventListener("click", downloadPdf);
monthSelect.addEventListener("change", loadSchedule);
yearSelect.addEventListener("change", loadSchedule);
tableBody.addEventListener("click", (e) => {
  if (!IS_MANAGER) return;
  const td = e.target.closest(".schedule-cell");
  if (!td || td.querySelector("select")) return;
  openCellEditor(td);
});

initSelectors();
loadSchedule();

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const tabDashboardBtn = document.getElementById("tabDashboardBtn");
const dashboardView = document.getElementById("dashboardView");
const tabScheduleBtn = document.getElementById("tabScheduleBtn");
const tabLeaveBtn = document.getElementById("tabLeaveBtn");
const leaveView = document.getElementById("leaveView");
const tabPayrollBtn = document.getElementById("tabPayrollBtn");
const tabEmployeesBtn = document.getElementById("tabEmployeesBtn");
const tabActivityBtn = document.getElementById("tabActivityBtn");
const activityView = document.getElementById("activityView");
const tabPrintBtn = document.getElementById("tabPrintBtn");
const printView = document.getElementById("printView");
const tabPrintClientsBtn = document.getElementById("tabPrintClientsBtn");
const printClientsView = document.getElementById("printClientsView");
const tabPricingBtn = document.getElementById("tabPricingBtn");
const pricingView = document.getElementById("pricingView");
const tabAdminBtn = document.getElementById("tabAdminBtn");
const adminView = document.getElementById("adminView");
const tabMyPayBtn = document.getElementById("tabMyPayBtn");
const myPayView = document.getElementById("myPayView");
const tabMyInfoBtn = document.getElementById("tabMyInfoBtn");
const myInfoView = document.getElementById("myInfoView");
const scheduleControls = document.getElementById("scheduleControls");
const payrollControls = document.getElementById("payrollControls");
const scheduleView = document.getElementById("scheduleView");
const payrollView = document.getElementById("payrollView");
const employeesView = document.getElementById("employeesView");

// Payroll/Employees buttons only exist in the DOM for managers, so their
// tabs are only registered when they do.
const TABS = {
  dashboard: { btn: tabDashboardBtn, view: dashboardView, controls: null },
  schedule: { btn: tabScheduleBtn, view: scheduleView, controls: scheduleControls },
};
// Time Off only exists for people who take leave or approve it.
if (tabLeaveBtn) TABS.leave = { btn: tabLeaveBtn, view: leaveView, controls: null };
if (tabPayrollBtn) TABS.payroll = { btn: tabPayrollBtn, view: payrollView, controls: payrollControls };
if (tabEmployeesBtn) TABS.employees = { btn: tabEmployeesBtn, view: employeesView, controls: null };
if (tabActivityBtn) TABS.activity = { btn: tabActivityBtn, view: activityView, controls: null };
if (tabPrintBtn) TABS.print = { btn: tabPrintBtn, view: printView, controls: null };
if (tabPrintClientsBtn) TABS.printclients = { btn: tabPrintClientsBtn, view: printClientsView, controls: null };
if (tabPricingBtn) TABS.pricing = { btn: tabPricingBtn, view: pricingView, controls: null };
if (tabAdminBtn) TABS.admin = { btn: tabAdminBtn, view: adminView, controls: null };
if (tabMyPayBtn) TABS.mypay = { btn: tabMyPayBtn, view: myPayView, controls: null };
if (tabMyInfoBtn) TABS.myinfo = { btn: tabMyInfoBtn, view: myInfoView, controls: null };
const loadedOnce = { payroll: false, employees: false, leave: false, activity: false };

function showTab(tab) {
  Object.entries(TABS).forEach(([name, t]) => {
    const active = name === tab;
    t.btn.classList.toggle("active-tab", active);
    t.view.style.display = active ? "block" : "none";
    if (t.controls) t.controls.style.display = active ? "flex" : "none";
  });
  if (tab === "payroll" && !loadedOnce.payroll) {
    loadedOnce.payroll = true;
    loadPayroll();
    loadThirteenthMonth();
  }
  if (tab === "employees" && !loadedOnce.employees) {
    loadedOnce.employees = true;
    loadEmployees();
  }
  if (tab === "leave" && !loadedOnce.leave) {
    loadedOnce.leave = true;
    initLeaveTab();
  }
  if (tab === "dashboard") {
    loadDashboard(); // always fresh - it's a "right now" view
  }
  if (tab === "admin") {
    loadAdminUsers();
  }
  if (tab === "print") {
    loadPrintQueue();
  }
  if (tab === "printclients") {
    loadPrintClientsPage();
  }
  if (tab === "pricing") {
    loadPricing();
  }
  if (tab === "mypay") {
    loadMyPay();
  }
  if (tab === "myinfo") {
    // leaving and coming back discards a half-finished edit rather than
    // resuming one the person has probably forgotten about
    if (myInfoEditing) setMyInfoEditing(false);
    loadMyDetails();
  }
  if (tab === "activity") {
    // always refresh - the point of the log is to show what just happened
    loadedOnce.activity = true;
    loadActivity();
  }
}

tabDashboardBtn.addEventListener("click", () => showTab("dashboard"));
tabScheduleBtn.addEventListener("click", () => showTab("schedule"));
if (tabLeaveBtn) tabLeaveBtn.addEventListener("click", () => showTab("leave"));
if (tabPayrollBtn) tabPayrollBtn.addEventListener("click", () => showTab("payroll"));
if (tabEmployeesBtn) tabEmployeesBtn.addEventListener("click", () => showTab("employees"));
if (tabActivityBtn) tabActivityBtn.addEventListener("click", () => showTab("activity"));
if (tabPrintBtn) tabPrintBtn.addEventListener("click", () => showTab("print"));
if (tabPrintClientsBtn) tabPrintClientsBtn.addEventListener("click", () => showTab("printclients"));
if (tabPricingBtn) tabPricingBtn.addEventListener("click", () => showTab("pricing"));
if (tabAdminBtn) tabAdminBtn.addEventListener("click", () => showTab("admin"));
if (tabMyPayBtn) tabMyPayBtn.addEventListener("click", () => showTab("mypay"));
if (tabMyInfoBtn) tabMyInfoBtn.addEventListener("click", () => showTab("myinfo"));

// Staff land on the dashboard - "when am I next in" is why they opened the
// app. Managers land on the schedule, which is what they came to work on.
showTab(IS_MANAGER ? "schedule" : "dashboard");

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
const ATTENTION_ICON = {
  warn: '<span class="text-amber-500 mt-0.5">▲</span>',
  money: '<span class="text-brand-blue mt-0.5">₱</span>',
  info: '<span class="text-gray-400 mt-0.5">◷</span>',
};

// A compact chip using the same colours as the schedule table, so a
// shift means the same thing everywhere in the app.
function miniChip(label, timeRange) {
  if (!label || label === "Off") {
    return `<span class="text-[11px] text-gray-400 bg-gray-50 border border-gray-200 rounded px-1.5 py-0.5">Off</span>`;
  }
  const short = (timeRange || "")
    .replace(/:00/g, "")
    .replace(/\s?(AM|PM)/g, "")
    .replace(" - ", "–");
  return `<span class="text-[11px] rounded px-1.5 py-0.5 ${chipClasses(label)}">${escapeHtml(label)}${short ? ` · ${escapeHtml(short)}` : ""}</span>`;
}

function renderManagerDashboard(d) {
  const onDuty = document.getElementById("dashOnDuty");
  onDuty.innerHTML = d.on_duty.length
    ? d.on_duty
        .map(
          (e) => `
      <div class="flex items-center gap-2.5 border border-gray-200 rounded-lg pl-2.5 pr-3.5 py-2">
        <span class="w-8 h-8 rounded-full bg-gray-100 border border-gray-200 flex items-center justify-center text-xs font-semibold text-gray-500">${escapeHtml(e.name.charAt(0))}</span>
        <div>
          <p class="text-sm font-medium leading-tight">${escapeHtml(e.name)}</p>
          ${miniChip(e.label, e.time_range)}
        </div>
      </div>`
        )
        .join("")
    : `<p class="text-sm text-gray-400 italic">Nobody is scheduled today.</p>`;

  document.getElementById("dashOffToday").textContent = d.off_today.length
    ? `Off today: ${d.off_today.join(", ")}`
    : "Nobody off today.";

  const pendingCount = document.getElementById("dashPendingCount");
  const pendingList = document.getElementById("dashPendingList");
  pendingCount.textContent = d.pending_leave.length ? `${d.pending_leave.length} pending` : "all clear";
  pendingCount.classList.toggle("bg-amber-50", d.pending_leave.length > 0);
  pendingCount.classList.toggle("text-amber-700", d.pending_leave.length > 0);
  pendingCount.classList.toggle("border-amber-200", d.pending_leave.length > 0);
  pendingCount.classList.toggle("bg-green-50", d.pending_leave.length === 0);
  pendingCount.classList.toggle("text-brand-green", d.pending_leave.length === 0);
  pendingCount.classList.toggle("border-green-200", d.pending_leave.length === 0);

  pendingList.innerHTML = d.pending_leave.length
    ? d.pending_leave
        .map((r, i) => {
          const dt = new Date(`${r.date}T00:00:00`);
          const when = dt.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
          return `
        <li class="flex items-center justify-between gap-2 ${i ? "border-t border-gray-100 pt-2.5" : ""}">
          <div class="min-w-0">
            <p class="text-sm font-medium truncate">${escapeHtml(r.name)} · ${escapeHtml(r.leave_type)}</p>
            <p class="text-xs text-gray-500 truncate">${when}${r.reason ? ` · “${escapeHtml(r.reason)}”` : ""}</p>
          </div>
          <div class="shrink-0">${
            d.can_decide
              ? `<button class="dash-approve text-[11px] font-semibold bg-brand-green text-black rounded-md px-2.5 py-1" data-id="${r.id}">Approve</button>
                 <button class="dash-deny text-[11px] font-semibold bg-white text-red-600 border border-red-200 rounded-md px-2.5 py-1 ml-1" data-id="${r.id}">Deny</button>`
              : `<span class="text-[11px] text-gray-400">awaiting a manager</span>`
          }</div>
        </li>`;
        })
        .join("")
    : `<li class="text-sm text-gray-400 italic">No requests waiting.</li>`;

  pendingList.querySelectorAll(".dash-approve").forEach((b) =>
    b.addEventListener("click", async () => {
      await decideLeave(b.dataset.id, "approved");
      loadDashboard();
    })
  );
  pendingList.querySelectorAll(".dash-deny").forEach((b) =>
    b.addEventListener("click", async () => {
      await decideLeave(b.dataset.id, "denied");
      loadDashboard();
    })
  );

  // no cutoff figures in the payload at all for a viewer without payroll
  // access - hide the whole card rather than render an empty one
  const cutoffCard = document.getElementById("dashCutoffCard");
  cutoffCard.style.display = d.cutoff ? "block" : "none";
  if (!d.cutoff) {
    renderAttentionAndSummary(d);
    return;
  }

  const c = d.cutoff;
  const fmt = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  document.getElementById("dashCutoffPeriod").textContent =
    `${fmt(c.start)} – ${fmt(c.end)} · pay date ${fmt(c.pay_date)}`;
  document.getElementById("dashCutoffNet").textContent = formatMoney(c.net_total);
  document.getElementById("dashCutoffDot").className =
    `w-2 h-2 rounded-full ${c.saved ? "bg-brand-green" : "bg-amber-400"}`;
  document.getElementById("dashCutoffStatus").textContent =
    `${c.saved ? "Saved" : "Not saved yet"} · ${c.days_left} day${c.days_left === 1 ? "" : "s"} left in cutoff`;

  renderAttentionAndSummary(d);
}

function renderAttentionAndSummary(d) {
  const attention = document.getElementById("dashAttention");
  attention.innerHTML = d.attention.length
    ? d.attention
        .map((a) => `<li class="flex items-start gap-2">${ATTENTION_ICON[a.tone] || ""}<span>${escapeHtml(a.text)}</span></li>`)
        .join("")
    : `<li class="text-gray-400 italic">Nothing to flag.</li>`;

  document.getElementById("dashSummary").innerHTML = d.roster
    .map((s) => {
      const count = d.days_by_name[s.name] ?? 0;
      const over = s.target && count > s.target + 1;
      return `
      <div class="bg-white border border-gray-200 rounded-xl px-4 py-3.5 shadow-sm">
        <p class="font-display font-semibold text-base leading-tight mb-0.5">${escapeHtml(s.name)}</p>
        <p class="text-[11px] text-gray-500 mb-2.5">${escapeHtml(s.role)}</p>
        <span class="font-mono text-xl font-medium ${over ? "text-amber-600" : "text-brand-blue"}">${count}</span>
        <span class="text-[11px] text-gray-500 ml-1">days${s.target ? ` / ${s.target} target` : ""}</span>
      </div>`;
    })
    .join("");
}

function renderStaffDashboard(s) {
  const next = document.getElementById("dashNextShift");
  next.innerHTML = s.next_shift
    ? `<p class="text-[10px] uppercase tracking-wide text-white/60 font-mono mb-1">Your next shift</p>
       <p class="font-display font-semibold text-xl leading-tight">${escapeHtml(s.next_shift.when)} · ${escapeHtml(s.next_shift.label)}</p>
       <p class="font-mono text-sm text-white/80 mt-0.5">${escapeHtml(s.next_shift.time_range || "")}</p>`
    : `<p class="text-[10px] uppercase tracking-wide text-white/60 font-mono mb-1">Your next shift</p>
       <p class="font-display font-semibold text-lg leading-tight">Nothing in the next 7 days</p>`;

  document.getElementById("dashMyDays").textContent = s.days_worked;
  document.getElementById("dashMyTarget").textContent = s.target ? `days / ${s.target} target` : "days";
  document.getElementById("dashMyPto").textContent = s.pto_available;
  document.getElementById("dashMyPtoTotal").textContent = `of ${s.pto_entitlement} left`;

  document.getElementById("dashUpcoming").innerHTML = s.upcoming
    .map(
      (u) => `
      <li class="flex items-center gap-4 py-2">
        <span class="font-mono text-xs text-gray-400 w-24 shrink-0">${u.weekday_short} ${u.day_num} ${u.month_short}</span>
        ${miniChip(u.label, u.time_range)}
      </li>`
    )
    .join("");
}

async function loadDashboard() {
  const res = await fetch("/api/dashboard");
  if (!res.ok) return;
  const data = await res.json();

  // Greeting uses the viewer's own clock, not the server's - Fly runs UTC
  // and "good evening" in Manila would land eight hours out.
  const hour = new Date().getHours();
  const partOfDay = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const firstName = (CURRENT_USER.display_name || "").split(" ")[0];
  document.getElementById("dashGreeting").textContent =
    firstName ? `Good ${partOfDay}, ${firstName}` : `Good ${partOfDay}`;
  document.getElementById("dashboardDate").textContent = data.today_label;
  const managerBlock = document.getElementById("dashManager");
  const staffBlock = document.getElementById("dashStaff");

  managerBlock.style.display = data.manager ? "block" : "none";
  staffBlock.style.display = data.staff ? "block" : "none";
  if (data.manager) renderManagerDashboard(data.manager);
  if (data.staff) renderStaffDashboard(data.staff);
}

const dashOpenSchedule = document.getElementById("dashOpenSchedule");
if (dashOpenSchedule) dashOpenSchedule.addEventListener("click", () => showTab("schedule"));
const dashRequestLeave = document.getElementById("dashRequestLeave");
if (dashRequestLeave) dashRequestLeave.addEventListener("click", () => showTab("leave"));
const dashTeamSchedule = document.getElementById("dashTeamSchedule");
if (dashTeamSchedule) dashTeamSchedule.addEventListener("click", () => showTab("schedule"));
const dashMyPay = document.getElementById("dashMyPay");
if (dashMyPay) dashMyPay.addEventListener("click", () => showTab("mypay"));

// ---------------------------------------------------------------------------
// My Details (a staff member's own record; contact, IDs and bank are
// theirs to correct, the rest is read-only)
// ---------------------------------------------------------------------------
const myInfoPtoYear = document.getElementById("myInfoPtoYear");
const myInfoEditBtn = document.getElementById("myInfoEditBtn");
const myInfoSaveBtn = document.getElementById("myInfoSaveBtn");
const myInfoCancelBtn = document.getElementById("myInfoCancelBtn");
const myInfoStatus = document.getElementById("myInfoStatus");

let myInfoEditing = false;
let myInfoData = null; // last loaded record, so Cancel can put it back

// definition list rows; blank values read "—" rather than vanishing, so a
// missing bank account is visibly missing rather than silently absent
function infoRows(pairs) {
  return pairs
    .map(
      ([label, value]) => `
      <div class="flex items-baseline justify-between gap-4 py-1.5">
        <dt class="text-gray-500 shrink-0">${escapeHtml(label)}</dt>
        <dd class="text-right ${value ? "" : "text-gray-300"}">${value ? escapeHtml(String(value)) : "—"}</dd>
      </div>`
    )
    .join("");
}

// same shape as infoRows, but the fields the employee owns become inputs.
// Rows that aren't theirs to change stay plain text in edit mode, so the
// card doesn't reshuffle when you click Edit.
function editRows(rows) {
  return rows
    .map(([label, field, value, type]) => {
      const cell = field
        ? `<input data-myinfo-field="${field}" type="${type || "text"}"
                  value="${escapeHtml(value == null ? "" : String(value))}"
                  class="w-full sm:w-56 text-sm text-right border border-gray-300 rounded-md px-2 py-1
                         focus:outline-none focus:ring-1 focus:ring-brand-blue" />`
        : `<span class="${value ? "" : "text-gray-300"}">${value ? escapeHtml(String(value)) : "—"}</span>`;
      return `
      <div class="flex items-center justify-between gap-4 py-1.5">
        <dt class="text-gray-500 shrink-0">${escapeHtml(label)}</dt>
        <dd class="text-right">${cell}</dd>
      </div>`;
    })
    .join("");
}

function renderMyDetails(d, pto) {
  const initial = (d.full_name || d.name || "?").trim().charAt(0).toUpperCase();
  document.getElementById("myInfoPhoto").innerHTML = d.photo_filename
    ? `<img class="w-full h-full object-cover" src="/static/uploads/${escapeHtml(d.photo_filename)}" alt="" />`
    : `<span class="text-xl font-semibold text-gray-400">${escapeHtml(initial)}</span>`;
  document.getElementById("myInfoName").textContent = d.full_name || d.name;
  document.getElementById("myInfoRole").textContent = [d.role, d.employment].filter(Boolean).join(" · ");

  const rate = d.monthly_salary
    ? `${formatMoney(d.monthly_salary)} / month`
    : d.daily_rate
    ? `${formatMoney(d.daily_rate)} / day`
    : "";
  const basic = [
    ["Employment", null, d.employment],
    ["Pay rate", null, rate],
    ["Birthday", "birthday", d.birthday, "date"],
    ["Phone", "phone", d.phone, "tel"],
    ["Email", "email", d.email, "email"],
    ["Address", "address", d.address],
  ];
  const gov = [
    ["SSS no.", "sss_id", d.sss_id],
    ["SSS amount", null, d.default_sss ? formatMoney(d.default_sss) : ""],
    ["Pag-IBIG no.", "pagibig_id", d.pagibig_id],
    ["Pag-IBIG amount", null, d.default_pagibig ? formatMoney(d.default_pagibig) : ""],
    ["PhilHealth no.", "philhealth_id", d.philhealth_id],
    ["PhilHealth amount", null, d.default_philhealth ? formatMoney(d.default_philhealth) : ""],
    ["HMO no.", "hmo_id", d.hmo_id],
    ["HMO amount", null, d.default_hmo ? formatMoney(d.default_hmo) : ""],
  ];
  const bank = [
    ["Bank", "bank_name", d.bank_name],
    ["Account name", "bank_account_name", d.bank_account_name],
    ["Account number", "bank_account_number", d.bank_account_number],
  ];

  const render = myInfoEditing
    ? (rows) => editRows(rows)
    : (rows) => infoRows(rows.map(([label, , value]) => [label, value]));
  document.getElementById("myInfoBasic").innerHTML = render(basic);
  document.getElementById("myInfoGov").innerHTML = render(gov);
  document.getElementById("myInfoBank").innerHTML = render(bank);

  const availableClass = pto.available <= 0 ? "text-red-600" : "text-brand-blue";
  document.getElementById("myInfoPtoSummary").innerHTML =
    `<span class="${availableClass} font-semibold">${pto.available}</span> of ${pto.entitlement} available ` +
    `<span class="text-gray-400">(${pto.used_count} used in ${pto.year})</span>`;

  const datesEl = document.getElementById("myInfoPtoDates");
  datesEl.innerHTML = pto.used_dates.length
    ? `<ul class="text-xs divide-y divide-gray-100 border border-gray-200 rounded-md">${pto.used_dates
        .map((iso) => {
          const dt = new Date(`${iso}T00:00:00`);
          return `<li class="px-2 py-1.5 flex justify-between">
                    <span class="font-mono">${dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span>
                    <span class="text-gray-500">${dt.toLocaleDateString(undefined, { weekday: "short" })}</span>
                  </li>`;
        })
        .join("")}</ul>`
    : `<p class="text-xs text-gray-400 italic">No Paid Time Off used in ${pto.year}.</p>`;
}

async function loadMyDetails() {
  const res = await fetch(`/api/staff/me?year=${myInfoPtoYear.value || new Date().getFullYear()}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    document.getElementById("myInfoName").textContent = err.message || "Could not load your details.";
    return;
  }
  const data = await res.json();
  myInfoData = data;
  renderMyDetails(data.details, data.pto);
}

function setMyInfoEditing(on) {
  myInfoEditing = on;
  myInfoEditBtn.classList.toggle("hidden", on);
  myInfoSaveBtn.classList.toggle("hidden", !on);
  myInfoCancelBtn.classList.toggle("hidden", !on);
  myInfoStatus.textContent = "";
  if (myInfoData) renderMyDetails(myInfoData.details, myInfoData.pto);
}

async function saveMyDetails() {
  const payload = {};
  document.querySelectorAll("[data-myinfo-field]").forEach((el) => {
    payload[el.dataset.myinfoField] = el.value.trim();
  });

  myInfoSaveBtn.disabled = true;
  myInfoStatus.textContent = "Saving…";
  const res = await fetch("/api/staff/me", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  myInfoSaveBtn.disabled = false;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    myInfoStatus.textContent = "";
    alert(data.message || "Could not save your details.");
    return;
  }
  // reload rather than trusting the payload: the server is what decides
  // which fields it actually accepted
  await loadMyDetails();
  setMyInfoEditing(false);
  myInfoStatus.textContent = data.changed && data.changed.length ? "Saved." : "No changes.";
  setTimeout(() => (myInfoStatus.textContent = ""), 3000);
}

if (myInfoEditBtn) {
  myInfoEditBtn.addEventListener("click", () => setMyInfoEditing(true));
  myInfoCancelBtn.addEventListener("click", () => setMyInfoEditing(false));
  myInfoSaveBtn.addEventListener("click", saveMyDetails);
}

if (myInfoPtoYear) {
  const thisYear = new Date().getFullYear();
  for (let y = thisYear; y >= thisYear - 2; y--) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    myInfoPtoYear.appendChild(opt);
  }
  myInfoPtoYear.addEventListener("change", loadMyDetails);
}

// ---------------------------------------------------------------------------
// My Pay (a staff member's own payslip)
// ---------------------------------------------------------------------------
const myPayMonth = document.getElementById("myPayMonth");
const myPayYear = document.getElementById("myPayYear");
let myPayPayday = 10;

function initMyPay() {
  MONTH_NAMES.forEach((name, i) => {
    const opt = document.createElement("option");
    opt.value = i + 1;
    opt.textContent = name;
    myPayMonth.appendChild(opt);
  });
  const currentYear = new Date().getFullYear();
  for (let y = currentYear; y >= currentYear - 2; y--) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    myPayYear.appendChild(opt);
  }

  // default to the cutoff we're currently inside, same rule as Payroll
  const def = defaultPayrollPeriod();
  myPayMonth.value = def.month;
  myPayYear.value = def.year;
  myPayPayday = def.payday;

  myPayMonth.addEventListener("change", loadMyPay);
  myPayYear.addEventListener("change", loadMyPay);
  document.getElementById("myPay10Btn").addEventListener("click", () => {
    myPayPayday = 10;
    loadMyPay();
  });
  document.getElementById("myPay25Btn").addEventListener("click", () => {
    myPayPayday = 25;
    loadMyPay();
  });
}

function renderMyPaydayButtons() {
  [["myPay10Btn", 10], ["myPay25Btn", 25]].forEach(([id, value]) => {
    const btn = document.getElementById(id);
    const active = myPayPayday === value;
    btn.classList.toggle("bg-brand-blue", active);
    btn.classList.toggle("text-white", active);
    btn.classList.toggle("text-gray-600", !active);
  });
}

async function loadMyPay() {
  renderMyPaydayButtons();
  const res = await fetch(
    `/api/payroll/mine?year=${myPayYear.value}&month=${myPayMonth.value}&payday=${myPayPayday}`
  );
  const linesEl = document.getElementById("myPayLines");
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    linesEl.innerHTML = `<li class="py-2 text-gray-500">${escapeHtml(err.message || "Could not load your payslip.")}</li>`;
    document.getElementById("myPayNet").textContent = "—";
    return;
  }
  const data = await res.json();
  const p = data.row;

  const fmt = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  document.getElementById("myPayName").textContent = p.full_name;
  document.getElementById("myPayPeriod").textContent =
    `${fmt(data.period_start)} – ${fmt(data.period_end)} · paid ${fmt(data.pay_date)}`;

  const statusEl = document.getElementById("myPayStatus");
  statusEl.innerHTML = data.final
    ? `<span class="text-brand-green font-medium">● Final</span> <span class="text-gray-500">— this cutoff has been closed.</span>`
    : `<span class="text-amber-600 font-medium">● Running total</span> <span class="text-gray-500">— this cutoff isn't closed yet, so figures can still change.</span>`;

  // earnings first, then deductions, matching the printed payslip
  const lines = [];
  if (p.monthly_salary) {
    lines.push(["Monthly salary", formatMoney(p.monthly_salary), false]);
    lines.push(["Base pay (half-month)", formatMoney(p.base_pay), false]);
  } else {
    lines.push([`Days worked (× ${formatMoney(p.daily_rate)})`, String(p.days_worked), false]);
    lines.push(["Base pay", formatMoney(p.base_pay), false]);
  }
  if (p.has_bonus) lines.push(["Cup bonus", formatMoney(p.bonus), false]);
  if (p.manual_bonus) lines.push(["Bonus", formatMoney(p.manual_bonus), false]);
  if (p.ot_hours) lines.push([`Overtime (${p.ot_hours} h × ${formatMoney(data.ot_rate)})`, formatMoney(p.ot_pay), false]);

  // undertime keeps its own line rather than being netted off the overtime
  // above - Art. 88 forbids offsetting one against the other
  if (p.undertime_hours) {
    lines.push([
      `Undertime (${p.undertime_hours} h × ${formatMoney(p.undertime_rate)})`,
      `−${formatMoney(p.undertime_deduction)}`,
      true,
    ]);
  }

  [["SSS", p.sss], ["Pag-IBIG", p.pagibig], ["PhilHealth", p.philhealth], ["HMO", p.hmo],
   ["Printing errors", p.error_deduction], ["Absence deduction", p.absence_deduction]].forEach(
    ([label, value]) => {
      if (value) lines.push([label, `−${formatMoney(value)}`, true]);
    }
  );
  if (p.cash_advance) {
    const left = p.advance_outstanding_after;
    lines.push([
      `Cash advance${left ? ` (${formatMoney(left)} left after this)` : " (cleared)"}`,
      `−${formatMoney(p.cash_advance)}`,
      true,
    ]);
  }

  linesEl.innerHTML = lines
    .map(
      ([label, value, isDeduction]) => `
      <li class="flex items-baseline justify-between gap-4 py-1.5">
        <span class="${isDeduction ? "text-gray-500" : "text-black"}">${escapeHtml(label)}</span>
        <span class="font-mono whitespace-nowrap ${isDeduction ? "text-red-600" : "text-black"}">${escapeHtml(value)}</span>
      </li>`
    )
    .join("");
  document.getElementById("myPayNet").textContent = formatMoney(p.net_pay);
}

if (myPayMonth) initMyPay();

// ---------------------------------------------------------------------------
// Admin (outside accounts)
// ---------------------------------------------------------------------------
const adminUserList = document.getElementById("adminUserList");
const addAdminUserBtn = document.getElementById("addAdminUserBtn");
const addAdminUserForm = document.getElementById("addAdminUserForm");
const newAdminStatus = document.getElementById("newAdminStatus");

async function loadAdminUsers() {
  const res = await fetch("/api/admin/users");
  if (!res.ok) return;
  const { users } = await res.json();

  if (!users.length) {
    adminUserList.innerHTML = `<p class="text-sm text-gray-400 italic bg-white border border-gray-200 rounded-xl p-5">Nobody added yet.</p>`;
    return;
  }

  adminUserList.innerHTML = users
    .map(
      (u) => `
      <div class="bg-white border border-gray-200 rounded-xl p-5 shadow-sm mb-3" data-id="${u.id}">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <p class="font-display font-semibold text-base leading-tight">${escapeHtml(u.display_name)}</p>
            <p class="text-xs text-gray-500 mt-0.5">
              ${escapeHtml(u.note || "Outside viewer")}
              ${u.locked ? '<span class="ml-1 text-red-600">· locked out</span>' : ""}
              ${u.has_pin ? "" : '<span class="ml-1 text-amber-600">· no PIN set</span>'}
            </p>
          </div>
          <div class="flex items-center gap-4 flex-wrap text-sm">
            <label class="inline-flex items-center gap-2">
              <input type="checkbox" class="admin-enabled rounded border-gray-300 text-brand-blue focus:ring-brand-blue" ${u.login_enabled ? "checked" : ""} />
              Can log in
            </label>
            <label class="inline-flex items-center gap-2">
              <input type="checkbox" class="admin-payroll rounded border-gray-300 text-brand-blue focus:ring-brand-blue" ${u.can_view_payroll ? "checked" : ""} />
              Can view payroll
            </label>
          </div>
        </div>
        <div class="flex items-center gap-2 mt-4 flex-wrap">
          <input type="password" class="admin-pin w-40 border border-gray-300 rounded-md px-2 py-1.5 text-sm font-mono" placeholder="Reset PIN" />
          <button class="admin-save text-xs bg-brand-blue text-white font-semibold rounded-md px-3 py-1.5 hover:brightness-110 transition">Save</button>
          <button class="admin-delete text-xs text-red-600 border border-red-200 rounded-md px-3 py-1.5 hover:bg-red-50 transition">Remove</button>
          <span class="admin-status text-xs text-gray-500"></span>
        </div>
      </div>`
    )
    .join("");

  adminUserList.querySelectorAll("[data-id]").forEach((card) => {
    const id = card.dataset.id;
    const statusEl = card.querySelector(".admin-status");

    card.querySelector(".admin-save").addEventListener("click", async () => {
      statusEl.textContent = "Saving…";
      const pin = card.querySelector(".admin-pin").value;
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          login_enabled: card.querySelector(".admin-enabled").checked,
          can_view_payroll: card.querySelector(".admin-payroll").checked,
          ...(pin ? { pin } : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        statusEl.textContent = data.message || "Could not save.";
        return;
      }
      await loadAdminUsers();
    });

    card.querySelector(".admin-delete").addEventListener("click", async () => {
      const name = card.querySelector(".font-display").textContent.trim();
      if (!window.confirm(`Remove ${name}'s access?\n\nTheir login is deleted. Anything they did stays in the Activity log.`)) return;
      const res = await fetch(`/api/admin/users/${id}`, { method: "DELETE" });
      if (!res.ok) {
        alert("Could not remove that account.");
        return;
      }
      await loadAdminUsers();
    });
  });
}

if (addAdminUserBtn) {
  addAdminUserBtn.addEventListener("click", () => {
    const opening = addAdminUserForm.style.display === "none";
    addAdminUserForm.style.display = opening ? "block" : "none";
    if (opening) document.getElementById("newAdminName").focus();
  });

  document.getElementById("cancelNewAdminBtn").addEventListener("click", () => {
    addAdminUserForm.style.display = "none";
    newAdminStatus.textContent = "";
  });

  document.getElementById("saveNewAdminBtn").addEventListener("click", async () => {
    const btn = document.getElementById("saveNewAdminBtn");
    btn.disabled = true;
    newAdminStatus.textContent = "Adding…";
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: document.getElementById("newAdminName").value,
          pin: document.getElementById("newAdminPin").value,
          note: document.getElementById("newAdminNote").value,
          can_view_payroll: document.getElementById("newAdminPayroll").checked,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        newAdminStatus.textContent = data.message || "Could not add that person.";
        return;
      }
      ["newAdminName", "newAdminPin", "newAdminNote"].forEach((id) => (document.getElementById(id).value = ""));
      document.getElementById("newAdminPayroll").checked = false;
      addAdminUserForm.style.display = "none";
      newAdminStatus.textContent = "";
      await loadAdminUsers();
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Activity (audit log)
// ---------------------------------------------------------------------------
const activityList = document.getElementById("activityList");
const activitySearch = document.getElementById("activitySearch");
const activityActor = document.getElementById("activityActor");

// Actions that move money or access get a stronger colour - those are the
// ones you scan for when something looks wrong.
const ACTION_TONE = {
  "Saved payroll": "bg-blue-50 text-brand-blue border-blue-200",
  "Updated employee": "bg-blue-50 text-brand-blue border-blue-200",
  "Updated own details": "bg-blue-50 text-brand-blue border-blue-200",
  "Created print order": "bg-blue-50 text-brand-blue border-blue-200",
  "Updated print order": "bg-blue-50 text-brand-blue border-blue-200",
  "Updated print line": "bg-blue-50 text-brand-blue border-blue-200",
  "Updated print client": "bg-blue-50 text-brand-blue border-blue-200",
  "Deleted print order": "bg-red-50 text-red-600 border-red-200",
  "Recorded cash advance": "bg-blue-50 text-brand-blue border-blue-200",
  "Deleted cash advance": "bg-red-50 text-red-600 border-red-200",
  "Archived employee": "bg-red-50 text-red-600 border-red-200",
  "Changed login access": "bg-amber-50 text-amber-700 border-amber-200",
  "Changed own PIN": "bg-amber-50 text-amber-700 border-amber-200",
};

function formatAuditValue(v) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function auditDetailsHtml(details) {
  if (!details || typeof details !== "object") return "";

  // {field: {from, to}} renders as a change list; anything else as plain pairs
  const rows = Object.entries(details).map(([key, value]) => {
    if (value && typeof value === "object" && "from" in value && "to" in value) {
      return `<li><span class="text-gray-500">${escapeHtml(key)}</span>
                <span class="font-mono text-gray-400 line-through">${escapeHtml(formatAuditValue(value.from))}</span>
                <span class="text-gray-400">→</span>
                <span class="font-mono text-black">${escapeHtml(formatAuditValue(value.to))}</span></li>`;
    }
    if (value && typeof value === "object") {
      const inner = Object.entries(value)
        .map(([k2, v2]) => {
          if (v2 && typeof v2 === "object" && "from" in v2 && "to" in v2) {
            return `${escapeHtml(k2)}: <span class="font-mono text-gray-400 line-through">${escapeHtml(formatAuditValue(v2.from))}</span> → <span class="font-mono text-black">${escapeHtml(formatAuditValue(v2.to))}</span>`;
          }
          return `${escapeHtml(k2)}: <span class="font-mono">${escapeHtml(formatAuditValue(v2))}</span>`;
        })
        .join("; ");
      return `<li><span class="text-gray-500">${escapeHtml(key)}</span> — ${inner}</li>`;
    }
    return `<li><span class="text-gray-500">${escapeHtml(key)}</span> <span class="font-mono text-black">${escapeHtml(formatAuditValue(value))}</span></li>`;
  });

  return rows.length ? `<ul class="mt-1.5 space-y-0.5 text-xs">${rows.join("")}</ul>` : "";
}

async function loadActivity() {
  const params = new URLSearchParams();
  if (activitySearch.value.trim()) params.set("q", activitySearch.value.trim());
  if (activityActor.value) params.set("actor", activityActor.value);

  const res = await fetch(`/api/audit-log?${params}`);
  if (!res.ok) return;
  const data = await res.json();

  const selected = activityActor.value;
  activityActor.innerHTML =
    `<option value="">Everyone</option>` +
    data.actors.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join("");
  activityActor.value = selected;

  if (!data.entries.length) {
    activityList.innerHTML = `<p class="text-sm text-gray-400 italic p-5">Nothing recorded yet.</p>`;
    return;
  }

  activityList.innerHTML = data.entries
    .map((e) => {
      const when = new Date(e.at).toLocaleString(undefined, {
        month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
      });
      const tone = ACTION_TONE[e.action] || "bg-gray-50 text-gray-600 border-gray-200";
      return `
        <div class="p-4">
          <div class="flex items-baseline gap-2 flex-wrap">
            <span class="text-[11px] rounded-full border px-2 py-0.5 ${tone}">${escapeHtml(e.action)}</span>
            ${e.target ? `<span class="text-sm font-medium">${escapeHtml(e.target)}</span>` : ""}
            <span class="text-xs text-gray-400 ml-auto whitespace-nowrap">${escapeHtml(e.actor)} · ${when}</span>
          </div>
          ${auditDetailsHtml(e.details)}
        </div>`;
    })
    .join("");
}

if (activitySearch) {
  let searchTimer;
  activitySearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadActivity, 250);
  });
  activityActor.addEventListener("change", loadActivity);
}

// ---------------------------------------------------------------------------
// Time off (leave requests)
// ---------------------------------------------------------------------------
const leaveStaffPickerWrap = document.getElementById("leaveStaffPickerWrap");
const leaveStaffSelect = document.getElementById("leaveStaffSelect");
const leaveStartInput = document.getElementById("leaveStartInput");
const leaveEndInput = document.getElementById("leaveEndInput");
const leaveTypeSelect = document.getElementById("leaveTypeSelect");
const leaveReasonInput = document.getElementById("leaveReasonInput");
const submitLeaveBtn = document.getElementById("submitLeaveBtn");
const leaveSubmitStatus = document.getElementById("leaveSubmitStatus");
const leaveBalanceLine = document.getElementById("leaveBalanceLine");
const leaveListTitle = document.getElementById("leaveListTitle");
const leaveStatusFilter = document.getElementById("leaveStatusFilter");
const leaveRequestsWrap = document.getElementById("leaveRequestsWrap");
const pendingLeaveBadge = document.getElementById("pendingLeaveBadge");

const STATUS_BADGE = {
  pending: "bg-amber-50 text-amber-700 border border-amber-200",
  approved: "bg-green-50 text-brand-green border border-green-200",
  denied: "bg-red-50 text-red-600 border border-red-200",
};

// Who the request form is currently filing for: the logged-in staff
// member, or whoever a manager picked from the dropdown.
function leaveSubjectName() {
  return leaveStaffSelect && leaveStaffSelect.value ? leaveStaffSelect.value : CURRENT_USER.staff_name;
}

async function initLeaveTab() {
  const today = isoDate(new Date());
  leaveStartInput.min = today;
  leaveEndInput.min = today;
  leaveStartInput.value = today;
  leaveEndInput.value = today;

  // The superuser isn't a staff member, so he can only file on someone's
  // behalf - the picker is the only way for him to use this form at all.
  if (IS_MANAGER) {
    leaveStaffPickerWrap.style.display = "block";
    const res = await fetch("/api/staff");
    if (res.ok) {
      const data = await res.json();
      leaveStaffSelect.innerHTML = data.staff
        .map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.full_name || s.name)}</option>`)
        .join("");
      if (CURRENT_USER.staff_name) leaveStaffSelect.value = CURRENT_USER.staff_name;
    }
    leaveStaffSelect.addEventListener("change", loadLeaveBalance);
    leaveListTitle.textContent = "All requests";
  }

  leaveStartInput.addEventListener("change", () => {
    if (leaveEndInput.value < leaveStartInput.value) leaveEndInput.value = leaveStartInput.value;
    leaveEndInput.min = leaveStartInput.value;
  });
  leaveTypeSelect.addEventListener("change", loadLeaveBalance);
  leaveStatusFilter.addEventListener("change", loadLeaveRequests);
  submitLeaveBtn.addEventListener("click", submitLeaveRequest);

  loadLeaveBalance();
  loadLeaveRequests();
}

async function loadLeaveBalance() {
  const name = leaveSubjectName();
  if (!name) {
    leaveBalanceLine.textContent = "Pick a staff member to file for.";
    return;
  }
  // read the year off the ISO string rather than via Date, which would
  // parse "2026-01-01" as UTC midnight and can land in the prior year
  const year = (leaveStartInput.value || isoDate(new Date())).slice(0, 4);
  const res = await fetch(`/api/staff/${encodeURIComponent(name)}/pto?year=${year}`);
  if (!res.ok) {
    leaveBalanceLine.textContent = "";
    return;
  }
  const data = await res.json();
  leaveBalanceLine.innerHTML =
    `<span class="${data.available <= 0 ? "text-red-600" : "text-brand-blue"} font-semibold">${data.available}</span> ` +
    `of ${data.entitlement} Paid Time Off day(s) left for ${data.year}.`;
}

function isoDate(d) {
  // local calendar date, not toISOString() - that converts to UTC and in
  // UTC+8 would report the previous day for anything before 8am
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function eachDateBetween(startIso, endIso) {
  const dates = [];
  const end = new Date(`${endIso}T00:00:00`);
  for (let d = new Date(`${startIso}T00:00:00`); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(isoDate(d));
  }
  return dates;
}

async function submitLeaveRequest() {
  const name = leaveSubjectName();
  if (!name) {
    leaveSubmitStatus.textContent = "Pick a staff member first.";
    return;
  }
  const start = leaveStartInput.value;
  const end = leaveEndInput.value || start;
  if (!start) {
    leaveSubmitStatus.textContent = "Pick a start date.";
    return;
  }
  if (end < start) {
    leaveSubmitStatus.textContent = "The end date is before the start date.";
    return;
  }

  const dates = eachDateBetween(start, end);
  submitLeaveBtn.disabled = true;
  leaveSubmitStatus.textContent = "Submitting…";
  try {
    const res = await fetch("/api/leave/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, dates, leave_type: leaveTypeSelect.value, reason: leaveReasonInput.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      leaveSubmitStatus.textContent = data.message || "Could not submit.";
      return;
    }
    leaveReasonInput.value = "";
    leaveSubmitStatus.textContent = `Submitted ${data.created} day(s).`;
    setTimeout(() => (leaveSubmitStatus.textContent = ""), 4000);
    await Promise.all([loadLeaveRequests(), loadLeaveBalance()]);
  } finally {
    submitLeaveBtn.disabled = false;
  }
}

function leaveRowHtml(r, canDecide) {
  const dt = new Date(`${r.date}T00:00:00`);
  const dateLabel = dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const badge = `<span class="text-[11px] rounded-full px-2 py-0.5 ${STATUS_BADGE[r.status] || ""}">${r.status}</span>`;

  let actions = "";
  if (r.status === "pending" && canDecide) {
    actions = `
      <button type="button" class="leave-approve-btn text-[11px] font-semibold bg-brand-green text-black rounded-md px-2.5 py-1 hover:brightness-95" data-id="${r.id}">Approve</button>
      <button type="button" class="leave-deny-btn text-[11px] font-semibold bg-white text-red-600 border border-red-200 rounded-md px-2.5 py-1 hover:bg-red-50 ml-1" data-id="${r.id}">Deny</button>`;
  } else if (r.status === "pending") {
    actions = `<button type="button" class="leave-cancel-btn text-[11px] text-gray-500 underline" data-id="${r.id}">Withdraw</button>`;
  } else if (r.decided_by) {
    actions = `<span class="text-[11px] text-gray-400">by ${escapeHtml(r.decided_by)}</span>`;
  }

  return `
    <tr class="border-t border-gray-100">
      <td class="px-2 py-2 whitespace-nowrap font-mono text-xs">${dateLabel}</td>
      <td class="px-2 py-2 whitespace-nowrap">${escapeHtml(r.full_name || r.name)}</td>
      <td class="px-2 py-2 whitespace-nowrap text-gray-600">${escapeHtml(r.leave_type)}</td>
      <td class="px-2 py-2 text-gray-500 max-w-[220px]">${escapeHtml(r.reason || "—")}</td>
      <td class="px-2 py-2 whitespace-nowrap">${badge}</td>
      <td class="px-2 py-2 whitespace-nowrap text-right">${actions}</td>
    </tr>`;
}

async function loadLeaveRequests() {
  const status = leaveStatusFilter.value;
  const res = await fetch(`/api/leave/requests${status ? `?status=${status}` : ""}`);
  if (!res.ok) return;
  const data = await res.json();

  if (!data.requests.length) {
    leaveRequestsWrap.innerHTML = `<p class="text-sm text-gray-400 italic">No requests${status ? ` with status "${status}"` : ""} yet.</p>`;
  } else {
    leaveRequestsWrap.innerHTML = `
      <table class="w-full text-sm border-collapse min-w-[640px]">
        <thead>
          <tr class="text-left text-[11px] uppercase tracking-wide text-gray-400 font-mono">
            <th class="px-2 py-1.5">Date</th><th class="px-2 py-1.5">Who</th><th class="px-2 py-1.5">Type</th>
            <th class="px-2 py-1.5">Reason</th><th class="px-2 py-1.5">Status</th><th class="px-2 py-1.5"></th>
          </tr>
        </thead>
        <tbody>${data.requests.map((r) => leaveRowHtml(r, data.can_decide)).join("")}</tbody>
      </table>`;
  }

  leaveRequestsWrap.querySelectorAll(".leave-approve-btn").forEach((btn) =>
    btn.addEventListener("click", () => decideLeave(btn.dataset.id, "approved"))
  );
  leaveRequestsWrap.querySelectorAll(".leave-deny-btn").forEach((btn) =>
    btn.addEventListener("click", () => decideLeave(btn.dataset.id, "denied"))
  );
  leaveRequestsWrap.querySelectorAll(".leave-cancel-btn").forEach((btn) =>
    btn.addEventListener("click", () => cancelLeave(btn.dataset.id))
  );

  updatePendingBadge();
}

async function decideLeave(id, decision) {
  const note = decision === "denied" ? window.prompt("Reason for denying (optional):") ?? "" : "";
  const res = await fetch(`/api/leave/request/${id}/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: decision, note }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.message || "Could not record that decision.");
    return;
  }
  await Promise.all([loadLeaveRequests(), loadLeaveBalance(), loadSchedule()]);
}

async function cancelLeave(id) {
  if (!window.confirm("Withdraw this request?")) return;
  const res = await fetch(`/api/leave/request/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.message || "Could not withdraw that request.");
    return;
  }
  await Promise.all([loadLeaveRequests(), loadLeaveBalance()]);
}

async function updatePendingBadge() {
  if (!pendingLeaveBadge) return; // no Time Off tab for outside viewers
  const res = await fetch("/api/leave/requests?status=pending");
  if (!res.ok) return;
  const data = await res.json();
  const count = data.requests.length;
  pendingLeaveBadge.textContent = count;
  pendingLeaveBadge.classList.toggle("hidden", count === 0);
}

updatePendingBadge();

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------
const payrollMonthSelect = document.getElementById("payrollMonthSelect");
const payrollYearSelect = document.getElementById("payrollYearSelect");
const payday10Btn = document.getElementById("payday10Btn");
const payday25Btn = document.getElementById("payday25Btn");
const payrollPeriodLabel = document.getElementById("payrollPeriodLabel");
const cupCountsContainer = document.getElementById("cupCountsContainer");
const cupCountsHint = document.getElementById("cupCountsHint");
const noCupDays = document.getElementById("noCupDays");
const payrollHeadRow = document.getElementById("payrollHeadRow");
const payrollBody = document.getElementById("payrollBody");
const payrollFoot = document.getElementById("payrollFoot");
const payrollTotalNet = document.getElementById("payrollTotalNet");
const savePayrollBtn = document.getElementById("savePayrollBtn");
const downloadPayslipsBtn = document.getElementById("downloadPayslipsBtn");
const payrollSaveStatus = document.getElementById("payrollSaveStatus");

let currentPayday = 10;
let currentOtRate = 50;

function defaultPayrollPeriod() {
  const now = new Date();
  const day = now.getDate();
  let year = now.getFullYear();
  let month = now.getMonth() + 1;
  let payday;
  if (day <= 9) {
    payday = 10;
  } else if (day <= 24) {
    payday = 25;
  } else {
    payday = 10;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return { year, month, payday };
}

function initPayrollSelectors() {
  MONTH_NAMES.forEach((name, i) => {
    const opt = document.createElement("option");
    opt.value = i + 1;
    opt.textContent = name;
    payrollMonthSelect.appendChild(opt);
  });

  const currentYear = new Date().getFullYear();
  for (let y = currentYear - 1; y <= currentYear + 2; y++) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    payrollYearSelect.appendChild(opt);
  }

  const def = defaultPayrollPeriod();
  payrollMonthSelect.value = def.month;
  payrollYearSelect.value = def.year;
  currentPayday = def.payday;
  updatePaydayButtons();
}

function updatePaydayButtons() {
  payday10Btn.classList.toggle("active-payday", currentPayday === 10);
  payday25Btn.classList.toggle("active-payday", currentPayday === 25);
}

function formatMoney(n) {
  const num = Number(n) || 0;
  return `₱${num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDateLabel(iso) {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "2-digit" });
}

async function loadPayroll() {
  const year = payrollYearSelect.value;
  const month = payrollMonthSelect.value;
  const res = await fetch(`/api/payroll?year=${year}&month=${month}&payday=${currentPayday}`);
  const data = await res.json();
  currentOtRate = data.ot_rate || 50;

  const startLabel = new Date(data.period_start + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "2-digit", year: "numeric" });
  const endLabel = new Date(data.period_end + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "2-digit", year: "numeric" });
  const payLabel = new Date(data.pay_date + "T00:00:00").toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
  payrollPeriodLabel.textContent = `Cutoff: ${startLabel} – ${endLabel}  ·  Pay date: ${payLabel}`;

  const quota = data.cup_daily_quota ?? 1000;
  const printerRate = (data.cup_bonus_rate?.Printer ?? 0.15).toFixed(2);
  const checkerRate = (data.cup_bonus_rate?.Checker ?? 0.10).toFixed(2);
  cupCountsHint.textContent =
    `Store-wide printed-cup total for every day in this cutoff, including weekends. ` +
    `The first ${quota.toLocaleString()} cups/day don't qualify for a bonus - only cups above that earn the Printer ` +
    `₱${printerRate}/cup and the Checker ₱${checkerRate}/cup, based on whoever held each role that day.`;

  renderCupCounts(data.cup_counts);
  renderPayrollTable(data.staff);
}

function renderCupCounts(cupRows) {
  if (!cupRows || cupRows.length === 0) {
    cupCountsContainer.innerHTML = "";
    noCupDays.style.display = "block";
    return;
  }
  noCupDays.style.display = "none";

  const table = document.createElement("table");
  table.className = "border-collapse";
  const headRow = document.createElement("tr");
  const qtyRow = document.createElement("tr");

  cupRows.forEach((row) => {
    const weekendClass = row.is_weekend ? "bg-green-50" : "";

    const th = document.createElement("th");
    th.className = `text-[10px] font-mono uppercase tracking-wide text-gray-500 font-medium px-2 py-1 text-left whitespace-nowrap ${weekendClass}`;
    th.innerHTML = `${formatDateLabel(row.date)}<span class="block text-gray-400">${row.weekday_short}</span>`;
    headRow.appendChild(th);

    const td = document.createElement("td");
    td.className = `px-2 py-1 ${weekendClass}`;
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.value = row.quantity;
    input.dataset.date = row.date;
    input.disabled = !IS_SUPERUSER;
    input.className =
      "cup-input w-20 text-sm font-mono border border-gray-300 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-blue disabled:bg-gray-50 disabled:text-gray-500";
    td.appendChild(input);
    qtyRow.appendChild(td);
  });

  table.appendChild(headRow);
  table.appendChild(qtyRow);
  cupCountsContainer.innerHTML = "";
  cupCountsContainer.appendChild(table);
}

function computeRowTotals(row) {
  const otHours = parseFloat(row.querySelector(".ot-hours-input").value) || 0;
  const manualBonus = parseFloat(row.querySelector(".manual-bonus-input").value) || 0;
  const sss = parseFloat(row.querySelector(".sss-input").value) || 0;
  const pagibig = parseFloat(row.querySelector(".pagibig-input").value) || 0;
  const philhealth = parseFloat(row.querySelector(".philhealth-input").value) || 0;
  const hmo = parseFloat(row.querySelector(".hmo-input").value) || 0;
  const errorDed = parseFloat(row.querySelector(".error-deduction-input").value) || 0;
  const cashAdvance = parseFloat(row.querySelector(".cash-advance-input").value) || 0;

  const otPay = otHours * currentOtRate;
  // undertime is docked at this person's own hourly rate, not the flat OT
  // rate, so it rides along on the row rather than a global constant
  const undertimeHours = parseFloat(row.querySelector(".undertime-hours-input").value) || 0;
  const undertimeDed = undertimeHours * (parseFloat(row.dataset.undertimeRate) || 0);
  const absenceDed = parseFloat(row.dataset.absenceDeduction) || 0;
  const totalDeductions =
    sss + pagibig + philhealth + hmo + errorDed + cashAdvance + absenceDed + undertimeDed;
  const basePay = parseFloat(row.dataset.basePay) || 0;
  const bonus = parseFloat(row.dataset.bonus) || 0;
  const netPay = basePay + otPay + bonus + manualBonus - totalDeductions;

  row.querySelector(".ot-pay-cell").textContent = formatMoney(otPay);
  row.querySelector(".undertime-pay-cell").textContent = formatMoney(undertimeDed);
  row.querySelector(".total-deductions-cell").textContent = formatMoney(totalDeductions);
  row.querySelector(".net-pay-cell").textContent = formatMoney(netPay);

  const balanceHint = row.querySelector(".advance-balance");
  if (balanceHint) {
    const owed = parseFloat(row.dataset.advanceOutstanding) || 0;
    if (owed <= 0) {
      balanceHint.textContent = "";
    } else {
      const left = Math.max(0, owed - cashAdvance);
      balanceHint.textContent = `${formatMoney(owed)} owed → ${formatMoney(left)} left`;
      balanceHint.classList.toggle("text-brand-green", left === 0);
      balanceHint.classList.toggle("text-gray-400", left !== 0);
    }
  }
}

function computeGrandTotals() {
  const totals = {
    days: 0, base: 0, bonus: 0, manualBonus: 0, otHours: 0, otPay: 0,
    undertimeHours: 0, undertimeDed: 0,
    sss: 0, pagibig: 0, philhealth: 0, hmo: 0, errorDed: 0, cashAdvance: 0, absenceDed: 0, ded: 0, net: 0,
  };

  Array.from(payrollBody.querySelectorAll("tr")).forEach((row) => {
    const base = parseFloat(row.dataset.basePay) || 0;
    const bonus = parseFloat(row.dataset.bonus) || 0;
    const manualBonus = parseFloat(row.querySelector(".manual-bonus-input").value) || 0;
    const otHours = parseFloat(row.querySelector(".ot-hours-input").value) || 0;
    const sss = parseFloat(row.querySelector(".sss-input").value) || 0;
    const pagibig = parseFloat(row.querySelector(".pagibig-input").value) || 0;
    const philhealth = parseFloat(row.querySelector(".philhealth-input").value) || 0;
    const hmo = parseFloat(row.querySelector(".hmo-input").value) || 0;
    const errorDed = parseFloat(row.querySelector(".error-deduction-input").value) || 0;
    const cashAdvance = parseFloat(row.querySelector(".cash-advance-input").value) || 0;
    const absenceDed = parseFloat(row.dataset.absenceDeduction) || 0;
    const otPay = otHours * currentOtRate;
    const undertimeHours = parseFloat(row.querySelector(".undertime-hours-input").value) || 0;
    const undertimeDed = undertimeHours * (parseFloat(row.dataset.undertimeRate) || 0);
    const ded =
      sss + pagibig + philhealth + hmo + errorDed + cashAdvance + absenceDed + undertimeDed;
    const net = base + otPay + bonus + manualBonus - ded;

    totals.days += parseFloat(row.dataset.days) || 0;
    totals.base += base;
    totals.bonus += bonus;
    totals.manualBonus += manualBonus;
    totals.otHours += otHours;
    totals.otPay += otPay;
    totals.undertimeHours += undertimeHours;
    totals.undertimeDed += undertimeDed;
    totals.sss += sss;
    totals.pagibig += pagibig;
    totals.philhealth += philhealth;
    totals.hmo += hmo;
    totals.errorDed += errorDed;
    totals.cashAdvance += cashAdvance;
    totals.absenceDed += absenceDed;
    totals.ded += ded;
    totals.net += net;
  });

  payrollTotalNet.textContent = formatMoney(totals.net);

  if (!payrollFoot.firstElementChild) return;
  const foot = payrollFoot.firstElementChild;
  foot.querySelector(".totals-days").textContent = totals.days;
  foot.querySelector(".totals-base").textContent = formatMoney(totals.base);
  foot.querySelector(".totals-bonus").textContent = formatMoney(totals.bonus);
  foot.querySelector(".totals-manual-bonus").textContent = formatMoney(totals.manualBonus);
  foot.querySelector(".totals-ot-hours").textContent = totals.otHours;
  foot.querySelector(".totals-ot-pay").textContent = formatMoney(totals.otPay);
  foot.querySelector(".totals-undertime-hours").textContent = totals.undertimeHours;
  foot.querySelector(".totals-undertime-ded").textContent = formatMoney(totals.undertimeDed);
  foot.querySelector(".totals-sss").textContent = formatMoney(totals.sss);
  foot.querySelector(".totals-pagibig").textContent = formatMoney(totals.pagibig);
  foot.querySelector(".totals-philhealth").textContent = formatMoney(totals.philhealth);
  foot.querySelector(".totals-hmo").textContent = formatMoney(totals.hmo);
  foot.querySelector(".totals-error-ded").textContent = formatMoney(totals.errorDed);
  foot.querySelector(".totals-cash-advance").textContent = formatMoney(totals.cashAdvance);
  foot.querySelector(".totals-absence-ded").textContent = formatMoney(totals.absenceDed);
  foot.querySelector(".totals-ded").textContent = formatMoney(totals.ded);
  foot.querySelector(".totals-net").textContent = formatMoney(totals.net);
}

function renderPayrollFooter() {
  payrollFoot.innerHTML = `
    <tr class="bg-blue-50 font-semibold border-t-2 border-brand-blue">
      <td class="px-3 py-3" colspan="2">TOTAL</td>
      <td class="px-3 py-3 font-mono totals-days"></td>
      <td class="px-3 py-3 font-mono totals-base whitespace-nowrap"></td>
      <td class="px-3 py-3 font-mono totals-bonus whitespace-nowrap"></td>
      <td class="px-3 py-3 font-mono totals-manual-bonus whitespace-nowrap"></td>
      <td class="px-3 py-3 font-mono totals-ot-hours"></td>
      <td class="px-3 py-3 font-mono totals-ot-pay whitespace-nowrap"></td>
      <td class="px-3 py-3 font-mono totals-undertime-hours"></td>
      <td class="px-3 py-3 font-mono totals-undertime-ded whitespace-nowrap"></td>
      <td class="px-3 py-3 font-mono totals-sss whitespace-nowrap"></td>
      <td class="px-3 py-3 font-mono totals-pagibig whitespace-nowrap"></td>
      <td class="px-3 py-3 font-mono totals-philhealth whitespace-nowrap"></td>
      <td class="px-3 py-3 font-mono totals-hmo whitespace-nowrap"></td>
      <td class="px-3 py-3 font-mono totals-error-ded whitespace-nowrap"></td>
      <td class="px-3 py-3 font-mono totals-cash-advance whitespace-nowrap"></td>
      <td class="px-3 py-3 font-mono totals-absence-ded whitespace-nowrap"></td>
      <td class="px-3 py-3 font-mono totals-ded whitespace-nowrap"></td>
      <td class="px-3 py-3 font-mono text-brand-blue totals-net whitespace-nowrap"></td>
    </tr>
  `;
}

function renderPayrollTable(staffList) {
  const headers = [
    "Name", "Role", "Days", "Base Pay", "Cup Bonus", "Bonus",
    `OT Hrs`, `OT Pay (×₱${currentOtRate})`, "Undertime Hrs", "Undertime Ded.",
    "SSS", "Pag-IBIG", "PhilHealth", "HMO", "Printing Errors",
    "Cash Advance", "Absence Ded.", "Total Ded.", "Net Pay",
  ];
  payrollHeadRow.innerHTML = headers
    .map((h) => `<th class="text-left text-sm font-mono uppercase tracking-wide font-medium px-3 py-2.5 whitespace-nowrap">${h}</th>`)
    .join("");

  payrollBody.innerHTML = "";
  staffList.forEach((p) => {
    const tr = document.createElement("tr");
    tr.dataset.name = p.name;
    tr.dataset.basePay = p.base_pay;
    tr.dataset.bonus = p.bonus;
    tr.dataset.days = p.days_worked;
    tr.dataset.absenceDeduction = p.absence_deduction;

    const nameTd = document.createElement("td");
    nameTd.className = "px-3 py-2.5 align-top whitespace-nowrap";
    nameTd.innerHTML = `<span class="font-medium">${p.full_name}</span>`;
    tr.appendChild(nameTd);

    const roleTd = document.createElement("td");
    roleTd.className = "px-3 py-2.5 align-top text-gray-500 whitespace-nowrap";
    roleTd.textContent = p.role;
    tr.appendChild(roleTd);

    const daysTd = document.createElement("td");
    daysTd.className = "px-3 py-2.5 align-top font-mono";
    daysTd.textContent = p.days_worked;
    tr.appendChild(daysTd);

    const baseTd = document.createElement("td");
    baseTd.className = "px-3 py-2.5 align-top font-mono whitespace-nowrap";
    baseTd.textContent = formatMoney(p.base_pay);
    tr.appendChild(baseTd);

    const bonusTd = document.createElement("td");
    bonusTd.className = "px-3 py-2.5 align-top font-mono whitespace-nowrap";
    bonusTd.textContent = p.has_bonus ? formatMoney(p.bonus) : "—";
    tr.appendChild(bonusTd);

    // discretionary bonus - hand-entered, available to everyone (unlike
    // the cup bonus above, which only machine operators earn)
    tr.appendChild(inputCell("manual-bonus-input", p.manual_bonus));

    function inputCell(cls, value) {
      const td = document.createElement("td");
      td.className = "px-3 py-2.5 align-top";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "0.01";
      input.value = value;
      input.disabled = !IS_SUPERUSER;
      input.className = `${cls} w-24 text-sm font-mono border border-gray-300 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-blue disabled:bg-gray-50 disabled:text-gray-500`;
      input.addEventListener("input", () => {
        computeRowTotals(tr);
        computeGrandTotals();
      });
      td.appendChild(input);
      return td;
    }

    tr.appendChild(inputCell("ot-hours-input", p.ot_hours));

    const otPayTd = document.createElement("td");
    otPayTd.className = "px-3 py-2.5 align-top font-mono ot-pay-cell whitespace-nowrap";
    otPayTd.textContent = formatMoney(p.ot_pay);
    tr.appendChild(otPayTd);

    // undertime sits next to OT but stays a separate deduction - the two
    // are never netted against each other (Art. 88)
    tr.dataset.undertimeRate = p.undertime_rate || 0;
    tr.appendChild(inputCell("undertime-hours-input", p.undertime_hours));

    const undertimeTd = document.createElement("td");
    undertimeTd.className = "px-3 py-2.5 align-top font-mono undertime-pay-cell whitespace-nowrap";
    undertimeTd.textContent = formatMoney(p.undertime_deduction);
    tr.appendChild(undertimeTd);

    tr.appendChild(inputCell("sss-input", p.sss));
    tr.appendChild(inputCell("pagibig-input", p.pagibig));
    tr.appendChild(inputCell("philhealth-input", p.philhealth));
    tr.appendChild(inputCell("hmo-input", p.hmo));

    tr.appendChild(inputCell("error-deduction-input", p.error_deduction));

    // cash advance: the deduction, with what's still owed underneath so
    // you can see the loan being paid down cutoff by cutoff
    const advanceTd = inputCell("cash-advance-input", p.cash_advance);
    tr.dataset.advanceOutstanding = p.advance_outstanding_before || 0;
    const balanceHint = document.createElement("p");
    balanceHint.className = "advance-balance text-[10px] text-gray-400 mt-0.5 whitespace-nowrap";
    advanceTd.appendChild(balanceHint);
    tr.appendChild(advanceTd);

    const absenceDedTd = document.createElement("td");
    absenceDedTd.className = "px-3 py-2.5 align-top font-mono whitespace-nowrap";
    absenceDedTd.textContent = p.monthly_salary ? formatMoney(p.absence_deduction) : "—";
    tr.appendChild(absenceDedTd);

    const totalDedTd = document.createElement("td");
    totalDedTd.className = "px-3 py-2.5 align-top font-mono total-deductions-cell whitespace-nowrap";
    totalDedTd.textContent = formatMoney(p.total_deductions);
    tr.appendChild(totalDedTd);

    const netTd = document.createElement("td");
    netTd.className = "px-3 py-2.5 align-top font-mono font-semibold text-brand-blue net-pay-cell whitespace-nowrap";
    netTd.textContent = formatMoney(p.net_pay);
    tr.appendChild(netTd);

    payrollBody.appendChild(tr);
    computeRowTotals(tr); // fills the cash-advance balance hint on first paint
  });

  renderPayrollFooter();
  computeGrandTotals();
}

async function savePayrollData() {
  if (!IS_SUPERUSER) return;
  savePayrollBtn.disabled = true;
  const original = savePayrollBtn.textContent;
  savePayrollBtn.textContent = "Saving…";
  payrollSaveStatus.textContent = "";
  try {
    const cupCounts = Array.from(cupCountsContainer.querySelectorAll(".cup-input")).map((input) => ({
      date: input.dataset.date,
      quantity: input.value,
    }));

    const staff = Array.from(payrollBody.querySelectorAll("tr")).map((tr) => ({
      name: tr.dataset.name,
      ot_hours: tr.querySelector(".ot-hours-input").value,
      undertime_hours: tr.querySelector(".undertime-hours-input").value,
      sss: tr.querySelector(".sss-input").value,
      pagibig: tr.querySelector(".pagibig-input").value,
      philhealth: tr.querySelector(".philhealth-input").value,
      hmo: tr.querySelector(".hmo-input").value,
      error_deduction: tr.querySelector(".error-deduction-input").value,
      cash_advance: tr.querySelector(".cash-advance-input").value,
      manual_bonus: tr.querySelector(".manual-bonus-input").value,
    }));

    const year = payrollYearSelect.value;
    const month = payrollMonthSelect.value;
    const { pay_date } = await (await fetch(`/api/payroll?year=${year}&month=${month}&payday=${currentPayday}`)).json();

    const res = await fetch("/api/payroll/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pay_date, cup_counts: cupCounts, staff }),
    });
    if (!res.ok) throw new Error("Save failed");

    await loadPayroll();
    payrollSaveStatus.textContent = "Saved.";
    setTimeout(() => (payrollSaveStatus.textContent = ""), 3000);
  } catch (err) {
    payrollSaveStatus.textContent = "Could not save. Please try again.";
  } finally {
    savePayrollBtn.disabled = !IS_SUPERUSER;
    savePayrollBtn.textContent = original;
  }
}

async function downloadPayslips() {
  if (!IS_SUPERUSER) return;
  downloadPayslipsBtn.disabled = true;
  const original = downloadPayslipsBtn.innerHTML;
  downloadPayslipsBtn.textContent = "Preparing…";
  try {
    const year = payrollYearSelect.value;
    const month = payrollMonthSelect.value;
    const res = await fetch(`/api/payroll/pdf?year=${year}&month=${month}&payday=${currentPayday}`);
    if (!res.ok) throw new Error("PDF generation failed");
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payslips-${year}-${String(month).padStart(2, "0")}-${currentPayday}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  } catch (err) {
    alert("Could not generate the payslips PDF.");
  } finally {
    downloadPayslipsBtn.innerHTML = original;
    downloadPayslipsBtn.disabled = !IS_SUPERUSER;
  }
}

payday10Btn.addEventListener("click", () => {
  currentPayday = 10;
  updatePaydayButtons();
  loadPayroll();
});
payday25Btn.addEventListener("click", () => {
  currentPayday = 25;
  updatePaydayButtons();
  loadPayroll();
});
payrollMonthSelect.addEventListener("change", loadPayroll);
payrollYearSelect.addEventListener("change", loadPayroll);
savePayrollBtn.addEventListener("click", savePayrollData);
downloadPayslipsBtn.addEventListener("click", downloadPayslips);

if (!IS_SUPERUSER) {
  savePayrollBtn.disabled = true;
  savePayrollBtn.title = "Superuser only";
  downloadPayslipsBtn.disabled = true;
  downloadPayslipsBtn.title = "Superuser only";
}

initPayrollSelectors();

// ---------------------------------------------------------------------------
// 13th month pay
// ---------------------------------------------------------------------------
const thirteenthYearSelect = document.getElementById("thirteenthYearSelect");
const thirteenthHeadRow = document.getElementById("thirteenthHeadRow");
const thirteenthBody = document.getElementById("thirteenthBody");
const thirteenthFoot = document.getElementById("thirteenthFoot");
const thirteenthNote = document.getElementById("thirteenthNote");

function initThirteenthSelector() {
  const currentYear = new Date().getFullYear();
  for (let y = currentYear; y >= currentYear - 3; y--) {
    const opt = document.createElement("option");
    opt.value = y;
    opt.textContent = y;
    thirteenthYearSelect.appendChild(opt);
  }
  thirteenthYearSelect.addEventListener("change", loadThirteenthMonth);
}

async function loadThirteenthMonth() {
  const res = await fetch(`/api/payroll/13th-month?year=${thirteenthYearSelect.value}`);
  if (!res.ok) return;
  const data = await res.json();

  thirteenthHeadRow.innerHTML = ["Name", "Role", "Basis", "Basic Salary Earned", "13th Month Pay"]
    .map((h) => `<th class="text-left text-sm font-mono uppercase tracking-wide font-medium px-3 py-2.5 whitespace-nowrap">${h}</th>`)
    .join("");

  let total = 0;
  thirteenthBody.innerHTML = data.staff
    .map((p) => {
      total += p.thirteenth_month;
      // salaried staff earn by the month, so their day count is context
      // rather than the multiplier - show the basis that actually applies
      const basis = p.monthly_salary
        ? `${p.days_worked} d worked · ${formatMoney(p.monthly_salary)}/mo × ${p.months_counted}`
        : `${p.days_worked} d × ${formatMoney(p.daily_rate)}`;
      return `
        <tr>
          <td class="px-3 py-2.5 font-medium whitespace-nowrap">${escapeHtml(p.full_name)}</td>
          <td class="px-3 py-2.5 text-gray-500 whitespace-nowrap">${escapeHtml(p.role)}</td>
          <td class="px-3 py-2.5 font-mono text-gray-500 text-xs whitespace-nowrap">${basis}</td>
          <td class="px-3 py-2.5 font-mono whitespace-nowrap">${formatMoney(p.basic_earned)}</td>
          <td class="px-3 py-2.5 font-mono font-semibold text-brand-blue whitespace-nowrap">${formatMoney(p.thirteenth_month)}</td>
        </tr>`;
    })
    .join("");

  thirteenthFoot.innerHTML = `
    <tr class="bg-blue-50 font-semibold border-t-2 border-brand-blue">
      <td class="px-3 py-3" colspan="4">TOTAL</td>
      <td class="px-3 py-3 font-mono text-brand-blue whitespace-nowrap">${formatMoney(total)}</td>
    </tr>`;

  const monthNames = data.months_with_data.map((m) => MONTH_NAMES[m - 1]);
  thirteenthNote.textContent = monthNames.length
    ? `Based on ${monthNames.length} month(s) of schedule data in ${data.year}: ${monthNames.join(", ")}.`
    : `No schedule data for ${data.year} yet.`;
}

initThirteenthSelector();

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------
const employeesGrid = document.getElementById("employeesGrid");
const employeesTabs = document.getElementById("employeesTabs");

let employeesData = [];
let employeeCategories = {};
let selectedEmployeeName = null;

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

async function loadEmployees() {
  const res = await fetch("/api/staff");
  const data = await res.json();
  employeesData = data.staff;
  employeeCategories = data.categories || [];
  if (!selectedEmployeeName || !employeesData.some((s) => s.name === selectedEmployeeName)) {
    selectedEmployeeName = employeesData[0]?.name ?? null;
  }
  renderEmployees();
}

function contributionBlockHtml(label, idClass, idValue, amountClass, amountValue) {
  return `
    <div>
      <span class="text-gray-600 font-medium">${label}</span>
      <label class="block mt-1">
        <span class="block text-[10px] text-gray-400 uppercase tracking-wide">ID number</span>
        <input class="${idClass} w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm" value="${escapeHtml(idValue)}" />
      </label>
      <label class="block mt-1.5">
        <span class="block text-[10px] text-gray-400 uppercase tracking-wide">Standing amount (₱)</span>
        <input type="number" step="0.01" min="0" class="${amountClass} w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm font-mono" value="${amountValue ?? 0}" />
      </label>
    </div>
  `;
}

function sectionHtml(title, innerHtml, headerExtraHtml) {
  return `
    <section class="border border-gray-200 rounded-lg p-4">
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-[11px] text-gray-400 uppercase tracking-wide font-mono">${title}</h3>
        ${headerExtraHtml || ""}
      </div>
      ${innerHtml}
    </section>
  `;
}

function employeeCardHtml(s) {
  const photoSrc = s.photo_filename ? `/static/uploads/${s.photo_filename}` : "";
  const initial = (s.full_name || s.name || "?").trim().charAt(0).toUpperCase();
  const photoInner = photoSrc
    ? `<img class="employee-photo w-full h-full object-cover" src="${escapeHtml(photoSrc)}" />`
    : `<span class="employee-photo-placeholder text-xl font-semibold text-gray-400">${escapeHtml(initial)}</span>`;

  const basicInfoHtml = `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
      <label class="block"><span class="text-gray-500">Employment</span>
        <input class="employment-input w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm" value="${escapeHtml(s.employment)}" /></label>
      <label class="block"><span class="text-gray-500">Daily rate (₱)</span>
        <input type="number" step="0.01" min="0" class="daily-rate-input w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm font-mono" value="${s.daily_rate ?? 0}" /></label>
      <label class="block"><span class="text-gray-500">Fixed monthly salary (₱)</span>
        <input type="number" step="0.01" min="0" class="monthly-salary-input w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm font-mono" value="${s.monthly_salary ?? ""}" placeholder="—" /></label>
      <label class="block"><span class="text-gray-500">Monthly target (days)</span>
        <input type="number" min="0" class="target-input w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm font-mono" value="${s.target ?? ""}" placeholder="—" /></label>
      <label class="block"><span class="text-gray-500">Birthday</span>
        <input type="date" class="birthday-input w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm font-mono" value="${escapeHtml(s.birthday)}" /></label>
      <label class="block"><span class="text-gray-500">Phone</span>
        <input class="phone-input w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm" value="${escapeHtml(s.phone)}" /></label>
      <label class="block col-span-2"><span class="text-gray-500">Email</span>
        <input type="email" class="email-input w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm" value="${escapeHtml(s.email)}" /></label>
      <label class="block col-span-2 md:col-span-4"><span class="text-gray-500">Address</span>
        <textarea class="address-input w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm" rows="2">${escapeHtml(s.address)}</textarea></label>
    </div>
  `;

  const governmentHtml = `
    <div class="grid grid-cols-2 gap-3 text-xs">
      ${contributionBlockHtml("SSS", "sss-id-input", s.sss_id, "sss-default-input", s.default_sss)}
      ${contributionBlockHtml("Pag-IBIG", "pagibig-id-input", s.pagibig_id, "pagibig-default-input", s.default_pagibig)}
      ${contributionBlockHtml("PhilHealth", "philhealth-id-input", s.philhealth_id, "philhealth-default-input", s.default_philhealth)}
      ${contributionBlockHtml("HMO", "hmo-id-input", s.hmo_id, "hmo-default-input", s.default_hmo)}
    </div>
  `;

  const bankHtml = `
    <div class="grid grid-cols-2 gap-3 text-xs">
      <label class="block col-span-2"><span class="text-gray-500">Bank name</span>
        <input class="bank-name-input w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm" value="${escapeHtml(s.bank_name)}" /></label>
      <label class="block"><span class="text-gray-500">Account name</span>
        <input class="bank-account-name-input w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm" value="${escapeHtml(s.bank_account_name)}" /></label>
      <label class="block"><span class="text-gray-500">Account number</span>
        <input class="bank-account-number-input w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm font-mono" value="${escapeHtml(s.bank_account_number)}" /></label>
    </div>
  `;

  const advancesHtml = `
    <p class="advance-summary text-sm text-gray-600 mb-2">Loading…</p>
    <div class="advance-list-wrap mb-3"></div>
    <div class="grid grid-cols-2 gap-2 text-xs">
      <label class="block"><span class="text-gray-500">Amount (₱)</span>
        <input type="number" min="0" step="0.01" class="advance-amount-input w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm font-mono" /></label>
      <label class="block"><span class="text-gray-500">Date granted</span>
        <input type="date" class="advance-date-input w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm font-mono" /></label>
      <label class="block"><span class="text-gray-500">Deduct per cutoff (₱)</span>
        <input type="number" min="0" step="0.01" class="advance-installment-input w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm font-mono" placeholder="whole balance" /></label>
      <label class="block"><span class="text-gray-500">Note</span>
        <input class="advance-note-input w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm" /></label>
    </div>
    <div class="flex items-center gap-3 mt-3 flex-wrap">
      <button type="button" class="add-advance-btn text-xs bg-brand-blue text-white font-semibold rounded-md px-3 py-1.5 hover:brightness-110 transition">Record advance</button>
      <span class="advance-status text-xs text-gray-500"></span>
    </div>
    <p class="text-[11px] text-gray-400 mt-2">
      Repayments aren't entered here — they're the Cash Advance deduction on
      each payroll cutoff, which is prefilled from the per-cutoff amount above.
    </p>
  `;

  const ptoHtml = `
    <label class="block text-xs mb-3 max-w-[200px]"><span class="text-gray-500">Entitlement (days/yr)</span>
      <input type="number" min="0" class="pto-entitlement-input w-full border border-gray-300 rounded-md px-2 py-1.5 mt-0.5 text-sm font-mono" value="${s.pto_entitlement ?? ""}" placeholder="—" /></label>
    <p class="pto-summary text-sm text-gray-600 mb-2">Loading…</p>
    <div class="pto-table-wrap"></div>
  `;

  const isSelf = !IS_SUPERUSER && CURRENT_USER.staff_name === s.name;
  let loginHtml;
  if (IS_SUPERUSER) {
    loginHtml = `
      <label class="inline-flex items-center gap-2 text-sm">
        <input type="checkbox" class="login-enabled-input rounded border-gray-300 text-brand-blue focus:ring-brand-blue" ${s.login_enabled ? "checked" : ""} />
        Eligible to log in
      </label>
      <div class="flex items-center gap-2 mt-3 flex-wrap">
        <input type="password" class="login-pin-input w-40 border border-gray-300 rounded-md px-2 py-1.5 text-sm font-mono" placeholder="${s.has_pin ? "•••• (set)" : "Set a PIN"}" />
        <button type="button" class="save-login-btn text-xs bg-brand-blue text-white font-semibold rounded-md px-3 py-1.5 hover:brightness-110 transition">Save</button>
        <span class="login-save-status text-xs text-gray-500"></span>
      </div>
      <p class="text-[11px] text-gray-400 mt-2">Leave the PIN blank to keep it unchanged, or type a new one (4+ characters) to set/reset it.</p>
    `;
  } else if (isSelf && s.login_enabled) {
    loginHtml = `
      <label class="inline-flex items-center gap-2 text-sm text-gray-500">
        <input type="checkbox" class="rounded border-gray-300" checked disabled />
        Eligible to log in
      </label>
      <div class="flex items-center gap-2 mt-3 flex-wrap">
        <input type="password" class="login-pin-input w-40 border border-gray-300 rounded-md px-2 py-1.5 text-sm font-mono" placeholder="New PIN" />
        <button type="button" class="save-login-btn text-xs bg-brand-blue text-white font-semibold rounded-md px-3 py-1.5 hover:brightness-110 transition">Change my PIN</button>
        <span class="login-save-status text-xs text-gray-500"></span>
      </div>
    `;
  } else {
    loginHtml = `
      <label class="inline-flex items-center gap-2 text-sm text-gray-500">
        <input type="checkbox" class="rounded border-gray-300" ${s.login_enabled ? "checked" : ""} disabled />
        Eligible to log in
      </label>
      <p class="text-[11px] text-gray-400 mt-2">Only the superuser can change login access.</p>
    `;
  }

  return `
    <div class="bg-white border border-gray-200 rounded-xl p-5 shadow-sm" data-name="${escapeHtml(s.name)}">
      <div class="flex items-start gap-4 mb-5">
        <div class="relative shrink-0">
          <div class="employee-photo-wrap w-16 h-16 rounded-full overflow-hidden bg-gray-100 border border-gray-200 flex items-center justify-center">
            ${photoInner}
          </div>
          <label class="absolute -bottom-1 -right-1 bg-brand-blue text-white rounded-full w-6 h-6 flex items-center justify-center cursor-pointer text-xs shadow hover:brightness-110" title="Upload photo">
            <input type="file" accept="image/png,image/jpeg,image/webp" class="photo-input hidden" />
            &#9998;
          </label>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-[11px] text-gray-400 font-mono uppercase tracking-wide">
            ${escapeHtml(s.name)} &middot; ${escapeHtml(s.category)}
            ${s.active === false ? '<span class="ml-1 text-gray-500 bg-gray-100 border border-gray-200 rounded-full px-1.5 py-0.5 normal-case">Archived</span>' : ""}
          </p>
          <input class="full-name-input font-display font-semibold text-lg w-full border-b border-transparent hover:border-gray-200 focus:border-brand-blue focus:outline-none bg-transparent" value="${escapeHtml(s.full_name)}" />
          <input class="role-input text-xs text-gray-500 w-full border-b border-transparent hover:border-gray-200 focus:border-brand-blue focus:outline-none bg-transparent mt-0.5" value="${escapeHtml(s.role)}" />
        </div>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        ${sectionHtml("Basic Information", basicInfoHtml)}
        ${sectionHtml("Government (auto-filled each cutoff)", governmentHtml)}
        ${sectionHtml("Bank", bankHtml)}
        ${sectionHtml(
          "Paid Time Off",
          ptoHtml,
          '<select class="pto-year-select text-xs border border-gray-300 rounded-md px-2 py-1"></select>'
        )}
        ${sectionHtml("Cash Advances", advancesHtml)}
        <div class="lg:col-span-2">${sectionHtml("Login Access", loginHtml)}</div>
      </div>

      <div class="flex items-center gap-3 mt-5 flex-wrap">
        <button class="save-employee-btn bg-brand-green text-black font-semibold text-sm rounded-lg px-4 py-2 hover:brightness-95 active:brightness-90 transition">Save</button>
        ${
          s.active === false
            ? '<button class="restore-employee-btn text-sm font-semibold text-brand-blue border border-gray-200 rounded-lg px-4 py-2 hover:bg-gray-50 transition">Restore</button>'
            : '<button class="archive-employee-btn text-sm text-red-600 border border-red-200 rounded-lg px-4 py-2 hover:bg-red-50 transition">Archive</button>'
        }
        <span class="employee-save-status text-xs text-gray-500"></span>
      </div>
    </div>
  `;
}

async function loadEmployeePto(name, card, year) {
  const summaryEl = card.querySelector(".pto-summary");
  const tableWrap = card.querySelector(".pto-table-wrap");
  summaryEl.textContent = "Loading…";
  tableWrap.innerHTML = "";

  const res = await fetch(`/api/staff/${encodeURIComponent(name)}/pto?year=${year}`);
  const data = await res.json();

  const availableClass = data.available < 0 ? "text-red-600 font-semibold" : "text-brand-blue font-semibold";
  summaryEl.innerHTML =
    `<span class="${availableClass}">${data.available}</span> of ${data.entitlement} available ` +
    `<span class="text-gray-400">(${data.used_count} used in ${data.year})</span>`;

  if (data.used_dates.length === 0) {
    tableWrap.innerHTML = `<p class="text-xs text-gray-400 italic">No Paid Time Off used in ${data.year}.</p>`;
    return;
  }

  const rows = data.used_dates
    .map((d) => {
      const dt = new Date(`${d}T00:00:00`);
      const weekday = dt.toLocaleDateString("en-US", { weekday: "short" });
      const label = dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      return `<tr class="border-t border-gray-100"><td class="px-2 py-1.5 font-mono">${label}</td><td class="px-2 py-1.5 text-gray-500">${weekday}</td></tr>`;
    })
    .join("");
  tableWrap.innerHTML = `
    <table class="w-full text-xs border border-gray-200 rounded-md overflow-hidden">
      <thead><tr class="bg-gray-50 text-gray-500 text-left"><th class="px-2 py-1.5">Date</th><th class="px-2 py-1.5">Day</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

async function loadEmployeeAdvances(name, card) {
  const summaryEl = card.querySelector(".advance-summary");
  const listWrap = card.querySelector(".advance-list-wrap");
  if (!summaryEl) return;

  const res = await fetch(`/api/staff/${encodeURIComponent(name)}/advances`);
  if (!res.ok) {
    summaryEl.textContent = "Could not load advances.";
    return;
  }
  const data = await res.json();

  const tone = data.outstanding > 0 ? "text-red-600" : "text-brand-green";
  summaryEl.innerHTML =
    `<span class="${tone} font-semibold">${formatMoney(data.outstanding)}</span> outstanding ` +
    `<span class="text-gray-400">(${formatMoney(data.granted)} advanced, ${formatMoney(data.repaid)} repaid)</span>`;

  if (!data.advances.length) {
    listWrap.innerHTML = `<p class="text-xs text-gray-400 italic">No advances recorded.</p>`;
    return;
  }
  listWrap.innerHTML = `
    <table class="w-full text-xs border border-gray-200 rounded-md overflow-hidden">
      <thead><tr class="bg-gray-50 text-gray-500 text-left">
        <th class="px-2 py-1.5">Date</th><th class="px-2 py-1.5">Amount</th>
        <th class="px-2 py-1.5">Per cutoff</th><th class="px-2 py-1.5">Note</th><th class="px-2 py-1.5"></th>
      </tr></thead>
      <tbody>
        ${data.advances
          .map(
            (a) => `<tr class="border-t border-gray-100">
              <td class="px-2 py-1.5 font-mono">${escapeHtml(a.date_granted)}</td>
              <td class="px-2 py-1.5 font-mono">${formatMoney(a.amount)}</td>
              <td class="px-2 py-1.5 font-mono">${a.installment ? formatMoney(a.installment) : "—"}</td>
              <td class="px-2 py-1.5 text-gray-500">${escapeHtml(a.note || "—")}</td>
              <td class="px-2 py-1.5 text-right">
                <button type="button" class="delete-advance-btn text-gray-400 hover:text-red-600" data-id="${a.id}" title="Delete this advance">&times;</button>
              </td>
            </tr>`
          )
          .join("")}
      </tbody>
    </table>`;

  listWrap.querySelectorAll(".delete-advance-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!window.confirm("Delete this advance?\n\nRepayments already withheld in payroll aren't touched.")) return;
      const del = await fetch(`/api/advances/${btn.dataset.id}`, { method: "DELETE" });
      if (!del.ok) {
        alert("Could not delete that advance.");
        return;
      }
      await loadEmployeeAdvances(name, card);
    })
  );
}

async function addEmployeeAdvance(name, card) {
  const statusEl = card.querySelector(".advance-status");
  const amount = card.querySelector(".advance-amount-input").value;
  if (!amount) {
    statusEl.textContent = "Enter an amount.";
    return;
  }
  statusEl.textContent = "Saving…";
  const res = await fetch(`/api/staff/${encodeURIComponent(name)}/advances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      amount,
      date_granted: card.querySelector(".advance-date-input").value,
      installment: card.querySelector(".advance-installment-input").value,
      note: card.querySelector(".advance-note-input").value,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = data.message || "Could not record that advance.";
    return;
  }
  ["advance-amount-input", "advance-installment-input", "advance-note-input"].forEach(
    (cls) => (card.querySelector(`.${cls}`).value = "")
  );
  statusEl.textContent = "Recorded.";
  setTimeout(() => (statusEl.textContent = ""), 2500);
  await loadEmployeeAdvances(name, card);
}

function renderEmployees() {
  employeesTabs.innerHTML = employeesData
    .map((s) => {
      const selected = s.name === selectedEmployeeName;
      const archived = s.active === false;
      const classes = selected
        ? "bg-brand-blue text-white"
        : archived
        ? "bg-gray-50 text-gray-400 border border-dashed border-gray-300 hover:border-gray-400"
        : "bg-white text-gray-600 border border-gray-300 hover:border-gray-400";
      const suffix = archived ? ' <span class="opacity-70 font-normal">(archived)</span>' : "";
      return `<button type="button" class="employee-tab-btn font-semibold text-sm rounded-lg px-4 py-2 transition ${classes}" data-name="${escapeHtml(s.name)}">${escapeHtml(s.name)}${suffix}</button>`;
    })
    .join("");
  employeesTabs.querySelectorAll(".employee-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedEmployeeName = btn.dataset.name;
      renderEmployees();
    });
  });

  const selected = employeesData.find((s) => s.name === selectedEmployeeName);
  employeesGrid.innerHTML = selected ? employeeCardHtml(selected) : "";

  employeesGrid.querySelectorAll("[data-name]").forEach((card) => {
    const name = card.dataset.name;
    card.querySelector(".save-employee-btn").addEventListener("click", () => saveEmployee(card, name));
    const photoInput = card.querySelector(".photo-input");
    photoInput.addEventListener("change", () => uploadEmployeePhoto(card, name, photoInput));

    const yearSelect = card.querySelector(".pto-year-select");
    const currentYear = new Date().getFullYear();
    for (let y = currentYear + 1; y >= currentYear - 2; y--) {
      const opt = document.createElement("option");
      opt.value = y;
      opt.textContent = y;
      if (y === currentYear) opt.selected = true;
      yearSelect.appendChild(opt);
    }
    yearSelect.addEventListener("change", () => loadEmployeePto(name, card, yearSelect.value));
    loadEmployeePto(name, card, currentYear);

    const saveLoginBtn = card.querySelector(".save-login-btn");
    if (saveLoginBtn) {
      saveLoginBtn.addEventListener("click", () => saveStaffLogin(card, name));
    }
    const advanceDate = card.querySelector(".advance-date-input");
    if (advanceDate) {
      advanceDate.value = isoDate(new Date());
      card.querySelector(".add-advance-btn").addEventListener("click", () => addEmployeeAdvance(name, card));
      loadEmployeeAdvances(name, card);
    }

    const archiveBtn = card.querySelector(".archive-employee-btn");
    if (archiveBtn) archiveBtn.addEventListener("click", () => archiveEmployee(card, name));
    const restoreBtn = card.querySelector(".restore-employee-btn");
    if (restoreBtn) restoreBtn.addEventListener("click", () => restoreEmployee(card, name));
  });
}

async function archiveEmployee(card, name) {
  const confirmed = window.confirm(
    `Archive ${name}?\n\n` +
      "They stop being scheduled and drop off the roster, and any shifts already " +
      "generated for future dates are cleared along with any leave request still " +
      "awaiting a decision.\n\n" +
      "Past schedules and payroll history are kept, so old cutoffs and 13th month " +
      "still add up. You can restore them later."
  );
  if (!confirmed) return;

  const statusEl = card.querySelector(".employee-save-status");
  statusEl.textContent = "Archiving…";
  const res = await fetch(`/api/staff/${encodeURIComponent(name)}/archive`, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    statusEl.textContent = "";
    alert(data.message || "Could not archive that employee.");
    return;
  }
  alert(
    `${name} archived.\n\n` +
      `Future shifts cleared: ${data.cleared_shifts}\n` +
      `Pending leave requests cancelled: ${data.cleared_requests}`
  );
  await Promise.all([loadEmployees(), loadSchedule()]);
}

async function restoreEmployee(card, name) {
  if (!window.confirm(`Restore ${name} to the active roster?\n\nTheir login stays switched off until you re-enable it.`)) return;
  const statusEl = card.querySelector(".employee-save-status");
  statusEl.textContent = "Restoring…";
  const res = await fetch(`/api/staff/${encodeURIComponent(name)}/restore`, { method: "POST" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    statusEl.textContent = "";
    alert(data.message || "Could not restore that employee.");
    return;
  }
  await Promise.all([loadEmployees(), loadSchedule()]);
}

// --- Add employee ----------------------------------------------------------
const addEmployeeBtn = document.getElementById("addEmployeeBtn");
const addEmployeeForm = document.getElementById("addEmployeeForm");
const newStaffCategory = document.getElementById("newStaffCategory");
const newStaffStatus = document.getElementById("newStaffStatus");
const saveNewStaffBtn = document.getElementById("saveNewStaffBtn");

const NEW_STAFF_INPUTS = {
  name: "newStaffName",
  full_name: "newStaffFullName",
  role: "newStaffRole",
  employment: "newStaffEmployment",
  daily_rate: "newStaffDailyRate",
  monthly_salary: "newStaffMonthlySalary",
  target: "newStaffTarget",
  pto_entitlement: "newStaffPto",
};

if (addEmployeeBtn) {
  addEmployeeBtn.addEventListener("click", () => {
    const opening = addEmployeeForm.style.display === "none";
    addEmployeeForm.style.display = opening ? "block" : "none";
    if (!opening) return;
    newStaffCategory.innerHTML = employeeCategories
      .map((c) => `<option value="${escapeHtml(c.value)}">${escapeHtml(c.label)}</option>`)
      .join("");
    newStaffCategory.value = "sales"; // the usual hire
    document.getElementById("newStaffName").focus();
  });

  document.getElementById("cancelNewStaffBtn").addEventListener("click", () => {
    addEmployeeForm.style.display = "none";
    newStaffStatus.textContent = "";
  });

  saveNewStaffBtn.addEventListener("click", async () => {
    const payload = { category: newStaffCategory.value };
    Object.entries(NEW_STAFF_INPUTS).forEach(([field, id]) => {
      payload[field] = document.getElementById(id).value;
    });

    saveNewStaffBtn.disabled = true;
    newStaffStatus.textContent = "Adding…";
    try {
      const res = await fetch("/api/staff/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        newStaffStatus.textContent = data.message || "Could not add that employee.";
        return;
      }
      Object.values(NEW_STAFF_INPUTS).forEach((id) => (document.getElementById(id).value = ""));
      document.getElementById("newStaffEmployment").value = "Permanent";
      document.getElementById("newStaffPto").value = "5";
      addEmployeeForm.style.display = "none";
      newStaffStatus.textContent = "";
      selectedEmployeeName = data.name;
      await Promise.all([loadEmployees(), loadSchedule()]);
      alert(
        `${data.name} added.\n\nRegenerate a month's schedule to have them ` +
          "included automatically, or assign their shifts by clicking cells in the table."
      );
    } finally {
      saveNewStaffBtn.disabled = false;
    }
  });
}

async function saveStaffLogin(card, name) {
  const statusEl = card.querySelector(".login-save-status");
  const btn = card.querySelector(".save-login-btn");
  const pinInput = card.querySelector(".login-pin-input");
  const enabledInput = card.querySelector(".login-enabled-input");

  const payload = {};
  if (enabledInput) payload.login_enabled = enabledInput.checked;
  if (pinInput && pinInput.value) payload.pin = pinInput.value;

  if (!("login_enabled" in payload) && !payload.pin) {
    statusEl.textContent = "Enter a PIN to change it.";
    return;
  }

  btn.disabled = true;
  statusEl.textContent = "";
  try {
    const res = await fetch(`/api/staff/${encodeURIComponent(name)}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      statusEl.textContent = data.message || "Could not save.";
      btn.disabled = false;
      return;
    }
    await loadEmployees();
  } catch (err) {
    statusEl.textContent = "Could not save. Please try again.";
    btn.disabled = false;
  }
}

async function saveEmployee(card, name) {
  const statusEl = card.querySelector(".employee-save-status");
  const btn = card.querySelector(".save-employee-btn");
  btn.disabled = true;
  statusEl.textContent = "";
  try {
    const payload = {
      full_name: card.querySelector(".full-name-input").value,
      role: card.querySelector(".role-input").value,
      employment: card.querySelector(".employment-input").value,
      daily_rate: card.querySelector(".daily-rate-input").value,
      monthly_salary: card.querySelector(".monthly-salary-input").value,
      target: card.querySelector(".target-input").value,
      pto_entitlement: card.querySelector(".pto-entitlement-input").value,
      phone: card.querySelector(".phone-input").value,
      email: card.querySelector(".email-input").value,
      birthday: card.querySelector(".birthday-input").value,
      address: card.querySelector(".address-input").value,
      default_sss: card.querySelector(".sss-default-input").value,
      default_pagibig: card.querySelector(".pagibig-default-input").value,
      default_philhealth: card.querySelector(".philhealth-default-input").value,
      default_hmo: card.querySelector(".hmo-default-input").value,
      sss_id: card.querySelector(".sss-id-input").value,
      pagibig_id: card.querySelector(".pagibig-id-input").value,
      philhealth_id: card.querySelector(".philhealth-id-input").value,
      hmo_id: card.querySelector(".hmo-id-input").value,
      bank_name: card.querySelector(".bank-name-input").value,
      bank_account_name: card.querySelector(".bank-account-name-input").value,
      bank_account_number: card.querySelector(".bank-account-number-input").value,
    };
    const res = await fetch(`/api/staff/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("Save failed");
    statusEl.textContent = "Saved.";
    setTimeout(() => (statusEl.textContent = ""), 2500);
  } catch (err) {
    statusEl.textContent = "Could not save. Please try again.";
  } finally {
    btn.disabled = false;
  }
}

async function uploadEmployeePhoto(card, name, input) {
  const file = input.files[0];
  if (!file) return;
  const statusEl = card.querySelector(".employee-save-status");
  statusEl.textContent = "Uploading photo…";
  try {
    const formData = new FormData();
    formData.append("photo", file);
    const res = await fetch(`/api/staff/${encodeURIComponent(name)}/photo`, {
      method: "POST",
      body: formData,
    });
    if (!res.ok) throw new Error("Upload failed");
    const result = await res.json();
    const wrap = card.querySelector(".employee-photo-wrap");
    wrap.innerHTML = `<img class="employee-photo w-full h-full object-cover" src="/static/uploads/${result.photo_filename}?t=${Date.now()}" />`;
    statusEl.textContent = "Photo updated.";
    setTimeout(() => (statusEl.textContent = ""), 2500);
  } catch (err) {
    statusEl.textContent = "Could not upload photo.";
  } finally {
    input.value = "";
  }
}


// ---------------------------------------------------------------------------
// Print Queue (cup printing order book)
//
// The board is a card grid rather than a list: each card is one order, and
// its cup lines are a small table inside it. Ongoing sorts to the top -
// this is a "what is on the press now" screen, so work already started
// outranks work not yet begun.
// ---------------------------------------------------------------------------

// Ink names as they are written on the orders, mapped to something close
// enough to recognise at a glance. Anything unlisted falls back to grey.
const PRINT_INK = {
  white: "#f2f2ef", black: "#17181c", brown: "#6f4a2d", gold: "#b9922f",
  violet: "#6b3fa0", red: "#cc2b26", "dark red": "#8c1f1b", green: "#4caf50",
  "dark green": "#17603a", "lime green": "#a4cf3c", "yellow green": "#9acd32",
  yellow: "#e8b820", "lemon yellow": "#f0e442", "baby blue": "#a9cbe8",
  "navy blue": "#1b2a5e", "deep blue": "#1d3f8f", blue: "#2f5bd6",
  "teal blue": "#17787f", pink: "#f08cad", "baby pink": "#f2b8c6",
  orange: "#e8862a", silver: "#c0c4cc", grey: "#9aa0a6", gray: "#9aa0a6",
};

const PRINT_STATUS_LABEL = {
  ongoing: "Ongoing", partial: "Partial", not_started: "Not started",
  done: "Done", cancelled: "Cancelled",
};
// same order the API sorts by, so the groups read top to bottom the way
// the cards do
const PRINT_STATUS_ORDER = ["ongoing", "partial", "not_started", "done", "cancelled"];
const PRINT_STATUS_TONE = {
  ongoing: "bg-blue-50 text-brand-blue border-blue-200",
  partial: "bg-amber-50 text-amber-700 border-amber-200",
  not_started: "bg-gray-50 text-gray-500 border-gray-200",
  done: "bg-green-50 text-green-700 border-green-200",
  cancelled: "bg-gray-100 text-gray-400 border-gray-200",
};
// Heading pills carry a solid fill: the divider rule runs behind them, and
// a transparent pill would let it strike through the label.
const PRINT_GROUP_TONE = {
  ongoing: "bg-blue-50 border-blue-200 text-brand-blue",
  partial: "bg-amber-50 border-amber-200 text-amber-800",
  not_started: "bg-white border-gray-200 text-gray-700",
  done: "bg-green-50 border-green-200 text-green-800",
  cancelled: "bg-gray-100 border-gray-200 text-gray-400",
};

const PRINT_STATUS_DOT = {
  ongoing: "#1c33bb", partial: "#c98a12", not_started: "#9ca3af",
  done: "#07c067", cancelled: "#d1d5db",
};

const PRINT_DEFAULTS = {
  view: "open", group: "status", sort: "age", cols: "2", showControls: false, mode: "board",
  fields: { logo: true, lid: true, unit: true, ink: true, amount: true, remark: true },
};

let printState = loadPrintPrefs();
let printOrders = [];
let printClients = [];

function loadPrintPrefs() {
  try {
    const raw = localStorage.getItem("mpd.print.prefs");
    if (raw) {
      const saved = JSON.parse(raw);
      return {
        view: saved.view || PRINT_DEFAULTS.view,
        group: saved.group || PRINT_DEFAULTS.group,
        sort: saved.sort || PRINT_DEFAULTS.sort,
        cols: saved.cols || PRINT_DEFAULTS.cols,
        showControls: !!saved.showControls,
        mode: saved.mode === "week" ? "week" : "board",
        fields: Object.assign({}, PRINT_DEFAULTS.fields, saved.fields || {}),
      };
    }
  } catch (e) {
    // private window or blocked storage - defaults are fine
  }
  return JSON.parse(JSON.stringify(PRINT_DEFAULTS));
}

function savePrintPrefs() {
  try {
    localStorage.setItem("mpd.print.prefs", JSON.stringify(printState));
  } catch (e) {
    // nothing to do - the board still works, it just won't be remembered
  }
}

function inkColor(name) {
  return PRINT_INK[(name || "").trim().toLowerCase()] || "#9ca3af";
}

// Black or white lettering, whichever stays readable on the ink. Inks run
// from white to near-black, so a fixed text colour is unreadable on one
// end or the other.
function inkTextColor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "#111827";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.42 ? "#111827" : "#ffffff";
}

// the ink chip: filled with the colour it names, so a glance down the
// column tells you which screens the job needs
function inkChip(item) {
  const ink = item.ink_color || "";
  const bg = ink ? inkColor(ink) : "transparent";
  const fg = ink ? inkTextColor(bg) : "#9ca3af";
  return `<span class="print-edit print-ink-chip${ink ? "" : " is-empty"}" tabindex="0" role="button"
                data-item="${item.id}" data-field="ink" title="Click to change the ink"
                style="background:${bg};color:${fg}">${escapeHtml(ink || "—")}</span>`;
}

// stable colour per client so a logo circle always looks the same
function printClientHue(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return h;
}

function printLogo(name, big, logoFile) {
  const size = big ? "w-12 h-12 text-lg" : "w-9 h-9 text-sm";
  if (logoFile) {
    // the logo is the thing we print for them, so it names a client faster
    // than a monogram ever will
    return `<div class="${size} rounded-full overflow-hidden shrink-0 bg-white"
                 style="box-shadow:inset 0 0 0 1px rgba(17,24,39,.12)">
              <img src="/static/uploads/${escapeHtml(logoFile)}" alt="" class="w-full h-full object-contain" />
            </div>`;
  }
  const h = printClientHue(name || "?");
  const letter = escapeHtml((name || "?").replace(/[^A-Za-z]/g, "").charAt(0).toUpperCase() || "?");
  return `<div class="${size} rounded-full grid place-items-center font-display font-bold shrink-0"
               style="background:hsl(${h},62%,93%);color:hsl(${h},55%,32%);box-shadow:inset 0 0 0 1px rgba(17,24,39,.1)">${letter}</div>`;
}

function printMoney(n) {
  return "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function printShortDate(iso) {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function printChip(text, tone) {
  return `<span class="print-chip ${tone}">${escapeHtml(text)}</span>`;
}

function printCard(o) {
  const f = printState.fields;
  const cups = o.quantity || 0;

  // Only worth saying when the board is not already grouped by it - under
  // an "Ongoing" heading, an Ongoing badge on every card says nothing.
  const chips =
    printState.group === "status"
      ? []
      : [printChip(PRINT_STATUS_LABEL[o.status] || o.status, PRINT_STATUS_TONE[o.status] || "")];
  if (o.is_rush) {
    chips.push(printChip(o.due_date ? `Due ${printShortDate(o.due_date)}` : "Rush", "bg-red-50 text-red-600 border-red-200"));
  }
  // "needs a new frame" is a folded corner now, not a chip - see below


  // The cup lines, as a table. Cup, lid and quantity are editable in place
  // - they are ordinary text until you click into them. The last column
  // does double duty: it carries the status while the line is in progress,
  // and swaps to the unit price and amount the moment it is done, so money
  // appears as work completes rather than sitting there all along.
  // Once every line is done there is no status left to report, so the
  // column it occupied becomes the two money columns it was standing in
  // for - with headings, because by then the figures are the point.
  const allDone = o.status === "done";
  const head =
    `<tr><th>Cup</th>${f.lid ? "<th>Lid</th>" : ""}${f.ink ? "<th>Ink</th>" : ""}<th class="r">Qty</th>` +
    (allDone
      ? `${f.unit ? '<th class="r">Unit</th>' : ""}${f.amount ? '<th class="r">Amount</th>' : ""}`
      : `<th class="r"></th>`) +
    `</tr>`;

  const rows = o.items
    .map((i) => {
      const moneyCells =
        (f.unit ? `<td class="r text-gray-500">${Number(i.unit_price).toFixed(2)}</td>` : "") +
        (f.amount ? `<td class="r"><span class="pm-amount">${Number(i.amount).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span></td>` : "");

      const pill =
        `<button type="button" class="print-line-status print-chip ${PRINT_STATUS_TONE[i.status] || ""}"
                 data-item="${i.id}" data-status="${i.status}" data-qty="${i.quantity}"
                 title="Change status">${escapeHtml(PRINT_STATUS_LABEL[i.status] || i.status)}</button>` +
        (i.status === "partial" && i.qty_delivered
          ? `<span class="block text-[10px] text-amber-700 font-mono mt-0.5">${Number(i.qty_delivered).toLocaleString("en-PH")} out</span>`
          : "");

      return (
        `<tr data-item="${i.id}">` +
        `<td>
           <span class="print-edit font-medium text-gray-900" tabindex="0" role="button"
                 data-item="${i.id}" data-field="product_id" data-value="${i.product_id || ""}"
                 title="Click to change the cup">${escapeHtml(i.label || "")}</span>
           ${
             printCupColours(i.product_id).length
               ? `<span class="print-cup-sep">·</span><span class="print-edit print-cup-colour" tabindex="0" role="button"
                        data-item="${i.id}" data-field="cup_color" data-cup="${i.product_id || ""}"
                        data-value="${escapeHtml(i.cup_color || "")}"
                        title="Colour of the cup itself"
                        >${escapeHtml(i.cup_color || "— colour")}</span>`
               : ""
           }
         </td>` +
        (f.lid
          ? `<td><span class="print-edit text-gray-500" tabindex="0" role="button"
                       data-item="${i.id}" data-field="lid_product_id"
                       data-value="${i.lid_product_id || ""}" data-cup="${i.product_id || ""}"
                       title="Click to change the lid"
                       >${escapeHtml(i.lid_label || "—")}</span></td>`
          : "") +
        (f.ink ? `<td>${inkChip(i)}</td>` : "") +
        `<td class="r"><span class="print-edit" tabindex="0" role="button"
                    data-item="${i.id}" data-field="quantity" title="Click to edit"
                    >${Number(i.quantity).toLocaleString("en-PH")}</span></td>` +
        (allDone ? moneyCells : `<td class="r">${pill}</td>`) +
        `</tr>`
      );
    })
    .join("");

  const extras = [];
  if (f.remark) {
    // rendered even when empty: a note you cannot add is not much use, and
    // the placeholder is where you click to add one
    extras.push(
      `<div class="text-xs bg-gray-50 rounded-md px-2 py-1.5">
         <span class="print-edit print-remark ${o.remarks ? "text-gray-600" : "text-gray-300 italic"}"
               tabindex="0" role="button" data-order="${o.id}" data-field="remarks"
               title="Click to edit the note">${escapeHtml(o.remarks || "add a note")}</span>
       </div>`
    );
  }

  return `
    <article class="relative bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden flex flex-col hover:shadow-md hover:border-gray-300 transition" data-order="${o.id}">
      ${
        // A folded corner rather than another chip: it costs no room in the
        // header, so Rush keeps that row to itself, and a folded card reads
        // from the corner of your eye while scanning past.
        o.needs_new_frame
          ? `<span class="print-frame-fold" title="Needs a new frame"><i>new</i></span>`
          : ""
      }
      <div class="flex items-center gap-2.5 pl-3 ${o.needs_new_frame ? "pr-12" : "pr-3"} pt-3 pb-2">
        ${f.logo ? printLogo(o.client_name, false, o.logo_filename) : ""}
        <div class="min-w-0 flex-1">
          <button class="print-client-btn font-semibold text-[15px] leading-tight truncate hover:text-brand-blue text-left block max-w-full" data-client="${o.client_id}">${escapeHtml(o.client_name)} &rsaquo;</button>
          <p class="text-[11px] text-gray-400 font-mono">${printShortDate(o.order_date)} · ${cups.toLocaleString("en-PH")} cups</p>
        </div>
        <div class="flex flex-wrap items-center gap-1 justify-end shrink-0 max-w-[45%]">
          ${chips.join("")}
          <button class="print-card-menu" type="button" data-order="${o.id}" aria-label="Order actions" title="Order actions">&#8943;</button>
        </div>
      </div>
      <table class="print-lines"><thead>${head}</thead><tbody>${rows}</tbody></table>
      ${extras.length ? `<div class="px-3 pt-2 pb-3 flex flex-col gap-2">${extras.join("")}</div>` : ""}
      ${
        // A footer only when there is something to put in it. An unfinished
        // job has no total to show and nothing to bill, so the card simply
        // ends after its lines. Paid says something; unpaid is the default
        // state of every job and saying it on every card said nothing.
        o.status === "done" || o.is_paid
          ? `<div class="mt-auto flex items-center justify-between gap-2 px-3 py-2 border-t border-gray-100">
               <button class="print-paid-btn text-[11px] font-mono uppercase tracking-wide ${
                 o.is_paid ? "text-green-700" : "text-gray-400 hover:text-gray-700"
               }" data-order="${o.id}" data-paid="${o.is_paid ? 1 : 0}"
                       title="${o.is_paid ? "Mark as unpaid" : "Mark as paid"}">${o.is_paid ? "Paid" : "Mark paid"}</button>
               ${
                 f.amount && o.status === "done"
                   ? `<span class="print-card-total font-mono font-semibold text-sm">${printMoney(o.total)}</span>`
                   : ""
               }
             </div>`
          : ""
      }
    </article>`;
}

function printGroupKey(o) {
  if (printState.group === "client") return o.client_name;
  if (printState.group === "ink") {
    const ink = o.items.length && o.items[0].ink_color ? o.items[0].ink_color : "No ink noted";
    return ink;
  }
  return PRINT_STATUS_LABEL[o.status] || o.status;
}

function printSorted(list) {
  const copy = list.slice();
  copy.sort((a, b) => {
    if (printState.sort === "qty") return b.quantity - a.quantity;
    if (printState.sort === "amount") return b.total - a.total;
    if (printState.sort === "due") {
      const ad = a.due_date || "9999", bd = b.due_date || "9999";
      return ad < bd ? -1 : ad > bd ? 1 : (a.order_date || "").localeCompare(b.order_date || "");
    }
    return (a.order_date || "").localeCompare(b.order_date || "");
  });
  return copy;
}

function renderPrintBoard() {
  if (printState.mode === "week") {
    renderPrintWeek();
    return;
  }
  const board = document.getElementById("printBoard");
  const q = (document.getElementById("printSearch").value || "").trim().toLowerCase();

  let list = printOrders.filter((o) => {
    if (!q) return true;
    if (o.client_name.toLowerCase().includes(q)) return true;
    return o.items.some(
      (i) =>
        (i.label || "").toLowerCase().includes(q) ||
        (i.cup_color || "").toLowerCase().includes(q) ||
        (i.lid_label || "").toLowerCase().includes(q) ||
        (i.ink_color || "").toLowerCase().includes(q)
    );
  });

  if (!list.length) {
    board.innerHTML = `<p class="text-sm text-gray-400 italic py-10 text-center">Nothing here yet. Add an order, or try another view.</p>`;
    return;
  }

  list = printSorted(list);

  if (printState.group === "none") {
    board.innerHTML = `<div class="print-grid" data-cols="${printState.cols}">${list.map(printCard).join("")}</div>`;
    wirePrintBoard();
    return;
  }

  const buckets = new Map();
  list.forEach((o) => {
    const k = printGroupKey(o);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(o);
  });

  let keys = [...buckets.keys()];
  if (printState.group === "status") {
    keys.sort(
      (a, b) =>
        PRINT_STATUS_ORDER.indexOf(printStatusFromLabel(a)) -
        PRINT_STATUS_ORDER.indexOf(printStatusFromLabel(b))
    );
  } else {
    keys.sort();
  }

  board.innerHTML = keys
    .map((k) => {
      const group = buckets.get(k);
      const cups = group.reduce((s, o) => s + o.quantity, 0);
      const groupStatus = printState.group === "status" ? printStatusFromLabel(k) : null;
      const tone = groupStatus
        ? PRINT_GROUP_TONE[groupStatus] || "bg-white border-gray-200 text-gray-700"
        : "bg-white border-gray-200 text-gray-700";
      const dot = groupStatus
        ? `<span class="w-2 h-2 rounded-full shrink-0" style="background:${PRINT_STATUS_DOT[groupStatus] || "#9ca3af"}"></span>`
        : "";
      return `
        <section class="flex flex-col gap-3">
          <div class="relative flex items-center justify-center">
            <span class="absolute inset-x-0 top-1/2 h-px bg-gray-200"></span>
            <span class="relative inline-flex items-center gap-2.5 rounded-full border px-4 py-1.5 ${tone}">
              ${dot}
              <h3 class="font-display font-semibold text-[15px] leading-none tracking-tight">${escapeHtml(k)}</h3>
              <span class="text-[11px] font-mono leading-none opacity-60">${group.length}</span>
              <span class="w-px h-3 bg-current opacity-20"></span>
              <span class="group-cups text-[11px] font-mono leading-none opacity-60">${cups.toLocaleString("en-PH")} cups</span>
            </span>
          </div>
          <div class="print-grid" data-cols="${printState.cols}">${group.map(printCard).join("")}</div>
        </section>`;
    })
    .join("");

  wirePrintBoard();
}

function printStatusFromLabel(label) {
  const hit = Object.keys(PRINT_STATUS_LABEL).find((k) => PRINT_STATUS_LABEL[k] === label);
  return hit || "not_started";
}

// Status popover. One element reused for every pill rather than one per
// line - there are 350 lines in the queue and only ever one popover open.
let printStatusPop = null;

function closeStatusPopover() {
  if (printStatusPop) {
    printStatusPop.remove();
    printStatusPop = null;
  }
}

async function setLineStatus(itemId, body) {
  const res = await fetch(`/api/print/items/${itemId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.message || "Could not update that line.");
    return;
  }
  closeStatusPopover();
  // a status change can move the card into another group, so redraw the
  // whole board rather than patching the one pill
  loadPrintQueue();
}

function openStatusPopover(pill) {
  closeStatusPopover();
  const itemId = pill.dataset.item;
  const current = pill.dataset.status;
  const qty = Number(pill.dataset.qty || 0);

  const pop = document.createElement("div");
  pop.className =
    "fixed z-50 bg-white border border-gray-200 rounded-lg shadow-lg py-1 w-44 text-sm";
  pop.innerHTML =
    ["ongoing", "partial", "not_started", "done", "cancelled"]
      .map(
        (st) =>
          `<button type="button" class="status-opt w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-2 ${
            st === current ? "font-semibold" : ""
          }" data-status="${st}">
             <span class="w-2 h-2 rounded-sm" style="background:${PRINT_STATUS_DOT[st]}"></span>
             ${PRINT_STATUS_LABEL[st]}
             ${st === current ? '<span class="ml-auto text-brand-blue">&#10003;</span>' : ""}
           </button>`
      )
      .join("") +
    `<div class="border-t border-gray-100 mt-1 pt-1 px-3 pb-1">
       <label class="block text-[11px] text-gray-500 mb-1">Delivered of ${qty.toLocaleString("en-PH")}</label>
       <div class="flex gap-1">
         <input type="number" min="0" max="${qty}" class="status-qty w-full border border-gray-300 rounded px-1.5 py-1 text-sm text-right" />
         <button type="button" class="status-qty-save bg-brand-blue text-white rounded px-2 text-xs">Set</button>
       </div>
     </div>`;

  document.body.appendChild(pop);
  const r = pill.getBoundingClientRect();
  // flip above the pill when there is no room below
  const top = r.bottom + 260 > window.innerHeight ? r.top - pop.offsetHeight - 4 : r.bottom + 4;
  pop.style.top = `${Math.max(8, top)}px`;
  pop.style.left = `${Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)}px`;

  pop.querySelectorAll(".status-opt").forEach((opt) => {
    opt.addEventListener("click", () => setLineStatus(itemId, { status: opt.dataset.status }));
  });
  const qtyInput = pop.querySelector(".status-qty");
  const save = () => {
    const n = Number(qtyInput.value);
    if (qtyInput.value === "" || Number.isNaN(n)) return;
    setLineStatus(itemId, { qty_delivered: n });
  };
  pop.querySelector(".status-qty-save").addEventListener("click", save);
  qtyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
  });

  printStatusPop = pop;
}

document.addEventListener("click", (e) => {
  if (printStatusPop && !printStatusPop.contains(e.target) && !e.target.closest(".print-line-status")) {
    closeStatusPopover();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeStatusPopover();
});

function wirePrintBoard() {
  document.querySelectorAll(".print-client-btn").forEach((b) => {
    b.addEventListener("click", () => openPrintClient(b.dataset.client));
  });
  document.querySelectorAll(".print-line-status").forEach((pill) => {
    pill.addEventListener("click", (e) => {
      e.stopPropagation();
      openStatusPopover(pill);
    });
  });
  document.querySelectorAll(".print-edit").forEach(wireEditCell);
  document.querySelectorAll(".print-card-menu").forEach((b) => {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      openCardMenu(b);
    });
  });
  // paid is the one thing you flip constantly, so it's a click on the card
  // rather than a trip into a form
  document.querySelectorAll(".print-paid-btn").forEach((b) => {
    b.addEventListener("click", async () => {
      const paid = b.dataset.paid !== "1";
      const res = await fetch(`/api/print/orders/${b.dataset.order}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_paid: paid }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.message || "Could not update that order.");
        return;
      }
      loadPrintQueue();
    });
  });
}

// Cup, lid and quantity read as ordinary text and turn into an input only
// when you click them. Rendering permanent inputs looked tidy but clipped
// the long cup names and threw away the thousands separators on quantity -
// and the table is read far more often than it is edited.
// which colours a cup comes in, straight from the catalogue
function printCupColours(productId) {
  if (!printCatalogue || !printCatalogue.colors) return [];
  return printCatalogue.colors[String(productId)] || [];
}

// Make a cell open its editor on click, or on Enter/Space when focused.
//
// The guard matters: once the editor exists it lives *inside* the cell, so
// its keystrokes bubble up here. Without checking the target, every space
// typed into a note or an ink name was swallowed by the preventDefault
// below and never reached the input.
function wireEditCell(cell) {
  cell.addEventListener("click", () => beginPrintCellEdit(cell));
  cell.addEventListener("keydown", (e) => {
    if (e.target !== cell) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      beginPrintCellEdit(cell);
    }
  });
}

function beginPrintCellEdit(cell) {
  if (cell.querySelector("input") || cell.querySelector("select")) return;

  const field = cell.dataset.field;
  // cup and lid are picked from the price list, never typed - that is the
  // whole reason they are products and not text
  if (field === "product_id" || field === "lid_product_id" || field === "cup_color") {
    beginProductPick(cell, field);
    return;
  }

  const original = printCellRaw(cell);

  const input = document.createElement("input");
  input.className = "print-cell-input" + (field === "quantity" ? " text-right" : "");
  input.value = original;
  if (field === "quantity") {
    input.type = "number";
    input.min = "0";
    input.step = "1";
  }

  const shown = cell.textContent;
  cell.textContent = "";
  cell.appendChild(input);
  input.focus();
  input.select();

  let settled = false;
  const revert = () => {
    cell.textContent = shown;
  };
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    const value = input.value;
    if (!commit || String(value).trim() === String(original).trim()) {
      revert();
      return;
    }
    await savePrintCell(cell, value, revert);
  };

  // both: change fires when the value was actually edited (Enter, or focus
  // leaving), blur catches the case where it was not. `settled` makes the
  // second one a no-op, so an edit can never be committed twice.
  input.addEventListener("change", () => finish(true));
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
}

// what the cell holds, without the display formatting
function printCellRaw(cell) {
  const field = cell.dataset.field;
  const text = cell.textContent.trim();
  if (field === "quantity") return text.replace(/[^0-9]/g, "");
  return ["—", "add ink", "add a note", "— colour"].includes(text) ? "" : text;
}

// Save one edited cell. Deliberately does not reload the board: you are
// usually on your way to the next field, and a redraw would take the focus
// with it. The numbers that depend on this line are patched in place
// instead, and the next real load reconciles everything.
async function savePrintCell(cell, raw, revert) {
  const itemId = cell.dataset.item;
  const productId = cell.dataset.product;
  const orderId = cell.dataset.order;
  const field = cell.dataset.field;

  // renaming a client, from the drawer header
  if (cell.dataset.clientField === "name") {
    const text = String(raw).trim();
    if (!text) {
      alert("A client needs a name.");
      revert();
      return;
    }
    const res = await fetch(`/api/print/clients/${cell.dataset.client}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.message || "Could not rename that client.");
      revert();
      return;
    }
    cell.textContent = text;
    cell.classList.add("saved");
    setTimeout(() => cell.classList.remove("saved"), 900);
    // the name is on every card of theirs, and in the clients list
    loadPrintQueue();
    if (printClientRows.length) loadPrintClientsPage();
    return;
  }

  // a note belongs to the order, not to one of its cup lines
  if (orderId && field === "remarks") {
    const text = String(raw).trim();
    const res = await fetch(`/api/print/orders/${orderId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remarks: text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.message || "Could not save that note.");
      revert();
      return;
    }
    cell.textContent = text || "add a note";
    cell.classList.toggle("text-gray-600", !!text);
    cell.classList.toggle("text-gray-300", !text);
    cell.classList.toggle("italic", !text);
    cell.classList.add("saved");
    setTimeout(() => cell.classList.remove("saved"), 900);
    const order = printOrders.find((o) => String(o.id) === String(orderId));
    if (order) order.remarks = text || null;
    return;
  }

  // a price on the pricing page: a number, or blank to clear it
  if (productId) {
    const text = String(raw).trim();
    const money = text === "" || text === "—" ? "" : Number(text);
    if (money !== "" && (!Number.isFinite(money) || money < 0)) {
      alert("A price must be a number, zero or more.");
      revert();
      return;
    }
    const res = await fetch(`/api/print/products/${productId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: money }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.message || "Could not save that price.");
      revert();
      return;
    }
    cell.textContent = money === "" ? "—" : Number(money).toFixed(2);
    cell.classList.add("saved");
    setTimeout(() => cell.classList.remove("saved"), 900);
    // the catalogue is cached, so keep it in step with what was just saved
    if (printCatalogue) {
      for (const list of [printCatalogue.cups, printCatalogue.lids]) {
        const hit = list.find((x) => String(x.id) === String(productId));
        if (hit) hit[field] = money === "" ? null : money;
      }
    }
    return;
  }

  const value = field === "quantity" ? Number(raw || 0) : String(raw).trim();

  if (field === "quantity" && (!Number.isFinite(value) || value < 0)) {
    alert("Quantity must be a whole number, zero or more.");
    revert();
    return;
  }
  if (field === "label" && !value) {
    alert("A line needs a cup.");
    revert();
    return;
  }

  const body = {};
  body[field] = value;
  const res = await fetch(`/api/print/items/${itemId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.message || "Could not save that.");
    revert();
    return;
  }

  cell.textContent =
    field === "quantity"
      ? Number(value).toLocaleString("en-PH")
      : value || (field === "lid" || field === "ink" || field === "cup_color" ? "—" : "");
  if (field === "ink") {
    const bg = value ? inkColor(value) : "transparent";
    cell.style.background = bg;
    cell.style.color = value ? inkTextColor(bg) : "#9ca3af";
    cell.classList.toggle("is-empty", !value);
  }
  cell.classList.add("saved");
  setTimeout(() => cell.classList.remove("saved"), 900);

  // keep the in-memory copy in step, then repaint the figures this line
  // feeds: its own amount, the card's cup count and total, and the group
  // heading above it
  for (const order of printOrders) {
    const item = order.items.find((x) => String(x.id) === String(itemId));
    if (!item) continue;
    if (field === "quantity") item.quantity = value;
    if (field === "label") item.label = value;
    if (field === "lid") item.lid_text = value;
    if (field === "ink") item.ink_color = value || null;
    if (field === "cup_color") item.cup_color = value || null;
    item.amount = Math.round(item.quantity * item.unit_price * 100) / 100;
    order.quantity = order.items.reduce((n, x) => n + x.quantity, 0);
    order.total = Math.round(order.items.reduce((n, x) => n + x.amount, 0) * 100) / 100;
    repaintPrintTotals(order);
    break;
  }
}

// Rewrite the derived numbers around one order, without touching the inputs.
function repaintPrintTotals(order) {
  const card = document.querySelector(`article[data-order="${order.id}"]`);
  if (card) {
    const sub = card.querySelector("p.font-mono");
    if (sub) sub.textContent = `${printShortDate(order.order_date)} · ${order.quantity.toLocaleString("en-PH")} cups`;
    const total = card.querySelector(".print-card-total");
    if (total) total.textContent = printMoney(order.total);
    order.items.forEach((i) => {
      const amt = card.querySelector(`tr[data-item="${i.id}"] .pm-amount`);
      if (amt) {
        amt.textContent = Number(i.amount).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
    });
  }
  // the group heading carries a cup total of its own
  const section = card ? card.closest("section") : null;
  if (section) {
    const cards = [...section.querySelectorAll("article[data-order]")];
    const cups = cards.reduce((n, el) => {
      const o = printOrders.find((x) => String(x.id) === el.dataset.order);
      return n + (o ? o.quantity : 0);
    }, 0);
    const spans = section.querySelectorAll(".group-cups");
    spans.forEach((el) => (el.textContent = `${cups.toLocaleString("en-PH")} cups`));
  }
}

async function loadPrintQueue() {
  // the board needs the catalogue to know which cups have colours and
  // which lids fit, so it is fetched before the first render rather than
  // when a form happens to open
  await loadPrintCatalogue();
  const board = document.getElementById("printBoard");
  const res = await fetch(`/api/print/orders?view=${encodeURIComponent(printState.view)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    board.innerHTML = `<p class="text-sm text-gray-500 py-10 text-center">${escapeHtml(err.message || "Could not load the print queue.")}</p>`;
    return;
  }
  const data = await res.json();
  printOrders = data.orders;

  Object.entries(data.counts).forEach(([k, v]) => {
    const el = document.querySelector(`#printViews [data-n="${k}"]`);
    if (el) el.textContent = v;
  });

  const open = data.counts.open;
  document.getElementById("printSubtitle").textContent =
    `${open} order${open === 1 ? "" : "s"} still open · ongoing first`;

  renderPrintBoard();
}

// ---------------------------------------------------------------------------
// Client drawer
// ---------------------------------------------------------------------------

function closePrintDrawer() {
  document.getElementById("printDrawer").classList.remove("print-drawer-open");
  document.getElementById("printScrim").classList.add("hidden");
}

async function openPrintClient(clientId) {
  const res = await fetch(`/api/print/clients/${clientId}`);
  if (!res.ok) {
    alert("Could not load that client.");
    return;
  }
  const data = await res.json();
  const c = data.client;
  const t = data.totals;

  document.getElementById("printDrawerLogo").outerHTML =
    printLogo(c.name, true, c.logo_filename).replace('class="', 'id="printDrawerLogo" class="');
  document.getElementById("printDrawerName").innerHTML =
    `<span class="print-edit" tabindex="0" role="button" data-client-field="name"
           data-client="${c.id}" title="Click to rename">${escapeHtml(c.name)}</span>`;
  document.getElementById("printDrawerSub").textContent =
    `${t.orders} order${t.orders === 1 ? "" : "s"} · ${Number(t.cups).toLocaleString("en-PH")} cups printed`;

  const contactRow = (label, field, value) => `
    <div class="flex items-center gap-2 py-1.5 border-b border-dashed border-gray-100 text-sm">
      <span class="text-xs text-gray-500 w-24 shrink-0">${label}</span>
      <input class="print-contact flex-1 min-w-0 border border-transparent hover:border-gray-200 focus:border-brand-blue rounded px-1 py-0.5 text-sm"
             data-client="${c.id}" data-field="${field}" value="${escapeHtml(value || "")}" placeholder="Not on file" />
    </div>`;

  const deals = data.deals.length
    ? `<table class="w-full text-sm">${data.deals
        .map(
          (d) =>
            `<tr class="border-b border-gray-100 last:border-0">
               <td class="py-1">${escapeHtml([d.family, d.size].filter(Boolean).join(" "))}</td>
               <td class="py-1 text-right font-mono">${printMoney(d.price)}</td>
             </tr>`
        )
        .join("")}</table>`
    : `<p class="text-xs text-gray-400 italic">No agreed prices yet — the grid rate applies.</p>`;

  const history = data.history.length
    ? `<table class="w-full text-sm">${data.history
        .map(
          (h) =>
            `<tr class="border-b border-gray-100 last:border-0">
               <td class="py-1 text-xs font-mono text-gray-400 whitespace-nowrap">${printShortDate(h.order_date)}</td>
               <td class="py-1 text-right font-mono">${Number(h.cups).toLocaleString("en-PH")}</td>
               <td class="py-1 text-right font-mono ${h.is_paid ? "text-gray-500" : "text-red-600"}">${printMoney(h.total)}</td>
             </tr>`
        )
        .join("")}</table>`
    : `<p class="text-xs text-gray-400 italic">No orders yet.</p>`;

  const sectionHead = (title) =>
    `<div class="flex items-center gap-2"><span class="text-[11px] text-gray-400 uppercase tracking-wide font-mono">${title}</span><span class="flex-1 h-px bg-gray-100"></span></div>`;

  document.getElementById("printDrawerBody").innerHTML = `
    <div class="grid grid-cols-3 gap-2">
      <div class="bg-gray-50 border border-gray-100 rounded-lg px-2 py-1.5">
        <p class="text-[11px] text-gray-400 uppercase tracking-wide font-mono">Orders</p>
        <p class="font-display font-semibold text-lg">${t.orders}</p>
      </div>
      <div class="bg-gray-50 border border-gray-100 rounded-lg px-2 py-1.5">
        <p class="text-[11px] text-gray-400 uppercase tracking-wide font-mono">Cups</p>
        <p class="font-display font-semibold text-lg">${Number(t.cups).toLocaleString("en-PH")}</p>
      </div>
      <div class="bg-gray-50 border border-gray-100 rounded-lg px-2 py-1.5">
        <p class="text-[11px] text-gray-400 uppercase tracking-wide font-mono">Owed</p>
        <p class="font-display font-semibold text-lg ${Number(t.owed) > 0 ? "text-red-600" : ""}">${Number(t.owed) > 0 ? printMoney(t.owed) : "—"}</p>
      </div>
    </div>
    <section class="flex flex-col gap-2">
      ${sectionHead("Logo")}
      <div class="flex items-center gap-3">
        ${printLogo(c.name, true, c.logo_filename)}
        <div class="flex-1 min-w-0">
          <p class="text-xs text-gray-500 mb-1.5">${
            c.logo_filename ? "The logo we print for them." : "No logo yet — a monogram stands in."
          }</p>
          <div class="flex gap-2">
            <label class="text-xs border border-gray-300 rounded-md px-2 py-1 cursor-pointer hover:border-gray-400 transition">
              ${c.logo_filename ? "Replace" : "Upload logo"}
              <input type="file" accept="image/png,image/jpeg,image/webp" class="hidden print-logo-input" data-client="${c.id}" />
            </label>
            ${
              c.logo_filename
                ? `<button type="button" class="print-logo-remove text-xs border border-gray-300 rounded-md px-2 py-1 text-gray-500 hover:text-red-600 hover:border-red-300 transition" data-client="${c.id}">Remove</button>`
                : ""
            }
          </div>
          <p class="print-logo-note text-[11px] text-gray-400 mt-1"></p>
        </div>
      </div>
    </section>
    <section class="flex flex-col gap-2">
      ${sectionHead("Contact")}
      <div>
        ${contactRow("Instagram", "instagram", c.instagram)}
        ${contactRow("Facebook", "facebook", c.facebook)}
        ${contactRow("Contact", "contact_person", c.contact_person)}
        ${contactRow("Phone", "phone", c.phone)}
        ${contactRow("Email", "email", c.email)}
      </div>
      <p class="text-[11px] text-gray-400">Type to edit — saves when you click away.</p>
    </section>
    <section class="flex flex-col gap-2">${sectionHead("Agreed prices")}${deals}</section>
    <section class="flex flex-col gap-2">${sectionHead("Recent orders")}${history}</section>`;

  const nameCell = document.querySelector('[data-client-field="name"]');
  if (nameCell) wireEditCell(nameCell);

  const drawerBody = document.getElementById("printDrawerBody");
  const note = drawerBody.querySelector(".print-logo-note");
  const fileInput = drawerBody.querySelector(".print-logo-input");
  if (fileInput) {
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      note.textContent = "Uploading…";
      const form = new FormData();
      form.append("logo", file);
      const res = await fetch(`/api/print/clients/${fileInput.dataset.client}/logo`, {
        method: "POST",
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        note.textContent = "";
        alert(data.message || "Could not upload that logo.");
        return;
      }
      await openPrintClient(fileInput.dataset.client);
      loadPrintQueue();
    });
  }
  const removeBtn = drawerBody.querySelector(".print-logo-remove");
  if (removeBtn) {
    removeBtn.addEventListener("click", async () => {
      const res = await fetch(`/api/print/clients/${removeBtn.dataset.client}/logo`, { method: "DELETE" });
      if (!res.ok) {
        alert("Could not remove that logo.");
        return;
      }
      await openPrintClient(removeBtn.dataset.client);
      loadPrintQueue();
    });
  }

  // contact fields save on blur - no save button to forget
  document.querySelectorAll(".print-contact").forEach((input) => {
    input.addEventListener("change", async () => {
      const body = {};
      body[input.dataset.field] = input.value.trim();
      const res = await fetch(`/api/print/clients/${input.dataset.client}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(err.message || "Could not save that.");
      }
    });
  });

  document.getElementById("printScrim").classList.remove("hidden");
  document.getElementById("printDrawer").classList.add("print-drawer-open");
}

// ---------------------------------------------------------------------------
// New order form
// ---------------------------------------------------------------------------

function poItemRow() {
  const cat = printCatalogue || { cups: [], lids: [], fits: {} };
  const cupOptions =
    `<option value="">Pick a cup…</option>` +
    cat.cups.map((c) => `<option value="${c.id}">${escapeHtml(c.label)}</option>`).join("");

  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td class="py-1 pr-2">
      <select class="po-cup w-full border border-gray-300 rounded px-2 py-1">${cupOptions}</select>
      <select class="po-cup-colour w-full border border-gray-200 rounded px-2 py-1 mt-1 text-xs hidden"></select>
    </td>
    <td class="py-1 pr-2"><select class="po-lid w-full border border-gray-300 rounded px-2 py-1" disabled><option value="">Pick a cup first</option></select></td>
    <td class="py-1 pr-2"><input class="po-ink w-full border border-gray-300 rounded px-2 py-1" placeholder="Black" list="poInkList" /></td>
    <td class="py-1 pr-2"><input class="po-qty w-full border border-gray-300 rounded px-2 py-1 text-right" type="number" min="0" step="1" /></td>
    <td class="py-1"><button class="po-remove text-gray-400 hover:text-red-600" aria-label="Remove">&#10005;</button></td>`;

  const cupSel = tr.querySelector(".po-cup");
  const lidSel = tr.querySelector(".po-lid");
  const qty = tr.querySelector(".po-qty");

  // the lid list only ever offers what fits the chosen cup
  const fillLids = () => {
    const allowed = (cat.fits[cupSel.value] || []).map(String);
    const options = cat.lids.filter((l) => allowed.includes(String(l.id)));
    lidSel.disabled = !cupSel.value;
    lidSel.innerHTML =
      `<option value="">${cupSel.value ? "No lid" : "Pick a cup first"}</option>` +
      options.map((l) => `<option value="${l.id}">${escapeHtml(l.family)}</option>`).join("");
  };

  const colourSel = tr.querySelector(".po-cup-colour");
  const fillColours = () => {
    const options = printCupColours(cupSel.value);
    colourSel.classList.toggle("hidden", !options.length);
    colourSel.innerHTML =
      `<option value="">Cup colour…</option>` +
      options.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  };

  cupSel.addEventListener("change", () => {
    fillLids();
    fillColours();
  });
  tr.querySelector(".po-remove").addEventListener("click", () => tr.remove());
  return tr;
}

async function openPrintOrderForm() {
  await loadPrintCatalogue();
  document.getElementById("poClient").value = "";
  document.getElementById("poDate").value = new Date().toISOString().slice(0, 10);
  document.getElementById("poDue").value = "";
  document.getElementById("poRemarks").value = "";
  ["poRush", "poFrame", "poPaid"].forEach((id) => (document.getElementById(id).checked = false));

  const body = document.getElementById("poItems");
  body.innerHTML = "";
  body.appendChild(poItemRow());

  const list = document.getElementById("poClientList");
  list.innerHTML = printClients.map((c) => `<option value="${escapeHtml(c.name)}"></option>`).join("");

  // suggest the inks already on the board rather than making them be typed
  // from memory
  const inks = [...new Set(printOrders.flatMap((o) => o.items.map((i) => i.ink_color)).filter(Boolean))].sort();
  let inkList = document.getElementById("poInkList");
  if (!inkList) {
    inkList = document.createElement("datalist");
    inkList.id = "poInkList";
    document.body.appendChild(inkList);
  }
  inkList.innerHTML = inks.map((i) => `<option value="${escapeHtml(i)}"></option>`).join("");


  const modal = document.getElementById("printOrderModal");
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  document.getElementById("poClient").focus();
}

function closePrintOrderForm() {
  const modal = document.getElementById("printOrderModal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
}

async function savePrintOrder() {
  const cat = printCatalogue || { cups: [], lids: [] };
  const items = [...document.querySelectorAll("#poItems tr")]
    .map((tr) => {
      const cup = cat.cups.find((c) => String(c.id) === tr.querySelector(".po-cup").value);
      const lid = cat.lids.find((l) => String(l.id) === tr.querySelector(".po-lid").value);
      return {
        product_id: cup ? cup.id : null,
        lid_product_id: lid ? lid.id : null,
        label: cup ? cup.label : "",
        lid: lid ? lid.family : "",
        // ink is per line: one order can print different colours on
        // different cups
        ink: tr.querySelector(".po-ink").value.trim(),
        cup_color: tr.querySelector(".po-cup-colour").value.trim(),
        quantity: Number(tr.querySelector(".po-qty").value || 0),
      };
    })
    .filter((i) => i.product_id);

  if (!items.length) {
    alert("Pick a cup on at least one line before saving.");
    return;
  }

  const res = await fetch("/api/print/orders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client: document.getElementById("poClient").value.trim(),
      order_date: document.getElementById("poDate").value,
      due_date: document.getElementById("poDue").value,
      is_rush: document.getElementById("poRush").checked,
      needs_new_frame: document.getElementById("poFrame").checked,
      is_paid: document.getElementById("poPaid").checked,
      remarks: document.getElementById("poRemarks").value,
      items,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.message || "Could not save that order.");
    return;
  }
  closePrintOrderForm();
  await loadPrintClients();
  loadPrintQueue();
}

async function loadPrintClients() {
  const res = await fetch("/api/print/clients");
  if (!res.ok) return;
  const data = await res.json();
  printClients = data.clients;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

if (tabPrintBtn) {
  document.querySelectorAll("#printViews .print-view-btn").forEach((b) => {
    b.classList.toggle("active-print-view", b.dataset.view === printState.view);
    b.addEventListener("click", () => {
      document.querySelectorAll("#printViews .print-view-btn").forEach((x) => x.classList.remove("active-print-view"));
      b.classList.add("active-print-view");
      printState.view = b.dataset.view;
      savePrintPrefs();
      loadPrintQueue();
    });
  });

  [["printGroup", "group"], ["printSort", "sort"], ["printCols", "cols"]].forEach(([id, key]) => {
    const sel = document.getElementById(id);
    sel.value = printState[key];
    sel.addEventListener("change", () => {
      printState[key] = sel.value;
      savePrintPrefs();
      renderPrintBoard();
    });
  });

  document.getElementById("printSearch").addEventListener("input", renderPrintBoard);

  // Group / sort / layout are settings, not daily controls - they stay out
  // of the way until asked for, and the board remembers if you like them
  // open.
  const controls = document.getElementById("printControls");
  const controlsBtn = document.getElementById("printControlsBtn");
  const applyControlsVisibility = () => {
    controls.classList.toggle("hidden", !printState.showControls);
    controlsBtn.classList.toggle("bg-blue-50", printState.showControls);
    controlsBtn.classList.toggle("border-blue-200", printState.showControls);
    controlsBtn.classList.toggle("text-brand-blue", printState.showControls);
  };
  controlsBtn.addEventListener("click", () => {
    printState.showControls = !printState.showControls;
    if (!printState.showControls) document.getElementById("printCustomize").classList.add("hidden");
    savePrintPrefs();
    applyControlsVisibility();
  });
  applyControlsVisibility();

  const czBtn = document.getElementById("printCzBtn");
  czBtn.addEventListener("click", () => {
    document.getElementById("printCustomize").classList.toggle("hidden");
  });

  document.querySelectorAll("#printFieldToggles .print-toggle").forEach((t) => {
    const field = t.dataset.f;
    t.classList.toggle("active-print-toggle", !!printState.fields[field]);
    t.addEventListener("click", () => {
      printState.fields[field] = !printState.fields[field];
      t.classList.toggle("active-print-toggle", printState.fields[field]);
      savePrintPrefs();
      renderPrintBoard();
    });
  });

  document.getElementById("printNewBtn").addEventListener("click", openPrintOrderForm);
  document.getElementById("poCancel").addEventListener("click", closePrintOrderForm);
  document.getElementById("poSave").addEventListener("click", savePrintOrder);
  document.getElementById("poAddRow").addEventListener("click", () => {
    document.getElementById("poItems").appendChild(poItemRow());
  });

  document.getElementById("printDrawerClose").addEventListener("click", closePrintDrawer);
  document.getElementById("printScrim").addEventListener("click", closePrintDrawer);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closePrintDrawer();
      closePrintOrderForm();
    }
  });

  loadPrintClients();
}


// ---------------------------------------------------------------------------
// App switching (Payroll & HRMS <-> Admin)
//
// One navbar, two apps. The tabs carry data-app, so switching is a matter
// of showing that app's tabs and landing on its first one. The brand block
// in the header is the switch - its subtitle already named the app.
//
// Crossing into Payroll asks for the PIN again. That is not a wall against
// someone who knows it; it is there because the shop computer is shared and
// a manager's session sits open on it.
// ---------------------------------------------------------------------------

const appSwitchBtn = document.getElementById("appSwitchBtn");
const appMenu = document.getElementById("appMenu");
const appLabel = document.getElementById("appLabel");
const payrollLockModal = document.getElementById("payrollLockModal");

const APP_NAMES = { payroll: "Payroll and HRMS", admin: "Admin" };
// where each app opens: the first thing you want to see in it
const APP_HOME = { payroll: "dashboard", admin: "print" };

let currentApp = "payroll";
// seeded from the server so a reload inside the unlock window doesn't
// re-prompt, and an expired one does
let payrollUnlocked = document.body.dataset.payrollUnlocked === "1";
let pendingApp = null; // the app to enter once the PIN lands

function appTabButtons(app) {
  return [...document.querySelectorAll(".tab-btn[data-app]")].filter((b) => b.dataset.app === app);
}

function applyApp(app) {
  currentApp = app;
  if (appLabel) appLabel.textContent = APP_NAMES[app];

  document.querySelectorAll(".tab-btn[data-app]").forEach((b) => {
    b.classList.toggle("hidden", b.dataset.app !== app);
  });
  document.querySelectorAll("#appMenu .app-choice").forEach((c) => {
    c.querySelector(".app-tick").classList.toggle("hidden", c.dataset.app !== app);
  });
  // the padlock only means anything while payroll is actually locked
  const lock = document.querySelector('#appMenu .app-choice[data-app="payroll"] .app-lock');
  if (lock) lock.classList.toggle("hidden", payrollUnlocked);

  try {
    localStorage.setItem("mpd.app", app);
  } catch (e) {
    // storage blocked - the app just won't be remembered next visit
  }

  // land on a tab that belongs to this app, keeping the current one if it
  // already does
  const active = document.querySelector(".tab-btn.active-tab");
  if (!active || active.dataset.app !== app) {
    const home = TABS[APP_HOME[app]] ? APP_HOME[app] : null;
    const first = appTabButtons(app)[0];
    if (home) showTab(home);
    else if (first) first.click();
  }
}

function switchApp(app) {
  closeAppMenu();
  if (app === currentApp) return;
  if (app === "payroll" && !payrollUnlocked) {
    pendingApp = app;
    openPayrollLock();
    return;
  }
  if (app === "admin" && payrollUnlocked) {
    // leaving payroll drops the unlock, so coming back asks again
    fetch("/api/payroll/lock", { method: "POST" }).catch(() => {});
    payrollUnlocked = false;
  }
  applyApp(app);
}

function openAppMenu() {
  if (appMenu) appMenu.classList.remove("hidden");
}
function closeAppMenu() {
  if (appMenu) appMenu.classList.add("hidden");
}

function openPayrollLock() {
  if (!payrollLockModal) return;
  document.getElementById("payrollLockPin").value = "";
  document.getElementById("payrollLockError").textContent = "";
  payrollLockModal.classList.remove("hidden");
  payrollLockModal.classList.add("flex");
  document.getElementById("payrollLockPin").focus();
}

function closePayrollLock() {
  if (!payrollLockModal) return;
  payrollLockModal.classList.add("hidden");
  payrollLockModal.classList.remove("flex");
  pendingApp = null;
}

async function submitPayrollPin() {
  const pin = document.getElementById("payrollLockPin").value;
  const errorEl = document.getElementById("payrollLockError");
  const res = await fetch("/api/payroll/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pin }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    errorEl.textContent = data.message || "Could not unlock.";
    document.getElementById("payrollLockPin").select();
    return;
  }
  payrollUnlocked = true;
  const target = pendingApp || "payroll";
  closePayrollLock();
  applyApp(target);
}

// A locked reply can also arrive mid-session, when the ten minutes run out
// while the payroll tab is open. Rather than each caller handling 423, one
// wrapper turns it into the same prompt.
const _fetch = window.fetch;
window.fetch = async function (...args) {
  const res = await _fetch.apply(this, args);
  if (res.status === 423) {
    payrollUnlocked = false;
    openPayrollLock();
  }
  return res;
};

if (appSwitchBtn) {
  appSwitchBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    appMenu.classList.contains("hidden") ? openAppMenu() : closeAppMenu();
  });
  document.querySelectorAll("#appMenu .app-choice").forEach((c) => {
    c.addEventListener("click", () => switchApp(c.dataset.app));
  });
  document.addEventListener("click", (e) => {
    if (appMenu && !appMenu.contains(e.target) && e.target !== appSwitchBtn) closeAppMenu();
  });

  document.getElementById("payrollLockCancel").addEventListener("click", closePayrollLock);
  document.getElementById("payrollLockGo").addEventListener("click", submitPayrollPin);
  document.getElementById("payrollLockPin").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitPayrollPin();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeAppMenu();
      closePayrollLock();
    }
  });

  // open where they left off, but never straight into a locked payroll
  let remembered = "payroll";
  try {
    remembered = localStorage.getItem("mpd.app") || "payroll";
  } catch (e) {
    // storage blocked - fall back to payroll
  }
  if (remembered === "payroll" && !payrollUnlocked) remembered = "admin";
  applyApp(remembered);
}


// ---------------------------------------------------------------------------
// Catalogue - the cups and lids from the price list, and which lid fits
// which cup. Loaded once and shared by the order form and the pricing page.
// ---------------------------------------------------------------------------

let printCatalogue = null;

async function loadPrintCatalogue() {
  if (printCatalogue) return printCatalogue;
  const res = await fetch("/api/print/catalogue");
  if (!res.ok) return null;
  printCatalogue = await res.json();
  return printCatalogue;
}

// what a line costs: the print tier for its quantity, plus the lid
function priceFor(cup, lid, qty) {
  if (!cup) return 0;
  const tier = qty >= 1000 ? cup.print_only_1k : cup.print_only_sub1k;
  const print = tier != null ? tier : (cup.print_only_sub1k != null ? cup.print_only_sub1k : cup.print_only_1k) || 0;
  const lidPrice = lid ? (lid.wholesale != null ? lid.wholesale : lid.retail) || 0 : 0;
  return Math.round((print + lidPrice) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Clients page
// ---------------------------------------------------------------------------

let printClientRows = [];

async function loadPrintClientsPage() {
  const body = document.getElementById("printClientsBody");
  const res = await fetch("/api/print/clients?with_totals=1");
  if (!res.ok) {
    body.innerHTML = `<tr><td colspan="7" class="px-3 py-6 text-center text-gray-500">Could not load the clients.</td></tr>`;
    return;
  }
  const data = await res.json();
  printClientRows = data.clients;
  renderPrintClients();
}

function renderPrintClients() {
  const q = (document.getElementById("printClientSearch").value || "").trim().toLowerCase();
  const rows = printClientRows.filter((c) => !q || c.name.toLowerCase().includes(q));
  const owed = rows.reduce((n, c) => n + Number(c.owed || 0), 0);

  document.getElementById("printClientsSubtitle").textContent =
    `${rows.length} client${rows.length === 1 ? "" : "s"} · ${printMoney(owed)} outstanding`;

  const body = document.getElementById("printClientsBody");
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="px-3 py-6 text-center text-gray-400 italic">Nobody matches that.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map(
      (c) => `
      <tr class="hover:bg-gray-50">
        <td class="px-3 py-2">
          <span class="inline-flex items-center gap-2">
            ${printLogo(c.name, false, c.logo_filename).replace("w-9 h-9 text-sm", "w-6 h-6 text-[10px]")}
            <button class="print-client-btn font-medium hover:text-brand-blue text-left" data-client="${c.id}">${escapeHtml(c.name)} &rsaquo;</button>
          </span>
        </td>
        <td class="px-3 py-2 ${c.instagram ? "" : "text-gray-300"}">${escapeHtml(c.instagram || "—")}</td>
        <td class="px-3 py-2 ${c.facebook ? "" : "text-gray-300"}">${escapeHtml(c.facebook || "—")}</td>
        <td class="px-3 py-2 ${c.phone ? "" : "text-gray-300"}">${escapeHtml(c.phone || "—")}</td>
        <td class="px-3 py-2 text-right font-mono">${c.order_count}</td>
        <td class="px-3 py-2 text-right font-mono">${Number(c.cups || 0).toLocaleString("en-PH")}</td>
        <td class="px-3 py-2 text-right font-mono ${Number(c.owed) > 0 ? "text-red-600" : "text-gray-300"}">${
          Number(c.owed) > 0 ? printMoney(c.owed) : "—"
        }</td>
      </tr>`
    )
    .join("");

  body.querySelectorAll(".print-client-btn").forEach((b) => {
    b.addEventListener("click", () => openPrintClient(b.dataset.client));
  });
}

// ---------------------------------------------------------------------------
// Cup pricing page
// ---------------------------------------------------------------------------

// Cost is the one figure a client must never see, so it is superuser-only
// server-side and simply absent here for everyone else.
const PRICE_COLUMNS = [
  ["cost", "Cost"],
  ["retail", "Retail"],
  ["wholesale", "Wholesale"],
  ["print_only_1k", "Print 1,000+"],
  ["print_only_sub1k", "Print <1,000"],
];

async function loadPricing() {
  const cat = await loadPrintCatalogue();
  const host = document.getElementById("pricingTables");
  if (!cat) {
    host.innerHTML = `<p class="text-sm text-gray-500 py-8 text-center">Could not load the price list.</p>`;
    return;
  }
  renderPricing();
  renderQuote();
}

function usageFor(id) {
  const u = (printCatalogue.usage || {})[String(id)];
  return u || { lines: 0, cups: 0 };
}

// one family at a time - PPY's four sizes belong together, and a run of
// sizes down a short table reads faster than the same rows in one long one
function familyBlock(family, items, columns) {
  const rows = items
    .map((p) => {
      const used = usageFor(p.id);
      const cells = columns
        .map(([key]) => {
          const missing = p[key] == null;
          return `<td class="px-3 py-1.5 text-right">
            <span class="print-edit price-cell font-mono ${missing ? "text-gray-300" : ""}"
                  tabindex="0" role="button" data-product="${p.id}" data-field="${key}"
                  title="Click to edit">${missing ? "—" : Number(p[key]).toFixed(2)}</span>
          </td>`;
        })
        .join("");
      return `<tr class="hover:bg-gray-50">
        <td class="px-3 py-1.5 font-medium whitespace-nowrap">${escapeHtml(p.size || p.family)}</td>
        ${cells}
        <td class="px-3 py-1.5 text-right font-mono text-xs ${used.cups ? "text-gray-500" : "text-gray-300"}">${
          used.cups ? used.cups.toLocaleString("en-PH") : "—"
        }</td>
      </tr>`;
    })
    .join("");

  const familyCups = items.reduce((n, p) => n + usageFor(p.id).cups, 0);

  return `
    <section class="border border-gray-200 bg-white rounded-xl shadow-sm overflow-hidden">
      <div class="flex items-baseline gap-2 px-3 py-2 border-b border-gray-200 bg-gray-50">
        <h4 class="font-semibold text-sm">${escapeHtml(family)}</h4>
        <span class="text-[11px] font-mono text-gray-400">${items.length} size${items.length === 1 ? "" : "s"}</span>
        <span class="ml-auto text-[11px] font-mono text-gray-400">${
          familyCups ? familyCups.toLocaleString("en-PH") + " printed" : "not used yet"
        }</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-[10px] uppercase tracking-wide font-mono text-gray-400 border-b border-gray-100">
              <th class="text-left px-3 py-1.5">Size</th>
              ${columns.map(([, label]) => `<th class="text-right px-3 py-1.5 whitespace-nowrap">${label}</th>`).join("")}
              <th class="text-right px-3 py-1.5">Printed</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">${rows}</tbody>
        </table>
      </div>
    </section>`;
}

function renderPricing() {
  const cat = printCatalogue;
  const q = (document.getElementById("pricingSearch").value || "").trim().toLowerCase();
  const cols = PRICE_COLUMNS.filter(([k]) => cat.shows_cost || k !== "cost");
  const lidCols = cols.filter(([k]) => ["cost", "retail", "wholesale"].includes(k));

  const cups = cat.cups.filter((p) => !q || p.label.toLowerCase().includes(q));
  const lids = cat.lids.filter((p) => !q || p.family.toLowerCase().includes(q));

  const gaps =
    cat.cups.filter((p) => p.print_only_1k == null && p.print_only_sub1k == null).length;
  document.getElementById("pricingSubtitle").textContent =
    `${cat.cups.length} cups · ${cat.lids.length} lids` + (gaps ? ` · ${gaps} without a print price` : "");

  const families = [];
  cups.forEach((p) => {
    const hit = families.find((f) => f.name === p.family);
    if (hit) hit.items.push(p);
    else families.push({ name: p.family, items: [p] });
  });

  const host = document.getElementById("pricingTables");
  if (!families.length && !lids.length) {
    host.innerHTML = `<p class="text-sm text-gray-400 italic py-8 text-center">Nothing matches that.</p>`;
    return;
  }

  host.innerHTML =
    families.map((f) => familyBlock(f.name, f.items, cols)).join("") +
    (lids.length ? familyBlock("Lids", lids, lidCols) : "");

  host.querySelectorAll(".print-edit").forEach(wireEditCell);
}

// ---------------------------------------------------------------------------
// Quote calculator
//
// Same arithmetic the order form and the server use - print tier for the
// quantity, plus the lid - so a number quoted here is the number that will
// appear on the order.
// ---------------------------------------------------------------------------

let quoteRows = [{ cup: "", lid: "", qty: 500 }];

function quoteLineTotals() {
  const cat = printCatalogue || { cups: [], lids: [] };
  return quoteRows.map((r) => {
    const cup = cat.cups.find((c) => String(c.id) === String(r.cup));
    const lid = cat.lids.find((l) => String(l.id) === String(r.lid));
    const qty = Number(r.qty || 0);
    const unit = cup ? priceFor(cup, lid, qty) : 0;
    return { cup, lid, qty, unit, amount: Math.round(unit * qty * 100) / 100 };
  });
}

function renderQuote() {
  const cat = printCatalogue;
  if (!cat) return;
  const host = document.getElementById("quoteLines");

  host.innerHTML = quoteRows
    .map((r, idx) => {
      const allowed = (cat.fits[r.cup] || []).map(String);
      const lidOptions = cat.lids.filter((l) => allowed.includes(String(l.id)));
      return `
      <div class="flex flex-col gap-1.5 pb-3 ${idx ? "border-t border-gray-100 pt-3" : ""}" data-row="${idx}">
        <div class="flex items-center gap-1.5">
          <select class="q-cup flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-sm">
            <option value="">Pick a cup…</option>
            ${cat.cups.map((c) => `<option value="${c.id}"${String(c.id) === String(r.cup) ? " selected" : ""}>${escapeHtml(c.label)}</option>`).join("")}
          </select>
          ${quoteRows.length > 1 ? `<button class="q-remove text-gray-400 hover:text-red-600 shrink-0" title="Remove">&#10005;</button>` : ""}
        </div>
        <select class="q-lid border border-gray-300 rounded px-2 py-1 text-sm" ${r.cup ? "" : "disabled"}>
          <option value="">${r.cup ? "No lid" : "Pick a cup first"}</option>
          ${lidOptions.map((l) => `<option value="${l.id}"${String(l.id) === String(r.lid) ? " selected" : ""}>${escapeHtml(l.family)}</option>`).join("")}
        </select>
        <div class="flex items-center gap-2">
          <input class="q-qty w-24 border border-gray-300 rounded px-2 py-1 text-sm text-right" type="number" min="0" step="50" value="${r.qty}" />
          <span class="text-xs text-gray-400">cups</span>
          <span class="q-line ml-auto text-sm font-mono"></span>
        </div>
      </div>`;
    })
    .join("");

  const totals = quoteLineTotals();
  host.querySelectorAll("[data-row]").forEach((el, idx) => {
    const t = totals[idx];
    const line = el.querySelector(".q-line");
    line.textContent = t.cup ? `${t.unit.toFixed(2)} × ${t.qty.toLocaleString("en-PH")}` : "";
    line.title = t.cup ? printMoney(t.amount) : "";

    el.querySelector(".q-cup").addEventListener("change", (e) => {
      quoteRows[idx].cup = e.target.value;
      quoteRows[idx].lid = "";      // the old lid may not fit the new cup
      renderQuote();
    });
    el.querySelector(".q-lid").addEventListener("change", (e) => {
      quoteRows[idx].lid = e.target.value;
      renderQuote();
    });
    el.querySelector(".q-qty").addEventListener("input", (e) => {
      quoteRows[idx].qty = Number(e.target.value || 0);
      updateQuoteTotals();
    });
    const rm = el.querySelector(".q-remove");
    if (rm) {
      rm.addEventListener("click", () => {
        quoteRows.splice(idx, 1);
        renderQuote();
      });
    }
  });

  updateQuoteTotals();
}

function updateQuoteTotals() {
  const totals = quoteLineTotals();
  const host = document.getElementById("quoteLines");
  host.querySelectorAll("[data-row]").forEach((el, idx) => {
    const t = totals[idx];
    const line = el.querySelector(".q-line");
    line.textContent = t.cup ? `${t.unit.toFixed(2)} × ${t.qty.toLocaleString("en-PH")}` : "";
  });
  const total = totals.reduce((n, t) => n + t.amount, 0);
  const cups = totals.reduce((n, t) => n + (t.cup ? t.qty : 0), 0);
  document.getElementById("quoteTotal").textContent = printMoney(total);
  document.getElementById("quoteCups").textContent =
    `${cups.toLocaleString("en-PH")} cup${cups === 1 ? "" : "s"}`;
}

function quoteText() {
  const totals = quoteLineTotals().filter((t) => t.cup);
  if (!totals.length) return "";
  const lines = totals.map((t) => {
    const bits = [t.cup.label];
    if (t.lid) bits.push(t.lid.family);
    return `${t.qty.toLocaleString("en-PH")} x ${bits.join(" + ")} — ${printMoney(t.unit)} each — ${printMoney(t.amount)}`;
  });
  const total = totals.reduce((n, t) => n + t.amount, 0);
  return `Metro Packaging Depot — cup printing quote\n\n${lines.join("\n")}\n\nTotal: ${printMoney(total)}`;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

if (tabPrintClientsBtn) {
  document.getElementById("printClientSearch").addEventListener("input", renderPrintClients);
}
if (tabPricingBtn) {
  document.getElementById("pricingSearch").addEventListener("input", () => {
    if (printCatalogue) renderPricing();
  });

  document.getElementById("quoteAddBtn").addEventListener("click", () => {
    quoteRows.push({ cup: "", lid: "", qty: 500 });
    renderQuote();
  });
  document.getElementById("quoteClearBtn").addEventListener("click", () => {
    quoteRows = [{ cup: "", lid: "", qty: 500 }];
    renderQuote();
    document.getElementById("quoteCopied").textContent = "";
  });
  document.getElementById("quoteCopyBtn").addEventListener("click", async () => {
    const text = quoteText();
    const note = document.getElementById("quoteCopied");
    if (!text) {
      note.textContent = "Pick a cup first.";
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      note.textContent = "Copied — paste it to the client.";
    } catch (e) {
      // clipboard blocked (an insecure origin, usually) - show it instead
      // so it can still be copied by hand
      note.textContent = "";
      alert(text);
    }
    setTimeout(() => (note.textContent = ""), 4000);
  });
}


// Pick a cup or a lid from the catalogue, in place on the card. The lid
// list is filtered to what fits the cup on that line, the same rules the
// order form uses.
async function beginProductPick(cell, field) {
  const cat = await loadPrintCatalogue();
  if (!cat) return;

  const shown = cell.textContent;
  const current = cell.dataset.value || "";
  const isLid = field === "lid_product_id";

  let options;
  if (field === "cup_color") {
    options = [{ id: "", label: "— colour" }].concat(
      printCupColours(cell.dataset.cup).map((c) => ({ id: c, label: c }))
    );
  } else if (isLid) {
    const cupId = cell.dataset.cup;
    const allowed = (cat.fits[cupId] || []).map(String);
    options = [{ id: "", label: "No lid" }].concat(
      cat.lids.filter((l) => allowed.includes(String(l.id))).map((l) => ({ id: l.id, label: l.family }))
    );
  } else {
    options = cat.cups.map((c) => ({ id: c.id, label: c.label }));
  }

  const sel = document.createElement("select");
  sel.className = "print-cell-input";
  sel.innerHTML = options
    .map((o) => `<option value="${o.id}"${String(o.id) === current ? " selected" : ""}>${escapeHtml(o.label)}</option>`)
    .join("");

  cell.textContent = "";
  cell.appendChild(sel);
  sel.focus();

  let settled = false;
  const finish = async (commit) => {
    if (settled) return;
    settled = true;
    const value = sel.value;
    if (!commit || String(value) === current) {
      cell.textContent = shown;
      return;
    }
    const res = await fetch(`/api/print/items/${cell.dataset.item}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        [field]: value === "" ? null : field === "cup_color" ? value : Number(value),
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.message || "Could not change that.");
      cell.textContent = shown;
      return;
    }
    // changing the cup can invalidate the lid and always moves the price,
    // so the board is reloaded rather than patched
    loadPrintQueue();
  };

  sel.addEventListener("change", () => finish(true));
  sel.addEventListener("blur", () => finish(true));
  sel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  });
}


// ---------------------------------------------------------------------------
// Card menu and deleting an order
//
// Delete lives behind a menu rather than on the card face. The card is
// something you click twenty times a day to move work along, and a delete
// button in that space is a mis-click waiting to happen.
// ---------------------------------------------------------------------------

let printCardMenu = null;

function closeCardMenu() {
  if (printCardMenu) {
    printCardMenu.remove();
    printCardMenu = null;
  }
}

function openCardMenu(btn) {
  closeCardMenu();
  const orderId = btn.dataset.order;

  const order = printOrders.find((o) => String(o.id) === String(orderId));

  // scheduling from the menu as well as by dragging - a touch screen or a
  // trackpad makes dragging across seven columns a nuisance
  const days = weekDates()
    .map((d) => {
      const iso = isoDay(d);
      const on = order && order.scheduled_date === iso;
      return `<button type="button" class="cm-day w-full text-left px-3 py-1 hover:bg-gray-50 ${
        on ? "text-brand-blue font-semibold" : ""
      }" data-day="${iso}">${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}${on ? " ✓" : ""}</button>`;
    })
    .join("");

  const menu = document.createElement("div");
  menu.className = "fixed z-50 bg-white border border-gray-200 rounded-lg shadow-lg py-1 w-48 text-sm";
  menu.innerHTML = `
    <p class="px-3 pt-1 pb-1 text-[10px] uppercase tracking-wide font-mono text-gray-400">Print on</p>
    ${days}
    ${order && order.scheduled_date ? `<button type="button" class="cm-day w-full text-left px-3 py-1 text-gray-500 hover:bg-gray-50" data-day="">Not scheduled</button>` : ""}
    <div class="border-t border-gray-100 mt-1 pt-1">
      <button type="button" class="cm-delete w-full text-left px-3 py-1.5 text-red-600 hover:bg-red-50">Delete order…</button>
    </div>`;
  document.body.appendChild(menu);

  menu.querySelectorAll(".cm-day").forEach((b) => {
    b.addEventListener("click", () => {
      closeCardMenu();
      scheduleOrder(orderId, b.dataset.day);
      if (printState.mode !== "week") loadPrintQueue();
    });
  });

  const r = btn.getBoundingClientRect();
  const top = r.bottom + 80 > window.innerHeight ? r.top - menu.offsetHeight - 4 : r.bottom + 4;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${Math.min(r.left - 120, window.innerWidth - menu.offsetWidth - 8)}px`;

  menu.querySelector(".cm-delete").addEventListener("click", () => {
    closeCardMenu();
    askDeleteOrder(orderId);
  });
  printCardMenu = menu;
}

document.addEventListener("click", (e) => {
  if (printCardMenu && !printCardMenu.contains(e.target) && !e.target.closest(".print-card-menu")) {
    closeCardMenu();
  }
});

let printDeleteId = null;

function askDeleteOrder(orderId) {
  const order = printOrders.find((o) => String(o.id) === String(orderId));
  if (!order) return;
  printDeleteId = orderId;

  document.getElementById("printDeleteWhat").textContent =
    `${order.client_name} · ${printShortDate(order.order_date)}`;
  const lines = order.items.length;
  document.getElementById("printDeleteDetail").textContent =
    `${lines} line${lines === 1 ? "" : "s"} · ${order.quantity.toLocaleString("en-PH")} cups · ${printMoney(order.total)}`;

  const modal = document.getElementById("printDeleteModal");
  modal.classList.remove("hidden");
  modal.classList.add("flex");
  document.getElementById("printDeleteCancel").focus();
}

function closeDeleteModal() {
  const modal = document.getElementById("printDeleteModal");
  modal.classList.add("hidden");
  modal.classList.remove("flex");
  printDeleteId = null;
}

if (document.getElementById("printDeleteModal")) {
  document.getElementById("printDeleteCancel").addEventListener("click", closeDeleteModal);
  document.getElementById("printDeleteModal").addEventListener("click", (e) => {
    if (e.target.id === "printDeleteModal") closeDeleteModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeCardMenu();
      closeDeleteModal();
    }
  });
  document.getElementById("printDeleteGo").addEventListener("click", async () => {
    if (!printDeleteId) return;
    const btn = document.getElementById("printDeleteGo");
    btn.disabled = true;
    const res = await fetch(`/api/print/orders/${printDeleteId}`, { method: "DELETE" });
    btn.disabled = false;
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.message || "Could not delete that order.");
      return;
    }
    closeDeleteModal();
    loadPrintQueue();
  });
}


// ---------------------------------------------------------------------------
// The press week
//
// A job's scheduled date is the day it goes on the press, which is not the
// day the client needs it - you print on Tuesday for a Friday deadline.
// Unscheduled open work sits on the left; drag it onto a day, or drop it
// back to take it off the schedule again.
// ---------------------------------------------------------------------------

let weekStart = mondayOf(new Date());

function mondayOf(d) {
  const copy = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (copy.getDay() + 6) % 7; // Monday = 0
  copy.setDate(copy.getDate() - day);
  return copy;
}

function isoDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function weekDates() {
  return [...Array(7)].map((_, i) => {
    const d = new Date(weekStart);
    d.setDate(d.getDate() + i);
    return d;
  });
}

function setPrintMode(mode) {
  printState.mode = mode;
  savePrintPrefs();
  document.getElementById("printBoard").classList.toggle("hidden", mode === "week");
  document.getElementById("printWeek").classList.toggle("hidden", mode !== "week");
  document.getElementById("printModeBoard").classList.toggle("print-mode-on", mode === "board");
  document.getElementById("printModeWeek").classList.toggle("print-mode-on", mode === "week");
  renderPrintBoard();
}

function weekChip(o) {
  const ink = o.items.length ? o.items[0].ink_color : "";
  return `
    <div class="week-chip" draggable="true" data-order="${o.id}">
      <span class="wc-client">${escapeHtml(o.client_name)}</span>
      <span class="wc-meta">${o.quantity.toLocaleString("en-PH")} cups${
        ink ? ` · ${escapeHtml(ink)}` : ""
      }</span>
      ${o.is_rush ? `<span class="print-chip c-rush mt-1 inline-block">Rush</span>` : ""}
    </div>`;
}

function renderPrintWeek() {
  const q = (document.getElementById("printSearch").value || "").trim().toLowerCase();
  const open = printOrders.filter((o) => {
    if (!q) return true;
    return o.client_name.toLowerCase().includes(q);
  });

  const days = weekDates();
  const first = days[0], last = days[6];
  const sameMonth = first.getMonth() === last.getMonth();
  document.getElementById("weekLabel").textContent =
    `${first.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ` +
    `${last.toLocaleDateString(undefined, sameMonth ? { day: "numeric" } : { month: "short", day: "numeric" })}`;

  const todayIso = isoDay(new Date());
  const scheduled = {};
  days.forEach((d) => (scheduled[isoDay(d)] = []));
  const unscheduled = [];
  open.forEach((o) => {
    if (o.scheduled_date && scheduled[o.scheduled_date]) scheduled[o.scheduled_date].push(o);
    else if (!o.scheduled_date) unscheduled.push(o);
  });

  const weekCups = Object.values(scheduled).reduce(
    (n, list) => n + list.reduce((m, o) => m + o.quantity, 0), 0);
  document.getElementById("weekTotal").textContent =
    weekCups ? `${weekCups.toLocaleString("en-PH")} cups this week` : "nothing scheduled yet";

  const side = document.getElementById("weekUnscheduled");
  side.dataset.day = "";
  side.innerHTML =
    `<div class="flex items-baseline gap-2 px-1 pb-1 border-b border-gray-100">
       <h4 class="text-sm font-semibold">Not scheduled</h4>
       <span class="text-[11px] font-mono text-gray-400">${unscheduled.length}</span>
     </div>` +
    (unscheduled.length
      ? unscheduled.map(weekChip).join("")
      : `<p class="text-xs text-gray-400 italic px-1 py-3">Everything open is on a day.</p>`);

  document.getElementById("weekDays").innerHTML = days
    .map((d) => {
      const iso = isoDay(d);
      const list = scheduled[iso];
      const cups = list.reduce((n, o) => n + o.quantity, 0);
      const isToday = iso === todayIso;
      const isSunday = d.getDay() === 0;
      return `
        <div class="week-day border rounded-xl p-2 flex flex-col gap-2 ${
          isToday ? "border-brand-blue bg-blue-50/40" : "border-gray-200 bg-white"
        }" data-day="${iso}">
          <div class="flex items-baseline justify-between gap-1 px-0.5">
            <span class="text-xs font-semibold ${isSunday ? "text-gray-400" : ""}">${d.toLocaleDateString(undefined, { weekday: "short" })}</span>
            <span class="text-[11px] font-mono ${isToday ? "text-brand-blue" : "text-gray-400"}">${d.getDate()}</span>
          </div>
          ${list.map(weekChip).join("")}
          <span class="mt-auto text-[10px] font-mono ${cups ? "text-gray-500" : "text-gray-300"} px-0.5">${
            cups ? cups.toLocaleString("en-PH") + " cups" : "—"
          }</span>
        </div>`;
    })
    .join("");

  wireWeekDragging();
}

async function scheduleOrder(orderId, iso) {
  const res = await fetch(`/api/print/orders/${orderId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scheduled_date: iso || "" }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.message || "Could not schedule that job.");
    return;
  }
  const order = printOrders.find((o) => String(o.id) === String(orderId));
  if (order) order.scheduled_date = iso || null;
  renderPrintWeek();
}

function wireWeekDragging() {
  document.querySelectorAll(".week-chip").forEach((chip) => {
    chip.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", chip.dataset.order);
      e.dataTransfer.effectAllowed = "move";
      chip.classList.add("dragging");
    });
    chip.addEventListener("dragend", () => chip.classList.remove("dragging"));
  });

  const targets = [...document.querySelectorAll("[data-day]")];
  targets.forEach((zone) => {
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      zone.classList.add("drop-target");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drop-target"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drop-target");
      const id = e.dataTransfer.getData("text/plain");
      if (id) scheduleOrder(id, zone.dataset.day);
    });
  });
}

if (document.getElementById("printWeek")) {
  document.getElementById("printModeBoard").addEventListener("click", () => setPrintMode("board"));
  document.getElementById("printModeWeek").addEventListener("click", () => setPrintMode("week"));
  document.getElementById("weekPrev").addEventListener("click", () => {
    weekStart.setDate(weekStart.getDate() - 7);
    renderPrintWeek();
  });
  document.getElementById("weekNext").addEventListener("click", () => {
    weekStart.setDate(weekStart.getDate() + 7);
    renderPrintWeek();
  });
  document.getElementById("weekToday").addEventListener("click", () => {
    weekStart = mondayOf(new Date());
    renderPrintWeek();
  });
  setPrintMode(printState.mode);
}
