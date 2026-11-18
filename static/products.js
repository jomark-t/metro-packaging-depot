// ---------------------------------------------------------------------------
// Products - the price list, and the catalogue clients browse at /shop.
//
// Two views of the same rows. "Price list" is the sheet this replaced: one row
// per sellable item under a band per category, cells edited in place, Price
// worked out from Unit Price x Qty Per Unit. "Products" groups the rows into
// the cards clients see (sizes and colors under one product) and holds the
// photo and description. Whatever is saved in either shows in /shop.
//
// Loaded before script.js and only defines functions; script.js calls
// loadProducts() when the tab opens.
// ---------------------------------------------------------------------------

const PRODUCTS_PAGE_SIZE = 50;
const PRODUCT_STATUS_LABELS = {
  "": "", new: "New", repriced: "Repriced", incoming: "Incoming", shelfed: "Shelfed",
};
let productsData = { families: [], settings: {}, can_see_costs: false, can_import: false, unit_types: [] };
let productsMode = "sheet"; // "sheet" | "grouped"
try { productsMode = localStorage.getItem("mpd.productsView") === "grouped" ? "grouped" : "sheet"; } catch (e) { /* storage blocked */ }
let productsPage = 1;
let productsOpenId = null; // the product open in the editor
let productsEdits = { family: {}, variants: {} }; // unsaved changes in the editor
let productsDetailOpen = new Set(); // variant ids whose detail panel is open
let productsCollapsed = new Set(); // bands folded shut in the price list

// The browser's own confirm() is blocked in some installs, so ask with the app's dialog.
const askYes = (message, opts = {}) =>
  typeof confirmDialog === "function" ? confirmDialog(message, Object.assign({ title: "Are you sure?", confirmLabel: "Yes" }, opts)) : Promise.resolve(window.confirm(message));

const pEsc = (s) => (typeof escapeHtml === "function" ? escapeHtml(String(s == null ? "" : s)) : String(s == null ? "" : s));

// ---- Searchable picker -------------------------------------------------------
// The browser's own <datalist> only offers what matches the text already in the
// box (so a filled-in category shows just itself), and a plain <select> with a
// few hundred products can't be searched and acts the moment it changes. This
// one lists every choice when you click it, narrows as you type, and only acts
// when you pick something.
//   free: true  - the typed text is the value (categories, suppliers)
//   free: false - you must pick a row; the pick is left on input.dataset.pick and
//                 a "change" event fires (merge / move)
function comboHtml({ attr = "", value = "", items = [], placeholder = "", free = true, cls = "", id = "" }) {
  return `<div class="pcombo" data-free="${free ? 1 : 0}">
    <input type="text" ${id ? `id="${id}"` : ""} ${attr} autocomplete="off" spellcheck="false" value="${pEsc(value)}" placeholder="${pEsc(placeholder)}" class="${cls}">
    <div class="pcombo-list" role="listbox" hidden>${items.map((i) =>
      `<div class="pcombo-item" role="option" data-v="${pEsc(i.v)}" data-label="${pEsc(i.label)}" data-find="${pEsc((i.label + " " + (i.sub || "")).toLowerCase())}">${pEsc(i.label)}${i.sub ? `<span class="pcombo-sub">${pEsc(i.sub)}</span>` : ""}</div>`).join("")}
      <div class="pcombo-none" hidden>Nothing matches.</div></div></div>`;
}

const comboProductItems = (exceptId) =>
  productsData.families.filter((x) => x.id !== exceptId)
    .slice().sort((a, b) => a.name.localeCompare(b.name))
    .map((x) => ({ v: x.id, label: x.name, sub: x.section }));

(function wireCombos() {
  if (window.__pcomboWired) return;
  window.__pcomboWired = true;
  let openBox = null;

  const itemsOf = (box) => [...box.querySelectorAll(".pcombo-item")];
  function place(box) {
    const input = box.querySelector("input"), list = box.querySelector(".pcombo-list");
    const r = input.getBoundingClientRect();
    const width = Math.max(r.width, 260);
    list.style.width = width + "px";
    list.style.left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) + "px";
    const below = window.innerHeight - r.bottom - 12, above = r.top - 12;
    const h = Math.min(240, list.scrollHeight);
    if (below >= Math.min(h, 160) || below >= above) {
      list.style.top = r.bottom + 4 + "px"; list.style.bottom = "auto"; list.style.maxHeight = Math.max(120, Math.min(240, below)) + "px";
    } else {
      list.style.bottom = window.innerHeight - r.top + 4 + "px"; list.style.top = "auto"; list.style.maxHeight = Math.max(120, Math.min(240, above)) + "px";
    }
  }
  function filter(box, q) {
    q = q.trim().toLowerCase();
    let shown = 0, first = null;
    itemsOf(box).forEach((it) => {
      const hit = !q || it.dataset.find.includes(q);
      it.hidden = !hit;
      it.classList.remove("on");
      if (hit) { shown++; first = first || it; }
    });
    if (first && q) first.classList.add("on");
    box.querySelector(".pcombo-none").hidden = shown > 0;
    return shown;
  }
  function open(box, showAll) {
    if (openBox && openBox !== box) close(openBox);
    openBox = box;
    const input = box.querySelector("input");
    filter(box, showAll ? "" : input.value);
    const list = box.querySelector(".pcombo-list");
    list.hidden = false;
    place(box);
  }
  function close(box) {
    if (!box) return;
    box.querySelector(".pcombo-list").hidden = true;
    if (openBox === box) openBox = null;
  }
  function choose(box, item) {
    const input = box.querySelector("input");
    close(box);
    if (box.dataset.free === "1") {
      input.value = item.dataset.label;
      delete input.dataset.pick;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      input.value = item.dataset.label;
      input.dataset.pick = item.dataset.v;
    }
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const boxOf = (el) => (el && el.closest ? el.closest(".pcombo") : null);

  document.addEventListener("focusin", (ev) => {
    const box = boxOf(ev.target);
    if (box && ev.target.tagName === "INPUT") { ev.target.select(); open(box, true); }
    else if (openBox) close(openBox);
  });
  document.addEventListener("mousedown", (ev) => {
    const box = boxOf(ev.target);
    if (box && ev.target.tagName === "INPUT" && document.activeElement === ev.target && box.querySelector(".pcombo-list").hidden) open(box, true);
    const item = ev.target.closest && ev.target.closest(".pcombo-item");
    if (item) { ev.preventDefault(); choose(boxOf(item), item); return; }
    if (!box && openBox) close(openBox);
  });
  // a click on a row must not reach the <label> around the picker, or it would refocus the box and reopen the list
  document.addEventListener("click", (ev) => {
    if (ev.target.closest && ev.target.closest(".pcombo-list")) { ev.preventDefault(); ev.stopPropagation(); }
  }, true);
  document.addEventListener("input", (ev) => {
    const box = boxOf(ev.target);
    if (!box || ev.target.tagName !== "INPUT" || !ev.isTrusted) return;
    delete ev.target.dataset.pick;
    open(box, false);
  });
  document.addEventListener("keydown", (ev) => {
    const box = boxOf(ev.target);
    if (!box || ev.target.tagName !== "INPUT") return;
    const list = box.querySelector(".pcombo-list");
    const visible = itemsOf(box).filter((x) => !x.hidden);
    if (ev.key === "Escape" && !list.hidden) { ev.preventDefault(); ev.stopPropagation(); close(box); return; }
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (list.hidden) open(box, true);
      const items = itemsOf(box).filter((x) => !x.hidden);
      if (!items.length) return;
      let at = items.findIndex((x) => x.classList.contains("on"));
      items.forEach((x) => x.classList.remove("on"));
      at = ev.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      items[at].classList.add("on");
      items[at].scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter" && !list.hidden) {
      const on = visible.find((x) => x.classList.contains("on"));
      ev.preventDefault();
      if (on) choose(box, on);
      else if (box.dataset.free === "1") close(box);
    }
  }, true);
  window.addEventListener("resize", () => close(openBox));
  document.addEventListener("scroll", (ev) => { if (openBox && !ev.target.closest?.(".pcombo-list")) close(openBox); }, true);
})();
const pesos = (n) =>
  n == null ? "—" : "₱" + Number(n).toLocaleString("en-PH", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
// a unit price can run to four places (28 / 3 pieces), so show what is there, at least two
function money4(n) {
  if (n == null || n === "") return "";
  const s = Number(n).toFixed(4).replace(/0+$/, "");
  const [whole, frac = ""] = s.split(".");
  return Number(whole).toLocaleString("en-PH") + "." + frac.padEnd(2, "0");
}
const qtyOf = (v) => (Number(v.qty_per_unit) > 0 ? Number(v.qty_per_unit) : 1);
// the sheet's formulas: Price = Unit Price x Qty, Cost Price = Unit Cost x Qty, Margin = (Price - Cost Price) / Price
const calcPrice = (unitPrice, qty) => (unitPrice == null || unitPrice === "" ? null : Math.round(Number(unitPrice) * (Number(qty) > 0 ? Number(qty) : 1) * 100) / 100);
const calcCostPrice = (unitCost, qty) => (unitCost == null || unitCost === "" ? null : Math.round(Number(unitCost) * (Number(qty) > 0 ? Number(qty) : 1) * 100) / 100);
const calcMargin = (price, costPrice) => (price && costPrice != null ? Math.round((1 - costPrice / price) * 10000) / 100 : null);

async function productsFetch(url, { method = "GET", body, form } = {}) {
  const opts = { method };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "That didn't save.");
  return data;
}

