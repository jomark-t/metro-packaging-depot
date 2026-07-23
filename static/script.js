const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const CURRENT_USER = window.CURRENT_USER || { display_name: null, is_superuser: false, staff_name: null };
const IS_SUPERUSER = !!CURRENT_USER.is_superuser;

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
// badges so Printer/Checker read as clearly distinct from Assist/Closing
// and from each other.
const CHIP_CLASSES = {
  Opening: "bg-blue-50 text-brand-blue border-l-2 border-brand-blue",
  Closing: "bg-gray-100 text-black border-l-2 border-black",
  Assist: "bg-[#F4EBDF] text-brand-tan border-l-2 border-brand-tan",
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
  manager: ["Opening", "Closing", "Inventory", "Paid Time Off", "Off"],
  sales: ["Opening", "Closing", "Inventory", "Paid Time Off", "Off"],
  sales_pt: ["Opening", "Closing", "Assist", "Inventory", "Paid Time Off", "Off"],
  machine: ["Printer", "Checker", "Inventory", "Paid Time Off", "Off"],
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

  if (!data.days || data.days.length === 0 || Object.values(data.staff_counts).every((c) => c === 0)) {
    scheduleTable.style.display = "none";
    emptyState.style.display = "block";
    summaryEl.innerHTML = "";
    downloadPdfBtn.disabled = true;
    return;
  }

  scheduleTable.style.display = "table";
  emptyState.style.display = "none";
  downloadPdfBtn.disabled = false;

  renderSummary(data.staff, data.staff_counts);
  renderTable(data.days, data.staff);
}

async function loadSnapshots() {
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
      td.className = "px-3.5 py-2.5 align-top cursor-pointer hover:bg-blue-50/40 transition schedule-cell";
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

generateBtn.addEventListener("click", generateSchedule);
downloadPdfBtn.addEventListener("click", downloadPdf);
createSnapshotBtn.addEventListener("click", createSnapshot);
restoreSnapshotBtn.addEventListener("click", restoreSnapshot);
monthSelect.addEventListener("change", loadSchedule);
yearSelect.addEventListener("change", loadSchedule);
tableBody.addEventListener("click", (e) => {
  const td = e.target.closest(".schedule-cell");
  if (!td || td.querySelector("select")) return;
  openCellEditor(td);
});

if (!IS_SUPERUSER) {
  generateBtn.disabled = true;
  generateBtn.title = "Superuser only";
  createSnapshotBtn.disabled = true;
  createSnapshotBtn.title = "Superuser only";
  restoreSnapshotBtn.title = "Superuser only";
}

initSelectors();
loadSchedule();

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const tabScheduleBtn = document.getElementById("tabScheduleBtn");
const tabPayrollBtn = document.getElementById("tabPayrollBtn");
const tabEmployeesBtn = document.getElementById("tabEmployeesBtn");
const scheduleControls = document.getElementById("scheduleControls");
const payrollControls = document.getElementById("payrollControls");
const scheduleView = document.getElementById("scheduleView");
const payrollView = document.getElementById("payrollView");
const employeesView = document.getElementById("employeesView");

const TABS = {
  schedule: { btn: tabScheduleBtn, view: scheduleView, controls: scheduleControls },
  payroll: { btn: tabPayrollBtn, view: payrollView, controls: payrollControls },
  employees: { btn: tabEmployeesBtn, view: employeesView, controls: null },
};
const loadedOnce = { payroll: false, employees: false };

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
  }
  if (tab === "employees" && !loadedOnce.employees) {
    loadedOnce.employees = true;
    loadEmployees();
  }
}

tabScheduleBtn.addEventListener("click", () => showTab("schedule"));
tabPayrollBtn.addEventListener("click", () => showTab("payroll"));
tabEmployeesBtn.addEventListener("click", () => showTab("employees"));
showTab("schedule");

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

function errorDeductionValue(row) {
  const input = row.querySelector(".error-deduction-input");
  return input ? parseFloat(input.value) || 0 : 0;
}

function computeRowTotals(row) {
  const otHours = parseFloat(row.querySelector(".ot-hours-input").value) || 0;
  const sss = parseFloat(row.querySelector(".sss-input").value) || 0;
  const pagibig = parseFloat(row.querySelector(".pagibig-input").value) || 0;
  const philhealth = parseFloat(row.querySelector(".philhealth-input").value) || 0;
  const hmo = parseFloat(row.querySelector(".hmo-input").value) || 0;
  const errorDed = errorDeductionValue(row);
  const cashAdvance = parseFloat(row.querySelector(".cash-advance-input").value) || 0;

  const otPay = otHours * currentOtRate;
  const absenceDed = parseFloat(row.dataset.absenceDeduction) || 0;
  const totalDeductions = sss + pagibig + philhealth + hmo + errorDed + cashAdvance + absenceDed;
  const basePay = parseFloat(row.dataset.basePay) || 0;
  const bonus = parseFloat(row.dataset.bonus) || 0;
  const netPay = basePay + otPay + bonus - totalDeductions;

  row.querySelector(".ot-pay-cell").textContent = formatMoney(otPay);
  row.querySelector(".total-deductions-cell").textContent = formatMoney(totalDeductions);
  row.querySelector(".net-pay-cell").textContent = formatMoney(netPay);
}