function productsToast(message) {
  const el = document.createElement("div");
  el.textContent = message;
  el.className = "fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] bg-gray-900 text-white text-sm rounded-lg px-4 py-2 shadow-lg";
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function productFamily(id) {
  return productsData.families.find((f) => f.id === id);
}

async function loadProducts() {
  try {
    productsData = await productsFetch("/api/products");
  } catch (err) {
    document.getElementById("productsBody").innerHTML = `<tr><td colspan="6" class="text-center text-sm text-gray-400 italic py-8">${pEsc(err.message)}</td></tr>`;
    return;
  }
  document.getElementById("productsImportBtn").style.display = productsData.can_import ? "" : "none";
  fillProductSectionFilter();
  renderProducts();
  if (productsOpenId && productFamily(productsOpenId)) renderProductEditor();
}

function productSections() {
  // in the order the price list runs
  const rows = productsData.families.map((f) => [f.section, Math.min(...f.variants.map((v) => v.sort_order || 0), f.sort_order || 0)]);
  const first = {};
  rows.forEach(([s, o]) => { if (!(s in first) || o < first[s]) first[s] = o; });
  return Object.keys(first).sort((a, b) => first[a] - first[b]);
}

function fillProductSectionFilter() {
  const sel = document.getElementById("productsSection");
  const keep = sel.value;
  sel.innerHTML = `<option value="">All categories</option>` +
    productSections().map((s) => `<option value="${pEsc(s)}">${pEsc(s)}</option>`).join("");
  sel.value = productSections().includes(keep) ? keep : "";
  document.getElementById("productsRenameSection").style.display = sel.value ? "" : "none";
}

function setProductsView(view) {
  productsMode = view;
  try { localStorage.setItem("mpd.productsView", view); } catch (e) { /* storage blocked */ }
  renderProducts();
}

// ------------------------------------------------------------- filters

function productsFilter() {
  return {
    q: document.getElementById("productsSearch").value.trim().toLowerCase(),
    section: document.getElementById("productsSection").value,
    show: document.getElementById("productsShow").value,
  };
}

function familyMatches(f, flt) {
  if (flt.section && f.section !== flt.section) return false;
  if (flt.show === "shown" && !f.is_visible) return false;
  if (flt.show === "hidden" && f.is_visible) return false;
  if (flt.show === "noprice" && !f.variants.some((v) => v.price == null)) return false;
  if (flt.show === "nophoto" && f.photo) return false;
  if (flt.q && !(f.name + " " + f.section + " " + f.variants.map((v) => [v.name, v.sku, v.product, v.sub].join(" ")).join(" ")).toLowerCase().includes(flt.q)) return false;
  return true;
}

function variantMatches(f, v, flt) {
  if (flt.section && f.section !== flt.section) return false;
  if (flt.show === "shown" && !(f.is_visible && v.is_visible)) return false;
  if (flt.show === "hidden" && f.is_visible && v.is_visible) return false;
  if (flt.show === "noprice" && v.price != null) return false;
  if (flt.show === "nophoto" && f.photo) return false;
  if (flt.q && ![v.name, v.sku, v.product, v.sub, v.note, f.name, f.section].join(" ").toLowerCase().includes(flt.q)) return false;
  return true;
}

function renderProducts() {
  const totalOptions = productsData.families.reduce((s, f) => s + f.variants.length, 0);
  document.getElementById("productsSubtitle").textContent =
    `${productsData.families.length} products · ${totalOptions} sizes and colors. What you change here is what clients see in the catalog.`;
  document.getElementById("productsViewSheet").className = viewTabClass(productsMode === "sheet");
  document.getElementById("productsViewGrouped").className = viewTabClass(productsMode === "grouped");
  document.getElementById("productsSheetWrap").style.display = productsMode === "sheet" ? "" : "none";
  document.getElementById("productsGroupedWrap").style.display = productsMode === "grouped" ? "" : "none";
  if (productsMode === "sheet") renderProductsSheet();
  else renderProductsGrouped();
}

const viewTabClass = (on) =>
  "px-3 py-1.5 rounded-md text-sm font-medium transition " + (on ? "bg-white shadow text-gray-900" : "text-gray-500 hover:text-gray-900");

// ------------------------------------------------------------- price list (the sheet)

// key, header, width class, kind, private (costs - superuser only)
// The list is for reading. Status, SKU, unit type, supplier and margin live in the popup.
const SHEET_COLS = [
  { k: "product", h: "Product", w: "w-28", kind: "text" },
  { k: "sub", h: "Sub", w: "w-28", kind: "text" },
  { k: "name", h: "Product Name", w: "w-56", kind: "name" },
  { k: "qty_per_unit", h: "Qty Per Unit", w: "w-16", kind: "num" },
  { k: "unit_price", h: "Unit Price", w: "w-24", kind: "money" },
  { k: "price", h: "Price", w: "w-24", kind: "calc", orange: true },
  { k: "note", h: "Description", w: "w-40", kind: "text" },
  { k: "is_visible", h: "Catalog", w: "w-16", kind: "shown" },
];

function sheetCols() {
  return SHEET_COLS.filter((c) => !c.priv || productsData.can_see_costs);
}

function statusPill(status) {
  if (!status) return "";
  const tone = { new: "bg-blue-100 text-blue-700", incoming: "bg-emerald-100 text-emerald-700", repriced: "bg-amber-100 text-amber-700", shelfed: "bg-gray-200 text-gray-600" }[status] || "bg-gray-100 text-gray-600";
  return `<span class="inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone}">${pEsc(PRODUCT_STATUS_LABELS[status] || status)}</span>`;
}

function sheetCellHtml(f, v, c) {
  const qty = qtyOf(v);
  switch (c.kind) {
    case "name": return `<td class="pc" data-k="name"><button type="button" class="sheet-open text-left font-medium text-brand-blue hover:underline" title="Open the details of this item">${pEsc(v.name)}</button></td>`;
    case "text": return `<td class="pc" data-k="${c.k}">${pEsc(v[c.k])}</td>`;
    case "num": return `<td class="pc pc-num" data-k="${c.k}">${v[c.k] == null ? "" : pEsc(v[c.k])}</td>`;
    case "money": return `<td class="pc pc-num" data-k="${c.k}">${v[c.k] == null ? "" : `<span class="text-gray-400">₱</span> ${money4(v[c.k])}`}</td>`;
    case "calc": {
      let val = null, text = "";
      if (c.k === "price") { val = v.price; text = val == null ? "" : `<span class="text-gray-400">₱</span> ${money4(val)}`; }
      if (c.k === "cost_price") { val = calcCostPrice(v.unit_cost, qty); text = val == null ? "" : `<span class="text-gray-300">₱</span> <span class="text-gray-400">${money4(val)}</span>`; }
      return `<td class="pc pc-num${c.k === "price" ? " font-semibold" : ""}" data-calc="${c.k}">${text}</td>`;
    }
    case "shown": return `<td class="pc text-center text-xs ${v.is_visible ? "text-emerald-600" : "text-gray-400"}">${v.is_visible ? "✓" : "Hidden"}</td>`;
  }
  return "<td></td>";
}

function sheetRowHtml(f, v) {
  const dim = f.is_visible ? "" : " opacity-50";
  return `<tr class="prow${dim}" data-vid="${v.id}" data-fid="${f.id}">${sheetCols().map((c) => sheetCellHtml(f, v, c)).join("")}</tr>`;
}

function renderProductsSheet() {
  const flt = productsFilter();
  const cols = sheetCols();
  document.getElementById("productsSheetHead").innerHTML =
    `<tr>${cols.map((c) => `<th class="${c.w} ${c.orange ? "ph-orange" : ""}">${pEsc(c.h)}</th>`).join("")}</tr>`;

  // rows in the order the price list runs, under one band per category
  const items = [];
  productsData.families.forEach((f) => f.variants.forEach((v) => { if (variantMatches(f, v, flt)) items.push([f, v]); }));
  items.sort((a, b) => (a[1].sort_order || 0) - (b[1].sort_order || 0) || a[1].id - b[1].id);
  const bands = [];
  const byBand = {};
  items.forEach(([f, v]) => {
    if (!byBand[f.section]) { byBand[f.section] = []; bands.push(f.section); }
    byBand[f.section].push([f, v]);
  });
  const searching = !!(flt.q || flt.show || flt.section);
  const html = bands.map((s) => {
    const shut = productsCollapsed.has(s) && !searching;
    return `<tr class="pband" data-band="${pEsc(s)}"><td colspan="${cols.length}">
        <span class="pband-caret">${shut ? "▸" : "▾"}</span> ${pEsc(s)} <span class="pband-count">${byBand[s].length}</span>
        <button type="button" class="pband-add" data-addto="${pEsc(s)}">+ Add item</button>
        <button type="button" class="pband-add" data-photo-cat="${pEsc(s)}" title="The picture on this category's card in the catalog">${(productsData.category_photos || {})[s] ? "Category photo ✓" : "Category photo"}</button></td></tr>` +
      (shut ? "" : byBand[s].map(([f, v]) => sheetRowHtml(f, v)).join(""));
  }).join("");
  document.getElementById("productsSheetBody").innerHTML = html ||
    `<tr><td colspan="${cols.length}" class="text-center text-sm text-gray-400 italic py-10">${productsData.families.length ? "Nothing matches." : "No products yet. Use Import price list, or Add product."}</td></tr>`;
  document.getElementById("productsSheetCount").textContent = items.length === 1 ? "1 row" : `${items.length} rows`;
}

// ------------------------------------------------------------- option popup (everything about one item)

let optionId = null; // the option open in the popup
let optionEdits = {}; // unsaved changes in the popup
let optionHistory = null; // null = loading

const PRICE_FIELD_LABELS = { price: "Price", unit_price: "Unit price", box_price: "Box price", unit_cost: "Unit cost" };

function findOption(id) {
  for (const f of productsData.families) {
    const v = f.variants.find((x) => x.id === id);
    if (v) return [f, v];
  }
  return [null, null];
}

function optionMerged(v) {
  const m = Object.assign({}, v, optionEdits);
  ["unit_price", "qty_per_unit", "unit_cost"].forEach((k) => { if (m[k] === "") m[k] = null; });
  return m;
}

function historyHtml() {
  if (optionHistory == null) return `<p class="text-xs text-gray-400 italic">Loading…</p>`;
  if (!optionHistory.length) return `<p class="text-xs text-gray-400 italic">No price changes recorded yet. From now on, every change to the price shows up here.</p>`;
  const when = (iso) => new Date(iso).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });
  const order = ["price", "unit_price", "box_price", "unit_cost"];
  return optionHistory.map((e) => {
    const rows = e.changes.slice().sort((a, b) => order.indexOf(a.field) - order.indexOf(b.field)).map((c) => {
      const up = c.old != null && c.new != null ? (c.new > c.old ? "text-red-600" : "text-emerald-600") : "text-gray-500";
      const arrow = c.old != null && c.new != null ? (c.new > c.old ? "▲" : "▼") : "";
      const lead = c.field === "price" ? "font-semibold" : "text-gray-500";
      return `<div class="flex items-baseline gap-2 ${lead}"><span class="w-20 shrink-0">${PRICE_FIELD_LABELS[c.field] || pEsc(c.field)}</span>
        <span class="tabular-nums">${c.old == null ? "—" : pesos(c.old)} → ${c.new == null ? "—" : pesos(c.new)}</span><span class="${up} text-[10px]">${arrow}</span></div>`;
    }).join("");
    return `<div class="border-t border-gray-100 py-2 text-xs"><div class="text-[11px] text-gray-400 mb-0.5">${pEsc(when(e.at))} · ${pEsc(e.by || "")}</div>${rows}</div>`;
  }).join("");
}

function renderOptionPopup() {
  const [f, v] = findOption(optionId);
  if (!v) return;
  const m = optionMerged(v);
  const costs = productsData.can_see_costs;
  const dirty = Object.keys(optionEdits).length > 0;
  const inp = "w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm mt-0.5";
  const lab = (t, inner, cls = "") => `<label class="block text-xs ${cls}"><span class="text-gray-500">${t}</span>${inner}</label>`;
  const field = (k, type = "text", extra = "") =>
    `<input data-o="${k}" type="${type}" ${type === "number" ? 'step="any" min="0"' : ""} value="${pEsc(type === "number" ? numInput(m[k]) : (m[k] ?? ""))}" class="${inp}" ${extra}>`;
  const unitTypes = productsData.unit_types.concat(m.unit_type && !productsData.unit_types.includes(m.unit_type) ? [m.unit_type] : []);
  document.getElementById("productOptionBody").innerHTML = `
    <div class="flex items-start justify-between gap-3 mb-4">
      <div class="min-w-0">
        <h3 class="font-display font-semibold text-lg leading-tight">${pEsc(v.name)}</h3>
        <p class="text-xs text-gray-500">${pEsc(f.name)} · ${pEsc(f.section)}</p>
      </div>
      <button type="button" id="optionClose" class="text-gray-400 hover:text-black text-2xl leading-none" aria-label="Close">×</button>
    </div>
    <div class="flex items-center gap-4 mb-4 rounded-xl border border-gray-200 p-3">
      ${v.photo ? `<img src="${pEsc(v.photo)}" alt="" class="w-20 h-20 object-cover rounded-lg border border-gray-200 shrink-0">`
        : `<div class="w-20 h-20 rounded-lg bg-gray-100 border border-dashed border-gray-300 flex items-center justify-center text-[11px] text-gray-400 text-center px-1 shrink-0">No photo</div>`}
      <div class="text-xs text-gray-500 min-w-0">
        <p class="mb-1">Photo of this size or color. Clients see it when they tap this option; without one they see the product photo${f.photo ? "" : " (this product has none yet)"}.</p>
        <label class="text-brand-blue hover:underline cursor-pointer text-sm">${v.photo ? "Replace photo" : "Add photo"}<input type="file" id="optionPhotoInput" accept="image/png,image/jpeg,image/webp" class="hidden"></label>
        ${v.photo ? `<button type="button" id="optionPhotoRemove" class="text-red-600 hover:underline text-sm ml-3">Remove</button>` : ""}
      </div>
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
      ${lab("Product name", field("name"), "col-span-2 sm:col-span-3")}
      ${lab("Category (moves this item)", comboHtml({ attr: 'data-o="section"', value: "section" in optionEdits ? optionEdits.section : f.section, items: productSections().map((x) => ({ v: x, label: x })), placeholder: "Pick one or type a new one", cls: inp }), "col-span-2 sm:col-span-3")}
      ${lab("Status", `<select data-o="status" class="${inp} bg-white">${["", "new", "repriced", "incoming", "shelfed"].map((s) => `<option value="${s}" ${m.status === s ? "selected" : ""}>${PRODUCT_STATUS_LABELS[s] || "—"}</option>`).join("")}</select>`)}
      ${lab("SKU", field("sku"))}
      ${lab("Unit type", `<select data-o="unit_type" class="${inp} bg-white"><option value=""></option>${unitTypes.map((u) => `<option ${m.unit_type === u ? "selected" : ""}>${pEsc(u)}</option>`).join("")}</select>`)}
      ${lab("Product (sheet)", field("product"))}${lab("Sub (sheet)", field("sub"))}${lab("Description (brand, material)", field("note"))}
      ${lab("Size", field("size"))}${lab("Color", field("color"))}
      ${costs ? lab("Supplier (private)", comboHtml({ attr: 'data-o="supplier"', value: m.supplier ?? "", items: [...new Set(productsData.families.flatMap((x) => x.variants.map((y) => y.supplier).filter(Boolean)))].sort().map((n) => ({ v: n, label: n })), cls: inp })) : "<div></div>"}
    </div>
    <div class="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-3 pt-3 border-t border-gray-100">
      ${lab("Qty per unit (pieces in a pack)", field("qty_per_unit", "number"))}${lab("Qty per box", field("qty_per_box", "number"))}${lab("Minimum qty", field("min_qty", "number"))}
      ${lab("Unit price (per piece)", field("unit_price", "number"))}${lab("Box price (optional)", field("box_price", "number"))}
      ${costs ? lab("Unit cost per piece (private)", field("unit_cost", "number")) : "<div></div>"}
    </div>
    <div class="mt-3 rounded-lg bg-gray-50 px-3 py-2 text-sm flex flex-wrap gap-x-6 gap-y-1" id="optionCalc"></div>
    <label class="inline-flex items-center gap-2 text-sm mt-3"><input type="checkbox" data-o="is_visible" ${m.is_visible ? "checked" : ""}> Show this item in the catalog</label>
    <h4 class="font-display font-semibold text-sm mt-5 mb-1">Price history</h4>
    <div id="optionHistory" class="max-h-52 overflow-auto">${historyHtml()}</div>
    <div class="flex flex-wrap items-center gap-3 mt-4 pt-3 border-t border-gray-100">
      <button type="button" id="optionSave" class="bg-brand-green text-white font-semibold text-sm rounded-lg px-4 py-2 hover:brightness-95 transition disabled:opacity-50" ${dirty ? "" : "disabled"}>Save changes</button>
      <span id="optionStatus" class="text-xs text-gray-500">${dirty ? "Unsaved changes" : ""}</span>
      <span class="ml-auto flex items-center gap-4 text-xs">
        <button type="button" id="optionOpenProduct" class="text-brand-blue hover:underline">Open the whole product (sizes and colors)</button>
        <button type="button" id="optionDelete" class="text-red-600 hover:underline">Delete</button>
      </span>
    </div>`;
  updateOptionCalc();
}

// Price, cost price and margin follow the numbers as they are typed
function updateOptionCalc() {
  const [, v] = findOption(optionId);
  if (!v) return;
  const m = optionMerged(v);
  const price = calcPrice(m.unit_price, m.qty_per_unit);
  const parts = [`<span>Price <b class="tabular-nums">${price == null ? "—" : pesos(price)}</b></span>`];
  if (productsData.can_see_costs) {
    const cp = calcCostPrice(m.unit_cost, m.qty_per_unit), mg = calcMargin(price, cp);
    parts.push(`<span class="text-gray-500">Cost price <b class="tabular-nums">${cp == null ? "—" : pesos(cp)}</b></span>`);
    parts.push(`<span class="text-gray-500">Margin <b class="tabular-nums">${mg == null ? "—" : mg.toFixed(2) + "%"}</b></span>`);
  }
  document.getElementById("optionCalc").innerHTML = parts.join("");
}