function computeGrandTotals() {
  const totals = {
    days: 0, base: 0, bonus: 0, otHours: 0, otPay: 0,
    sss: 0, pagibig: 0, philhealth: 0, hmo: 0, errorDed: 0, cashAdvance: 0, absenceDed: 0, ded: 0, net: 0,
  };

  Array.from(payrollBody.querySelectorAll("tr")).forEach((row) => {
    const base = parseFloat(row.dataset.basePay) || 0;
    const bonus = parseFloat(row.dataset.bonus) || 0;
    const otHours = parseFloat(row.querySelector(".ot-hours-input").value) || 0;
    const sss = parseFloat(row.querySelector(".sss-input").value) || 0;
    const pagibig = parseFloat(row.querySelector(".pagibig-input").value) || 0;
    const philhealth = parseFloat(row.querySelector(".philhealth-input").value) || 0;
    const hmo = parseFloat(row.querySelector(".hmo-input").value) || 0;
    const errorDed = errorDeductionValue(row);
    const cashAdvance = parseFloat(row.querySelector(".cash-advance-input").value) || 0;
    const absenceDed = parseFloat(row.dataset.absenceDeduction) || 0;
    const otPay = otHours * currentOtRate;
    const ded = sss + pagibig + philhealth + hmo + errorDed + cashAdvance + absenceDed;
    const net = base + otPay + bonus - ded;

    totals.days += parseFloat(row.dataset.days) || 0;
    totals.base += base;
    totals.bonus += bonus;
    totals.otHours += otHours;
    totals.otPay += otPay;
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
  foot.querySelector(".totals-ot-hours").textContent = totals.otHours;
  foot.querySelector(".totals-ot-pay").textContent = formatMoney(totals.otPay);
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
      <td class="px-3 py-3 font-mono totals-ot-hours"></td>
      <td class="px-3 py-3 font-mono totals-ot-pay whitespace-nowrap"></td>
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
    "Name", "Role", "Days", "Base Pay", "Bonus",
    `OT Hrs`, `OT Pay (×₱${currentOtRate})`, "SSS", "Pag-IBIG", "PhilHealth", "HMO", "Printing Errors",
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

    tr.appendChild(inputCell("sss-input", p.sss));
    tr.appendChild(inputCell("pagibig-input", p.pagibig));
    tr.appendChild(inputCell("philhealth-input", p.philhealth));
    tr.appendChild(inputCell("hmo-input", p.hmo));

    const errorDedTd = document.createElement("td");
    if (p.has_bonus) {
      errorDedTd.className = "px-3 py-2.5 align-top";
      const input = document.createElement("input");
      input.type = "number";
      input.min = "0";
      input.step = "0.01";
      input.value = p.error_deduction;
      input.disabled = !IS_SUPERUSER;
      input.className =
        "error-deduction-input w-24 text-sm font-mono border border-gray-300 rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-blue disabled:bg-gray-50 disabled:text-gray-500";
      input.addEventListener("input", () => {
        computeRowTotals(tr);
        computeGrandTotals();
      });
      errorDedTd.appendChild(input);
    } else {
      errorDedTd.className = "px-3 py-2.5 align-top font-mono";
      errorDedTd.textContent = "—";
    }
    tr.appendChild(errorDedTd);

    tr.appendChild(inputCell("cash-advance-input", p.cash_advance));

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
      sss: tr.querySelector(".sss-input").value,
      pagibig: tr.querySelector(".pagibig-input").value,
      philhealth: tr.querySelector(".philhealth-input").value,
      hmo: tr.querySelector(".hmo-input").value,
      error_deduction: errorDeductionValue(tr),
      cash_advance: tr.querySelector(".cash-advance-input").value,
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
// Employees
// ---------------------------------------------------------------------------
const employeesGrid = document.getElementById("employeesGrid");
const employeesTabs = document.getElementById("employeesTabs");

let employeesData = [];
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
          <p class="text-[11px] text-gray-400 font-mono uppercase tracking-wide">${escapeHtml(s.name)} &middot; ${escapeHtml(s.category)}</p>
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
        <div class="lg:col-span-2">${sectionHtml("Login Access", loginHtml)}</div>
      </div>

      <div class="flex items-center gap-3 mt-5">
        <button class="save-employee-btn bg-brand-green text-black font-semibold text-sm rounded-lg px-4 py-2 hover:brightness-95 active:brightness-90 transition">Save</button>
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

function renderEmployees() {
  employeesTabs.innerHTML = employeesData
    .map((s) => {
      const active = s.name === selectedEmployeeName;
      const classes = active
        ? "bg-brand-blue text-white"
        : "bg-white text-gray-600 border border-gray-300 hover:border-gray-400";
      return `<button type="button" class="employee-tab-btn font-semibold text-sm rounded-lg px-4 py-2 transition ${classes}" data-name="${escapeHtml(s.name)}">${escapeHtml(s.name)}</button>`;
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