async function openOption(id) {
  optionId = id;
  optionEdits = {};
  optionHistory = null;
  renderOptionPopup();
  openModalEl("productOptionModal");
  try {
    const r = await productsFetch(`/api/products/variants/${id}/history`);
    if (optionId !== id) return;
    optionHistory = r.events;
  } catch (err) {
    optionHistory = [];
    productsToast(err.message);
  }
  document.getElementById("optionHistory").innerHTML = historyHtml();
}

async function closeOption(force = false) {
  if (!force && Object.keys(optionEdits).length && !(await askYes("You have unsaved changes. Close without saving?", { title: "Close without saving?", confirmLabel: "Close" }))) return;
  optionId = null;
  optionEdits = {};
  closeModalEl("productOptionModal");
}

async function saveOption() {
  const [, v] = findOption(optionId);
  const status = document.getElementById("optionStatus");
  const btn = document.getElementById("optionSave");
  btn.disabled = true;
  status.textContent = "Saving…";
  try {
    const rest = Object.assign({}, optionEdits);
    const section = rest.section;
    delete rest.section;
    if (section !== undefined) {
      if (!section.trim()) throw new Error("A category needs a name.");
      await productsFetch(`/api/products/variants/${v.id}/move`, { method: "POST", body: { section: section.trim() } });
    }
    if (Object.keys(rest).length) await productsFetch(`/api/products/variants/${v.id}`, { method: "POST", body: rest });
    const keep = optionId;
    optionEdits = {};
    await loadProducts();
    if (document.getElementById("productEditModal").classList.contains("flex")) renderProductEditor();
    optionId = keep;
    optionHistory = null;
    renderOptionPopup();
    productsToast("Saved. The catalog is updated.");
    productsFetch(`/api/products/variants/${keep}/history`).then((r) => {
      if (optionId !== keep) return;
      optionHistory = r.events;
      document.getElementById("optionHistory").innerHTML = historyHtml();
    }).catch(() => {});
  } catch (err) {
    status.textContent = err.message;
    btn.disabled = false;
  }
}

function recordOptionEdit(el) {
  const [, v] = findOption(optionId);
  const k = el.dataset.o;
  const raw = el.type === "checkbox" ? el.checked : el.value;
  const [fam] = findOption(optionId);
  const same = k === "section" ? raw.trim() === fam.section
    : el.type === "number" ? (raw === "" ? v[k] == null : Number(raw) === v[k]) : raw === (v[k] ?? "");
  if (same) delete optionEdits[k]; else optionEdits[k] = raw;
  const dirty = Object.keys(optionEdits).length > 0;
  document.getElementById("optionSave").disabled = !dirty;
  document.getElementById("optionStatus").textContent = dirty ? "Unsaved changes" : "";
  if (["unit_price", "qty_per_unit", "unit_cost"].includes(k)) updateOptionCalc();
}

function wireOptionPopup() {
  const modal = document.getElementById("productOptionModal");
  modal.addEventListener("input", (ev) => {
    const el = ev.target;
    if (el.dataset.o && el.type !== "checkbox" && el.tagName !== "SELECT") recordOptionEdit(el);
  });
  modal.addEventListener("change", async (ev) => {
    const el = ev.target;
    if (el.dataset.o && (el.type === "checkbox" || el.tagName === "SELECT")) recordOptionEdit(el);
    if (el.id === "optionPhotoInput" && el.files[0]) {
      try {
        const form = new FormData();
        form.append("photo", el.files[0]);
        await productsFetch(`/api/products/variants/${optionId}/photo`, { method: "POST", form });
        await loadProducts();
        renderOptionPopup();
        document.getElementById("optionHistory").innerHTML = historyHtml();
        productsToast("Photo saved.");
      } catch (err) { productsToast(err.message); }
    }
  });
  modal.addEventListener("click", async (ev) => {
    if (ev.target.id === "productOptionModal" || ev.target.id === "optionClose") return closeOption();
    const t = ev.target.closest("button");
    if (!t) return;
    if (t.id === "optionSave") return saveOption();
    if (t.id === "optionPhotoRemove") {
      try {
        await productsFetch(`/api/products/variants/${optionId}/photo`, { method: "DELETE" });
        await loadProducts();
        renderOptionPopup();
        document.getElementById("optionHistory").innerHTML = historyHtml();
      } catch (err) { productsToast(err.message); }
      return;
    }
    const [f, v] = findOption(optionId);
    if (!v) return;
    if (t.id === "optionOpenProduct") {
      if (Object.keys(optionEdits).length && !(await askYes("You have unsaved changes. Close without saving?", { title: "Close without saving?", confirmLabel: "Close" }))) return;
      closeOption(true);
      return openProductEditor(f.id);
    }
    if (t.id === "optionDelete") {
      const ok = typeof confirmDialog === "function"
        ? await confirmDialog("This size or color will be removed from Products and the catalog. To keep it but hide it from clients, untick \"Show this item\" instead.", { title: "Delete this item?" })
        : window.confirm("Delete this item?");
      if (!ok) return;
      try {
        await productsFetch(`/api/products/variants/${v.id}`, { method: "DELETE" });
        closeOption(true);
        await loadProducts();
        productsToast("Deleted.");
      } catch (err) { productsToast(err.message); }
    }
  });
}

// ------------------------------------------------------------- grouped view (the cards)

function renderProductsGrouped() {
  const flt = productsFilter();
  const rows = productsData.families.filter((f) => familyMatches(f, flt));
  const pages = Math.max(Math.ceil(rows.length / PRODUCTS_PAGE_SIZE), 1);
  productsPage = Math.min(productsPage, pages);
  const slice = rows.slice((productsPage - 1) * PRODUCTS_PAGE_SIZE, productsPage * PRODUCTS_PAGE_SIZE);

  document.getElementById("productsBody").innerHTML = slice.length
    ? slice.map((f) => {
        const sizes = new Set(f.variants.map((v) => v.size).filter(Boolean)).size;
        const colors = new Set(f.variants.map((v) => v.color).filter(Boolean)).size;
        const bits = [`${f.variants.length} option${f.variants.length === 1 ? "" : "s"}`];
        if (sizes > 1) bits.push(`${sizes} sizes`);
        if (colors > 1) bits.push(`${colors} colors`);
        const hiddenOptions = f.variants.filter((v) => !v.is_visible).length;
        const noPrice = f.variants.filter((v) => v.price == null).length;
        const p = f.variants.map((v) => v.price).filter((x) => x != null);
        const range = !p.length ? "No price" : Math.min(...p) === Math.max(...p) ? pesos(Math.min(...p)) : `${pesos(Math.min(...p))} – ${pesos(Math.max(...p))}`;
        return `<tr class="hover:bg-gray-50 cursor-pointer" data-product="${f.id}">
          <td class="px-3 py-2 w-12">${f.photo
            ? `<img src="${pEsc(f.photo)}" alt="" class="w-10 h-10 rounded-md object-cover border border-gray-200">`
            : `<div class="w-10 h-10 rounded-md bg-gray-100 border border-gray-200 flex items-center justify-center text-[11px] text-gray-400">No photo</div>`}</td>
          <td class="px-3 py-2"><div class="font-semibold text-gray-900">${pEsc(f.name)}</div><div class="text-[11px] text-gray-400">${pEsc(f.section)}</div></td>
          <td class="px-3 py-2 text-gray-600 text-xs">${bits.join(" · ")}${hiddenOptions ? ` <span class="text-amber-600">· ${hiddenOptions} hidden</span>` : ""}${noPrice ? ` <span class="text-red-600">· ${noPrice} no price</span>` : ""}</td>
          <td class="px-3 py-2 text-right tabular-nums text-gray-800 whitespace-nowrap">${pEsc(range)}</td>
          <td class="px-3 py-2 text-center"><label class="inline-flex items-center gap-1.5 text-xs text-gray-600" data-stop="1"><input type="checkbox" class="product-shown" data-id="${f.id}" ${f.is_visible ? "checked" : ""}>${f.is_visible ? "Shown" : "Hidden"}</label></td>
          <td class="px-3 py-2 text-right"><button type="button" class="text-xs font-semibold text-brand-blue hover:underline" data-edit="${f.id}">Edit</button></td>
        </tr>`;
      }).join("")
    : `<tr><td colspan="6" class="text-center text-sm text-gray-400 italic py-8">${productsData.families.length ? "No products match." : "No products yet. Use Import price list, or Add product."}</td></tr>`;

  const first = rows.length ? (productsPage - 1) * PRODUCTS_PAGE_SIZE + 1 : 0;
  document.getElementById("productsRange").textContent = rows.length
    ? `Products ${first}–${Math.min(productsPage * PRODUCTS_PAGE_SIZE, rows.length)} of ${rows.length}` : "No products";
  const btn = (label, target, { active = false, disabled = false } = {}) =>
    `<button type="button" data-ppage="${target}" ${disabled ? "disabled" : ""} class="min-w-[2rem] px-2 py-1 rounded-md border text-sm ${
      active ? "bg-brand-blue text-white border-brand-blue" : "border-gray-300 text-gray-700 hover:bg-gray-50"} ${disabled ? "opacity-40 cursor-default" : ""}">${label}</button>`;
  const nums = pages <= 7 ? Array.from({ length: pages }, (_, i) => i + 1)
    : [...new Set([1, pages, productsPage - 1, productsPage, productsPage + 1])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const items = [];
  nums.forEach((n, i) => { if (i && n - nums[i - 1] > 1) items.push("…"); items.push(n); });
  document.getElementById("productsPages").innerHTML = btn("‹ Prev", productsPage - 1, { disabled: productsPage <= 1 }) +
    items.map((n) => n === "…" ? `<span class="px-1 text-gray-400">…</span>` : btn(n, n, { active: n === productsPage })).join("") +
    btn("Next ›", productsPage + 1, { disabled: productsPage >= pages });
  document.getElementById("productsPager").style.display = rows.length > PRODUCTS_PAGE_SIZE ? "" : "none";
}

// ------------------------------------------------------------- editor (one product, its sizes and colors)

function openModalEl(id) {
  const m = document.getElementById(id);
  m.classList.remove("hidden");
  m.classList.add("flex");
}
function closeModalEl(id) {
  const m = document.getElementById(id);
  m.classList.add("hidden");
  m.classList.remove("flex");
}
async function closeProductEditor() {
  if (Object.keys(productsEdits.family).length || Object.keys(productsEdits.variants).length) {
    if (!(await askYes("You have unsaved changes. Close without saving?", { title: "Close without saving?", confirmLabel: "Close" }))) return;
  }
  productsOpenId = null;
  productsEdits = { family: {}, variants: {} };
  closeModalEl("productEditModal");
}

function openProductEditor(id) {
  productsOpenId = id;
  productsEdits = { family: {}, variants: {} };
  productsDetailOpen = new Set();
  renderProductEditor();
  openModalEl("productEditModal");
}

function numInput(v) { return v == null ? "" : v; }

// a variant as the editor currently shows it: saved values with unsaved edits on top
function editedVariant(v) {
  const merged = Object.assign({}, v, productsEdits.variants[v.id] || {});
  ["unit_price", "qty_per_unit", "unit_cost"].forEach((k) => { if (merged[k] === "") merged[k] = null; });
  return merged;
}

function variantRowHtml(f, v) {
  const m = editedVariant(v);
  const val = (k) => m[k];
  const costs = productsData.can_see_costs;
  const open = productsDetailOpen.has(v.id);
  const price = calcPrice(val("unit_price"), val("qty_per_unit"));
  const costPrice = costs ? calcCostPrice(val("unit_cost"), val("qty_per_unit")) : null;
  const margin = costs ? calcMargin(price, costPrice) : null;
  const inp = "w-full border border-gray-300 rounded-md px-2 py-1 text-sm";
  const lab = (t, inner, cls = "") => `<label class="block ${cls}"><span class="text-[10px] uppercase tracking-wide text-gray-400">${t}</span>${inner}</label>`;
  const field = (k, type = "text", extra = "") =>
    `<input data-v="${v.id}" data-k="${k}" type="${type}" ${type === "number" ? 'step="any" min="0"' : ""} value="${pEsc(type === "number" ? numInput(val(k)) : (val(k) ?? ""))}" class="${inp}" ${extra}>`;
  const peso = `<span class="absolute left-2 top-1/2 -translate-y-1/2 text-gray-400 text-xs">₱</span>`;
  return `<tbody class="border-t border-gray-200" data-vrow="${v.id}">
    <tr class="${val("is_visible") ? "" : "bg-gray-50 text-gray-400"}">
      <td class="px-2 py-1.5 min-w-[11rem]">${field("name")}</td>
      <td class="px-2 py-1.5 w-28"><div class="relative">${peso}${field("unit_price", "number").replace('class="' + inp + '"', 'class="' + inp + ' pl-5 text-right"')}</div></td>
      <td class="px-2 py-1.5 w-24 text-right tabular-nums font-semibold" data-calc-price="${v.id}">${price == null ? "—" : pesos(price)}</td>
      <td class="px-2 py-1.5 w-32"><div class="relative">${peso}${field("box_price", "number").replace('class="' + inp + '"', 'class="' + inp + ' pl-5 text-right"')}</div></td>
      <td class="px-2 py-1.5 w-28"><select data-v="${v.id}" data-k="status" class="${inp} bg-white">${
        ["", "new", "repriced", "incoming", "shelfed"].map((s) => `<option value="${s}" ${val("status") === s ? "selected" : ""}>${PRODUCT_STATUS_LABELS[s] || "—"}</option>`).join("")}</select></td>
      <td class="px-2 py-1.5 text-center w-16"><input type="checkbox" data-v="${v.id}" data-k="is_visible" ${val("is_visible") ? "checked" : ""} title="Show this option in the catalog"></td>
      <td class="px-2 py-1.5 text-right whitespace-nowrap w-32"><button type="button" class="text-xs text-brand-blue hover:underline" data-toggle="${v.id}">${open ? "Less" : "More"}</button>
        <button type="button" class="text-xs text-gray-500 hover:underline ml-2" data-history="${v.id}" title="Price history and all details">History</button></td>
    </tr>
    ${open ? `<tr><td colspan="7" class="px-3 pb-3 bg-gray-50">
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2">
        ${lab("Product (sheet)", field("product"))}${lab("Sub (sheet)", field("sub"))}${lab("SKU", field("sku"))}${lab("Description (brand, material)", field("note"))}
        ${lab("Size", field("size"))}${lab("Color", field("color"))}
        ${lab("Unit type", `<select data-v="${v.id}" data-k="unit_type" class="${inp} bg-white"><option value=""></option>${
          productsData.unit_types.concat(val("unit_type") && !productsData.unit_types.includes(val("unit_type")) ? [val("unit_type")] : [])
            .map((u) => `<option ${val("unit_type") === u ? "selected" : ""}>${pEsc(u)}</option>`).join("")}</select>`)}
        ${lab("Qty per unit (pieces in a pack)", field("qty_per_unit", "number"))}${lab("Qty per box", field("qty_per_box", "number"))}${lab("Minimum qty", field("min_qty", "number"))}
        ${costs ? lab("Supplier (private)", field("supplier")) + lab("Unit cost per piece (private)", field("unit_cost", "number")) +
          `<div class="text-xs text-gray-500 flex items-end pb-1.5 col-span-2" data-calc-cost="${v.id}">${costPrice != null ? `Cost price ${pesos(costPrice)}` : ""}${margin != null ? ` · Margin ${margin.toFixed(2)}%` : ""}</div>` : ""}
      </div>
      <div class="flex items-center gap-4 mt-3 text-xs">
        <span class="text-gray-400">Move to:</span>
        <span class="w-56">${comboHtml({ attr: `data-move="${v.id}"`, items: comboProductItems(f.id), free: false, placeholder: "Search for a product…", cls: "w-full border border-gray-300 rounded-md px-2 py-1 bg-white" })}</span>
        <button type="button" class="text-brand-blue hover:underline" data-split="${v.id}">Make it its own product</button>
        <button type="button" class="text-red-600 hover:underline ml-auto" data-delvariant="${v.id}">Delete option</button>
      </div></td></tr>` : ""}
  </tbody>`;
}

function renderProductEditor() {
  const f = productFamily(productsOpenId);
  if (!f) return;
  const e = productsEdits.family;
  const val = (k) => (k in e ? e[k] : f[k]);
  const inp = "w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm";
  const dirty = Object.keys(productsEdits.family).length || Object.keys(productsEdits.variants).length;
  document.getElementById("productEditBody").innerHTML = `
    <div class="flex items-start justify-between gap-3 mb-4">
      <div>
        <h3 class="font-display font-semibold text-lg leading-tight">${pEsc(f.name)}</h3>
        <p class="text-xs text-gray-500">${pEsc(f.section)} · ${f.variants.length} option${f.variants.length === 1 ? "" : "s"}. Changes show in the catalog as soon as you save.</p>
      </div>
      <button type="button" id="productEditClose" class="text-gray-400 hover:text-black text-2xl leading-none" aria-label="Close">×</button>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-[9rem_1fr] gap-4 mb-5">
      <div>
        ${f.photo ? `<img src="${pEsc(f.photo)}" alt="" class="w-36 h-36 object-cover rounded-lg border border-gray-200">`
          : `<div class="w-36 h-36 rounded-lg bg-gray-100 border border-dashed border-gray-300 flex items-center justify-center text-xs text-gray-400 text-center px-2">No photo yet</div>`}
        <div class="flex gap-2 mt-2 text-xs">
          <label class="text-brand-blue hover:underline cursor-pointer">${f.photo ? "Replace" : "Add photo"}<input type="file" id="productPhotoInput" accept="image/png,image/jpeg,image/webp" class="hidden"></label>
          ${f.photo ? `<button type="button" id="productPhotoRemove" class="text-red-600 hover:underline">Remove</button>` : ""}
        </div>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="block text-xs"><span class="text-gray-500">Product name</span>
          <input data-f="name" value="${pEsc(val("name"))}" class="${inp} mt-0.5"></label>
        <label class="block text-xs"><span class="text-gray-500">Category (the band in the price list)</span>
          ${comboHtml({ attr: 'data-f="section"', value: val("section"), items: productSections().map((s) => ({ v: s, label: s })), cls: inp + " mt-0.5" })}</label>
        <label class="block text-xs sm:col-span-2"><span class="text-gray-500">Description (shown to clients)</span>
          <textarea data-f="description" rows="2" class="${inp} mt-0.5" placeholder="Optional - what it's for, what it's made of">${pEsc(val("description") || "")}</textarea></label>
        <label class="inline-flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" data-f="is_visible" ${val("is_visible") ? "checked" : ""}> Show this product in the catalog</label>
      </div>
    </div>
    <div class="flex items-center justify-between mb-2">
      <h4 class="font-display font-semibold text-sm">Sizes and colors</h4>
      <p class="text-[11px] text-gray-400">Price is worked out: Unit Price × Qty per unit. Clients see New and Incoming as badges; Repriced and Shelfed are for the team.</p>
    </div>
    <div class="overflow-x-auto border border-gray-200 rounded-xl">
      <table class="w-full text-sm">
        <thead><tr class="text-[10px] uppercase tracking-wide font-mono text-gray-400 bg-gray-50">
          <th class="text-left px-2 py-2">Option</th><th class="text-right px-2 py-2">Unit price</th><th class="text-right px-2 py-2">Price</th>
          <th class="text-right px-2 py-2">Box price</th><th class="text-left px-2 py-2">Badge</th><th class="px-2 py-2">Shown</th><th></th></tr></thead>
        ${f.variants.map((v) => variantRowHtml(f, v)).join("")}
      </table>
    </div>
    <div class="flex flex-wrap items-center gap-3 mt-4">
      <button type="button" id="productSave" class="bg-brand-green text-white font-semibold text-sm rounded-lg px-4 py-2 hover:brightness-95 transition disabled:opacity-50" ${dirty ? "" : "disabled"}>Save changes</button>
      <button type="button" id="productAddOption" class="text-sm text-brand-blue hover:underline">+ Add a size or color</button>
      <span id="productSaveStatus" class="text-xs text-gray-500">${dirty ? "Unsaved changes" : ""}</span>
      <span class="ml-auto flex items-center gap-3 text-xs">
        <span class="w-52">${comboHtml({ id: "productMergeInto", items: comboProductItems(f.id), free: false, placeholder: "Merge into… (search)", cls: "w-full border border-gray-300 rounded-md px-2 py-1 bg-white" })}</span>
        <button type="button" id="productDelete" class="text-red-600 hover:underline">Delete product</button>
      </span>
    </div>`;
}

function markEditorDirty() {
  const dirty = Object.keys(productsEdits.family).length || Object.keys(productsEdits.variants).length;
  document.getElementById("productSave").disabled = !dirty;
  document.getElementById("productSaveStatus").textContent = dirty ? "Unsaved changes" : "";
}

function recordProductEdit(el) {
  const raw = el.type === "checkbox" ? el.checked : el.value;
  if (el.dataset.f) {
    const f = productFamily(productsOpenId);
    if (raw === (f[el.dataset.f] ?? "")) delete productsEdits.family[el.dataset.f];
    else productsEdits.family[el.dataset.f] = raw;
  } else if (el.dataset.v) {
    const id = Number(el.dataset.v), k = el.dataset.k;
    const v = productFamily(productsOpenId).variants.find((x) => x.id === id);
    const same = el.type === "number" ? (raw === "" ? v[k] == null : Number(raw) === v[k]) : raw === (v[k] ?? "");
    const e = productsEdits.variants[id] || (productsEdits.variants[id] = {});
    if (same) delete e[k]; else e[k] = raw;
    if (!Object.keys(e).length) delete productsEdits.variants[id];
    // keep the worked-out Price (and cost price / margin) in step as the numbers are typed
    if (["unit_price", "qty_per_unit", "unit_cost"].includes(k)) {
      const m = editedVariant(v);
      const price = calcPrice(m.unit_price, m.qty_per_unit);
      const cell = document.querySelector(`[data-calc-price="${id}"]`);
      if (cell) cell.textContent = price == null ? "—" : pesos(price);
      const costCell = document.querySelector(`[data-calc-cost="${id}"]`);
      if (costCell) {
        const cp = calcCostPrice(m.unit_cost, m.qty_per_unit), mg = calcMargin(price, cp);
        costCell.textContent = (cp != null ? `Cost price ${pesos(cp)}` : "") + (mg != null ? ` · Margin ${mg.toFixed(2)}%` : "");
      }
    }
  }
  markEditorDirty();
}

async function saveProductEdits() {
  const f = productFamily(productsOpenId);
  const status = document.getElementById("productSaveStatus");
  const saveBtn = document.getElementById("productSave");
  saveBtn.disabled = true;
  status.textContent = "Saving…";
  try {
    if (Object.keys(productsEdits.family).length) await productsFetch(`/api/products/families/${f.id}`, { method: "POST", body: productsEdits.family });
    for (const [id, changes] of Object.entries(productsEdits.variants)) {
      await productsFetch(`/api/products/variants/${id}`, { method: "POST", body: changes });
    }
    productsEdits = { family: {}, variants: {} };
    await loadProducts();
    productsToast("Saved. The catalog is updated.");
  } catch (err) {
    status.textContent = err.message;
    saveBtn.disabled = false;
  }
}

function wireProductEditor() {
  const body = document.getElementById("productEditBody");
  body.addEventListener("input", (ev) => {
    const el = ev.target;
    if ((el.dataset.f || el.dataset.v) && el.type !== "checkbox" && el.tagName !== "SELECT") recordProductEdit(el);
  });
  body.addEventListener("change", async (ev) => {
    const el = ev.target;
    if (el.dataset.f || el.dataset.v) {
      if (el.type === "checkbox" || el.tagName === "SELECT") recordProductEdit(el);
      if (el.dataset.v && (el.dataset.k === "is_visible")) renderProductEditor();
      return;
    }
    try {
      if (el.id === "productPhotoInput" && el.files[0]) {
        const form = new FormData();
        form.append("photo", el.files[0]);
        await productsFetch(`/api/products/families/${productsOpenId}/photo`, { method: "POST", form });
        await loadProducts();
        productsToast("Photo saved.");
      } else if (el.dataset.move && el.dataset.pick) {
        const to = productFamily(Number(el.dataset.pick));
        const reset = () => { el.value = ""; delete el.dataset.pick; };
        if (!(await askYes(`Move this option under "${to.name}"?`, { title: "Move this option?", confirmLabel: "Move" }))) { reset(); return; }
        await productsFetch(`/api/products/variants/${el.dataset.move}/move`, { method: "POST", body: { family_id: to.id } });
        await loadProducts();
        if (!productFamily(productsOpenId)) { productsOpenId = null; closeModalEl("productEditModal"); }
        productsToast("Moved.");
      } else if (el.id === "productMergeInto" && el.dataset.pick) {
        const into = productFamily(Number(el.dataset.pick)), f = productFamily(productsOpenId);
        if (!(await askYes(`Merge all of "${f.name}" into "${into.name}"? "${f.name}" will be removed as its own product.`, { title: "Merge products?", confirmLabel: "Merge" }))) { el.value = ""; delete el.dataset.pick; return; }
        await productsFetch(`/api/products/families/${f.id}/merge`, { method: "POST", body: { into: into.id } });
        productsOpenId = into.id;
        productsEdits = { family: {}, variants: {} };
        await loadProducts();
        productsToast("Merged.");
      }
    } catch (err) {
      productsToast(err.message);
    }
  });
  body.addEventListener("click", async (ev) => {
    const t = ev.target.closest("button");
    if (!t) return;
    try {
      if (t.id === "productEditClose") return closeProductEditor();
      if (t.id === "productSave") return saveProductEdits();
      if (t.dataset.history) return openOption(Number(t.dataset.history));
      if (t.dataset.toggle) {
        const id = Number(t.dataset.toggle);
        productsDetailOpen.has(id) ? productsDetailOpen.delete(id) : productsDetailOpen.add(id);
        return renderProductEditor();
      }
      if (t.id === "productPhotoRemove") {
        await productsFetch(`/api/products/families/${productsOpenId}/photo`, { method: "DELETE" });
        await loadProducts();
      } else if (t.id === "productAddOption") {
        const made = await productsFetch(`/api/products/families/${productsOpenId}/variants`, { method: "POST", body: { name: "New option" } });
        productsDetailOpen.add(made.id);
        await loadProducts();
      } else if (t.dataset.split) {
        await productsFetch(`/api/products/variants/${t.dataset.split}/move`, { method: "POST", body: {} });
        await loadProducts();
        if (!productFamily(productsOpenId)) { productsOpenId = null; closeModalEl("productEditModal"); }
        productsToast("It is now its own product.");
      } else if (t.dataset.delvariant) {
        const ok = typeof confirmDialog === "function"
          ? await confirmDialog("This size or color will be removed from Products and the catalog.", { title: "Delete this option?" })
          : window.confirm("Delete this option?");
        if (!ok) return;
        await productsFetch(`/api/products/variants/${t.dataset.delvariant}`, { method: "DELETE" });
        await loadProducts();
        if (!productFamily(productsOpenId)) { productsOpenId = null; closeModalEl("productEditModal"); }
      } else if (t.id === "productDelete") {
        const f = productFamily(productsOpenId);
        const ok = typeof confirmDialog === "function"
          ? await confirmDialog(`"${f.name}" and all ${f.variants.length} of its sizes and colors will be removed from Products and the catalog. To keep it but hide it from clients, untick "Show this product" instead.`, { title: "Delete this product?" })
          : window.confirm("Delete this product?");
        if (!ok) return;
        await productsFetch(`/api/products/families/${f.id}`, { method: "DELETE" });
        productsOpenId = null;
        productsEdits = { family: {}, variants: {} };
        closeModalEl("productEditModal");
        await loadProducts();
      }
    } catch (err) {
      productsToast(err.message);
    }
  });
}

// ------------------------------------------------------------- category photo

let catPhotoName = null;

function renderCategoryPhoto() {
  const url = (productsData.category_photos || {})[catPhotoName];
  document.getElementById("productCategoryBody").innerHTML = `
    <div class="flex items-start justify-between gap-3 mb-3">
      <div><h3 class="font-display font-semibold text-lg leading-tight">Category photo</h3>
        <p class="text-xs text-gray-500">${pEsc(catPhotoName)} - the picture on its card on the catalog's home page. Without one, the first product photo in it is used.</p></div>
      <button type="button" id="catPhotoClose" class="text-gray-400 hover:text-black text-2xl leading-none" aria-label="Close">×</button>
    </div>
    ${url ? `<img src="${pEsc(url)}" alt="" class="w-40 h-40 object-cover rounded-full border border-gray-200 mx-auto">`
      : `<div class="w-40 h-40 rounded-full bg-gray-100 border border-dashed border-gray-300 flex items-center justify-center text-xs text-gray-400 mx-auto">No photo yet</div>`}
    <div class="flex items-center justify-center gap-4 mt-3 text-sm">
      <label class="text-brand-blue hover:underline cursor-pointer">${url ? "Replace" : "Add photo"}<input type="file" id="catPhotoInput" accept="image/png,image/jpeg,image/webp" class="hidden"></label>
      ${url ? `<button type="button" id="catPhotoRemove" class="text-red-600 hover:underline">Remove</button>` : ""}
    </div>
    <p id="catPhotoStatus" class="text-xs text-center text-gray-500 mt-2"></p>`;
}

function openCategoryPhoto(name) {
  catPhotoName = name;
  renderCategoryPhoto();
  openModalEl("productCategoryModal");
}

function wireCategoryPhoto() {
  const modal = document.getElementById("productCategoryModal");
  modal.addEventListener("click", async (ev) => {
    if (ev.target.id === "productCategoryModal" || ev.target.id === "catPhotoClose") return closeModalEl("productCategoryModal");
    if (ev.target.id !== "catPhotoRemove") return;
    try {
      await productsFetch("/api/products/categories/photo", { method: "DELETE", body: { name: catPhotoName } });
      await loadProducts();
      renderCategoryPhoto();
    } catch (err) { productsToast(err.message); }
  });
  modal.addEventListener("change", async (ev) => {
    if (ev.target.id !== "catPhotoInput" || !ev.target.files[0]) return;
    document.getElementById("catPhotoStatus").textContent = "Uploading…";
    try {
      const form = new FormData();
      form.append("photo", ev.target.files[0]);
      form.append("name", catPhotoName);
      await productsFetch("/api/products/categories/photo", { method: "POST", form });
      await loadProducts();
      renderCategoryPhoto();
      productsToast("Category photo saved.");
    } catch (err) { document.getElementById("catPhotoStatus").textContent = err.message; }
  });
}

// ------------------------------------------------------------- add product

function openNewProduct(section = "") {
  const inp = "w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm mt-0.5";
  document.getElementById("productNewBody").innerHTML = `
    <div class="flex items-start justify-between mb-3"><h3 class="font-display font-semibold text-lg">Add a product</h3>
      <button type="button" id="productNewClose" class="text-gray-400 hover:text-black text-2xl leading-none" aria-label="Close">×</button></div>
    <div class="grid grid-cols-2 gap-3 text-xs">
      <label class="block col-span-2"><span class="text-gray-500">Product name *</span><input id="pnName" class="${inp}" placeholder="e.g. Kraft Tub 12oz"></label>
      <label class="block col-span-2"><span class="text-gray-500">Category *</span>
        ${comboHtml({ id: "pnSection", value: section, items: productSections().map((s) => ({ v: s, label: s })), placeholder: "Pick one or type a new one", cls: inp })}</label>
      <label class="block"><span class="text-gray-500">Sold by</span>
        <select id="pnUnit" class="${inp} bg-white">${productsData.unit_types.map((u) => `<option>${pEsc(u)}</option>`).join("")}</select></label>
      <label class="block"><span class="text-gray-500">Pieces per pack</span><input id="pnQty" type="number" step="any" min="1" value="1" class="${inp}"></label>
      <label class="block"><span class="text-gray-500">Unit price - per piece (₱)</span><input id="pnUnitPrice" type="number" step="any" min="0" class="${inp}"></label>
      <div class="flex items-end pb-2 text-sm text-gray-600" id="pnPricePreview"></div>
    </div>
    <p class="text-xs text-gray-400 mt-2">Price is worked out for you. Sizes, colors, photo and the other details can be added once it is created.</p>
    <div class="flex items-center gap-3 mt-4">
      <button type="button" id="pnSave" class="bg-brand-green text-white font-semibold text-sm rounded-lg px-4 py-2 hover:brightness-95 transition">Add product</button>
      <span id="pnStatus" class="text-xs text-red-600"></span></div>`;
  openModalEl("productNewModal");
  document.getElementById("pnName").focus();
}

// ------------------------------------------------------------- import

function openProductsImport() {
  document.getElementById("productsImportBody").innerHTML = `
    <div class="flex items-start justify-between mb-2"><h3 class="font-display font-semibold text-lg">Import the price list</h3>
      <button type="button" id="importClose" class="text-gray-400 hover:text-black text-2xl leading-none" aria-label="Close">×</button></div>
    <p class="text-sm text-gray-600 mb-3">Choose the price list exported from Google Sheets as a CSV. Sizes and colors are grouped into products automatically.
      It only adds items that are not in Products yet and never changes ones that are, so it is safe to run again.</p>
    <input type="file" id="importFile" accept=".csv,text/csv" class="text-sm">
    <div id="importResult" class="mt-4 text-sm"></div>`;
  openModalEl("productsImportModal");
}

async function runProductsImport(commit) {
  const file = document.getElementById("importFile").files[0];
  const out = document.getElementById("importResult");
  if (!file) { out.innerHTML = `<p class="text-red-600">Choose the CSV file first.</p>`; return; }
  out.innerHTML = `<p class="text-gray-500">${commit ? "Importing…" : "Reading the file…"}</p>`;
  try {
    const form = new FormData();
    form.append("file", file);
    form.append("commit", commit ? "1" : "0");
    const r = await productsFetch("/api/products/import", { method: "POST", form });
    const warnings = r.warnings.length
      ? `<details class="mt-2" open><summary class="cursor-pointer text-amber-700">${r.warnings.length} things to check</summary><ul class="list-disc pl-5 mt-1 text-xs text-gray-600 space-y-0.5">${r.warnings.map((w) => `<li>${pEsc(w)}</li>`).join("")}</ul></details>` : "";
    if (r.committed) {
      out.innerHTML = `<p class="text-emerald-700 font-semibold">Imported ${r.new_options} items into ${r.new_products} products.</p>${warnings}`;
      await loadProducts();
    } else {
      out.innerHTML = `<p><b>${r.rows_in_file}</b> rows in the file. <b>${r.new_options}</b> would be added (in <b>${r.new_products}</b> products); <b>${r.already_there}</b> already in Products.</p>${warnings}
        ${r.new_options ? `<button type="button" id="importGo" class="mt-3 bg-brand-green text-white font-semibold text-sm rounded-lg px-4 py-2 hover:brightness-95 transition">Import ${r.new_options} items</button>` : ""}`;
    }
  } catch (err) {
    out.innerHTML = `<p class="text-red-600">${pEsc(err.message)}</p>`;
  }
}

// ------------------------------------------------------------- settings

let productsTab = "catalog"; // "catalog" | "settings"

function setProductsTab(tab) {
  productsTab = tab;
  document.querySelectorAll("#productsTabs [data-ptab]").forEach((b) => {
    const on = b.dataset.ptab === tab;
    b.classList.toggle("border-brand-blue", on);
    b.classList.toggle("text-brand-blue", on);
    b.classList.toggle("border-transparent", !on);
    b.classList.toggle("text-gray-500", !on);
  });
  document.getElementById("productsCatalogPane").classList.toggle("hidden", tab !== "catalog");
  document.getElementById("productsItemActions").classList.toggle("hidden", tab !== "catalog");
  const pane = document.getElementById("productsSettingsPane");
  pane.classList.toggle("hidden", tab !== "settings");
  if (tab === "settings") renderProductsSettings();
}

function renderProductsSettings() {
  const s = productsData.settings || {};
  const inp = "w-full border border-gray-300 rounded-md px-2 py-1.5 text-sm mt-0.5";
  const card = (title, hint, inner) => `<section class="bg-white border border-gray-200 rounded-xl shadow-sm p-4">
    <h3 class="font-display font-semibold text-base leading-tight">${title}</h3><p class="text-xs text-gray-500 mb-3">${hint}</p>${inner}</section>`;
  document.getElementById("productsSettingsPane").innerHTML = `<div class="max-w-2xl space-y-4">
    ${card("Catalog page", "The text clients see when they open the catalog.",
      `<label class="block text-xs"><span class="text-gray-500">Intro line at the top of the catalog</span><textarea id="stIntro" rows="2" class="${inp}">${pEsc(s.intro)}</textarea></label>`)}
    ${card("What clients see", "Choose which details show next to each product.",
      `<label class="flex items-center gap-2 text-sm mb-2"><input type="checkbox" id="stBox" ${s.show_box_prices === "1" ? "checked" : ""}> Show box prices (where one is set)</label>
       <label class="flex items-center gap-2 text-sm"><input type="checkbox" id="stSku" ${s.show_sku === "1" ? "checked" : ""}> Show SKU codes</label>`)}
    ${card("Contact", "The button and number clients use to reach you. Leave blank to hide it.",
      `<div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
        <label class="block"><span class="text-gray-500">Contact button text</span><input id="stLabel" value="${pEsc(s.contact_label)}" class="${inp}" placeholder="Message us"></label>
        <label class="block"><span class="text-gray-500">Phone number to show</span><input id="stPhone" value="${pEsc(s.contact_phone)}" class="${inp}" placeholder="0917 000 0000"></label>
        <label class="block sm:col-span-2"><span class="text-gray-500">Contact link (Messenger, Viber, WhatsApp...) - must start with https://</span><input id="stUrl" value="${pEsc(s.contact_url)}" class="${inp}" placeholder="https://m.me/yourpage"></label>
      </div>`)}
    <div class="flex items-center gap-3"><button type="button" id="stSave" class="bg-brand-green text-white font-semibold text-sm rounded-lg px-4 py-2 hover:brightness-95 transition">Save settings</button>
      <span id="stStatus" class="text-xs text-red-600"></span></div></div>`;
}

// ------------------------------------------------------------- wiring

function wireProducts() {
  const rerender = () => { productsPage = 1; renderProducts(); };
  document.getElementById("productsSearch").addEventListener("input", rerender);
  document.getElementById("productsShow").addEventListener("change", rerender);
  document.getElementById("productsSection").addEventListener("change", () => {
    const picked = document.getElementById("productsSection").value ? "" : "none";
    document.getElementById("productsRenameSection").style.display = picked;
    document.getElementById("productsCategoryPhoto").style.display = picked;
    rerender();
  });
  document.getElementById("productsViewSheet").addEventListener("click", () => setProductsView("sheet"));
  document.getElementById("productsViewGrouped").addEventListener("click", () => setProductsView("grouped"));

  // price list: fold a band, open an item
  document.getElementById("productsSheetBody").addEventListener("click", async (ev) => {
    const add = ev.target.closest("[data-addto]");
    if (add) { ev.stopPropagation(); return openNewProduct(add.dataset.addto); }
    const catPhoto = ev.target.closest("[data-photo-cat]");
    if (catPhoto) { ev.stopPropagation(); return openCategoryPhoto(catPhoto.dataset.photoCat); }
    const band = ev.target.closest("tr.pband");
    if (band) {
      const s = band.dataset.band;
      productsCollapsed.has(s) ? productsCollapsed.delete(s) : productsCollapsed.add(s);
      return renderProductsSheet();
    }
    const tr = ev.target.closest("tr.prow");
    if (tr && ev.target.closest(".sheet-open")) openOption(Number(tr.dataset.vid));
  });

  document.getElementById("productsBody").addEventListener("click", async (ev) => {
    const check = ev.target.closest(".product-shown");
    if (check) {
      ev.stopPropagation();
      try {
        await productsFetch(`/api/products/families/${check.dataset.id}`, { method: "POST", body: { is_visible: check.checked } });
        productFamily(Number(check.dataset.id)).is_visible = check.checked;
        renderProducts();
        productsToast(check.checked ? "Now shown in the catalog." : "Hidden from the catalog.");
      } catch (err) {
        check.checked = !check.checked;
        productsToast(err.message);
      }
      return;
    }
    if (ev.target.closest("[data-stop]")) return;
    const row = ev.target.closest("tr[data-product]");
    if (row) openProductEditor(Number(row.dataset.product));
  });
  document.getElementById("productsPages").addEventListener("click", (ev) => {
    const b = ev.target.closest("button[data-ppage]");
    if (!b || b.disabled) return;
    productsPage = Number(b.dataset.ppage);
    renderProducts();
    document.getElementById("productsTop").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.getElementById("productsAddBtn").addEventListener("click", () => openNewProduct());
  document.getElementById("productsImportBtn").addEventListener("click", openProductsImport);
  document.getElementById("productsTabs").addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-ptab]");
    if (b) setProductsTab(b.dataset.ptab);
  });
  setProductsTab("catalog");
  document.getElementById("productsCopyLink").addEventListener("click", async () => {
    const url = location.origin + "/shop";
    try { await navigator.clipboard.writeText(url); productsToast("Catalog link copied."); }
    catch (e) { window.prompt("Copy the catalog link:", url); }
  });
  document.getElementById("productsCategoryPhoto").addEventListener("click", () => {
    const name = document.getElementById("productsSection").value;
    if (name) openCategoryPhoto(name);
  });
  document.getElementById("productsRenameSection").addEventListener("click", async () => {
    const old = document.getElementById("productsSection").value;
    const next = window.prompt(`Rename the category "${old}" to:`, old);
    if (!next || !next.trim() || next.trim() === old) return;
    try {
      const r = await productsFetch("/api/products/sections/rename", { method: "POST", body: { old, new: next.trim() } });
      productsToast(`Renamed. ${r.count} products moved.`);
      document.getElementById("productsSection").value = next.trim();
      await loadProducts();
      document.getElementById("productsSection").value = next.trim();
      renderProducts();
    } catch (err) { productsToast(err.message); }
  });

  wireProductEditor();
  wireOptionPopup();
  wireCategoryPhoto();
  document.getElementById("productEditModal").addEventListener("click", (ev) => { if (ev.target.id === "productEditModal") closeProductEditor(); });

  const newModal = document.getElementById("productNewModal");
  newModal.addEventListener("input", (ev) => {
    if (!["pnQty", "pnUnitPrice"].includes(ev.target.id)) return;
    const unit = document.getElementById("pnUnit");
    if (ev.target.id === "pnQty" && Number(ev.target.value) > 1 && unit.value === "Pcs") unit.value = "Pack (pcs)";
    const price = calcPrice(document.getElementById("pnUnitPrice").value || null, document.getElementById("pnQty").value);
    document.getElementById("pnPricePreview").textContent = price == null ? "" : `Price: ${pesos(price)}`;
  });
  newModal.addEventListener("click", async (ev) => {
    if (ev.target.id === "productNewModal" || ev.target.id === "productNewClose") return closeModalEl("productNewModal");
    if (ev.target.id !== "pnSave") return;
    const g = (id) => document.getElementById(id).value.trim();
    const status = document.getElementById("pnStatus");
    status.textContent = "";
    if (!g("pnName") || !g("pnSection")) { status.textContent = "A product needs a name and a category."; return; }
    try {
      const r = await productsFetch("/api/products/families", {
        method: "POST",
        body: { name: g("pnName"), section: g("pnSection"), variant: { unit_type: g("pnUnit"), qty_per_unit: g("pnQty"), unit_price: g("pnUnitPrice") } },
      });
      closeModalEl("productNewModal");
      await loadProducts();
      openProductEditor(r.id);
    } catch (err) { status.textContent = err.message; }
  });

  document.getElementById("productsImportModal").addEventListener("click", (ev) => {
    if (ev.target.id === "productsImportModal" || ev.target.id === "importClose") return closeModalEl("productsImportModal");
    if (ev.target.id === "importGo") runProductsImport(true);
  });
  document.getElementById("productsImportModal").addEventListener("change", (ev) => {
    if (ev.target.id === "importFile") runProductsImport(false);
  });

  document.getElementById("productsSettingsPane").addEventListener("click", async (ev) => {
    if (ev.target.id !== "stSave") return;
    const status = document.getElementById("stStatus");
    status.textContent = "";
    try {
      const r = await productsFetch("/api/products/settings", {
        method: "POST",
        body: {
          intro: document.getElementById("stIntro").value,
          show_box_prices: document.getElementById("stBox").checked,
          show_sku: document.getElementById("stSku").checked,
          contact_label: document.getElementById("stLabel").value,
          contact_phone: document.getElementById("stPhone").value,
          contact_url: document.getElementById("stUrl").value,
        },
      });
      productsData.settings = r.settings;
      productsToast("Settings saved.");
    } catch (err) { status.textContent = err.message; }
  });
}

if (document.getElementById("productsView")) wireProducts();
