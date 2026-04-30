import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Package, Users, FlaskConical, FileText, Settings as SettingsIcon,
  Plus, Trash2, Pencil, Search, Printer, Truck, X, Check,
  ChevronRight, AlertCircle, Loader2, Copy, ClipboardCheck, DollarSign, Download, MapPin,
} from "lucide-react";

/* =========================================================================
   Storage helpers — two modes, auto-detected at startup
   ----------------------------------------------------------------------
   1. "backend"  → Cloudflare Worker + KV (shared across devices/team)
   2. "local"    → localStorage (browser-only fallback before backend
                                 is configured)
   ========================================================================= */

const BACKEND_CFG_KEY = "shipping_data_backend_v1";

function readBackendCfg() {
  try {
    const raw = (typeof localStorage !== "undefined") ? localStorage.getItem(BACKEND_CFG_KEY) : null;
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function writeBackendCfg(cfg) {
  try {
    if (cfg && cfg.url) {
      localStorage.setItem(BACKEND_CFG_KEY, JSON.stringify(cfg));
    } else {
      localStorage.removeItem(BACKEND_CFG_KEY);
    }
  } catch {}
}

const _backendCfg = readBackendCfg();
const STORE_MODE = _backendCfg?.url ? "backend" : "local";

const KEYS = {
  company: "settings:company",
  fedex: "settings:fedex",
  counters: "settings:counters",
  customer: (id) => `customers:${id}`,
  product: (id) => `products:${id}`,
  order: (id) => `orders:${id}`,
};

async function _api(path, body) {
  const res = await fetch(_backendCfg.url.replace(/\/+$/, "") + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-app-auth": _backendCfg.token || "",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `${path} → HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

const store = {
  mode: STORE_MODE,

  async get(key, fallback = null) {
    try {
      if (STORE_MODE === "backend") {
        const r = await _api("/get", { key });
        return r ? JSON.parse(r.value) : fallback;
      }
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      console.error("store.get", key, e);
      return fallback;
    }
  },

  async set(key, value) {
    try {
      const serialized = JSON.stringify(value);
      if (STORE_MODE === "backend") {
        await _api("/set", { key, value: serialized });
      } else {
        localStorage.setItem(key, serialized);
      }
      return true;
    } catch (e) {
      console.error("store.set", key, e);
      return false;
    }
  },

  async del(key) {
    try {
      if (STORE_MODE === "backend") await _api("/delete", { key });
      else localStorage.removeItem(key);
      return true;
    } catch (e) {
      console.error("store.del", key, e);
      return false;
    }
  },

  async list(prefix) {
    try {
      if (STORE_MODE === "backend") {
        const r = await _api("/list", { prefix, withValues: true });
        return (r.items || []).map((i) => {
          try { return JSON.parse(i.value); } catch { return null; }
        }).filter(Boolean);
      }
      const items = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) {
          const v = await this.get(k);
          if (v) items.push(v);
        }
      }
      return items;
    } catch (e) {
      console.error("store.list", prefix, e);
      return [];
    }
  },
};

/* =========================================================================
   Utilities
   ========================================================================= */

const newId = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const fmtUSD = (n) => `$${(Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Date().toISOString().slice(0, 10);
const niceDate = (s) => {
  if (!s) return "";
  const d = new Date(s + (s.length === 10 ? "T00:00:00" : ""));
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
};

/* ---------- CSV export utilities ---------- */

function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(",") || s.includes("\n") || s.includes("\r") || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCSV(headers, rows) {
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(","));
  }
  // Excel-compatible: BOM + CRLF line endings
  return "\uFEFF" + lines.join("\r\n");
}

function downloadCSV(filename, csv) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ---------- Title formatting helpers (used for PDF filename) ---------- */

function formatTitleDate(s) {
  if (!s) return todayStamp();
  // Normalize "2026-04-29" → "2026-04-29" (already good for sortable filenames)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  try {
    const d = new Date(s);
    if (!isNaN(d)) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
  } catch {}
  return s;
}

function formatProductNames(lineItems) {
  if (!lineItems || lineItems.length === 0) return "";
  // Pull the first word of each line item description (skip pack size, etc.)
  const names = lineItems
    .map((li) => {
      const desc = (li.description || "").trim();
      if (!desc) return "";
      // "GHK-Cu, 1x5g bottle" → "GHK-Cu"
      // "Dihexa 10g vial" → "Dihexa"
      const beforeComma = desc.split(",")[0].trim();
      return beforeComma.split(/\s+/)[0]; // first whitespace-separated token
    })
    .filter(Boolean);
  // Dedupe while preserving order
  const seen = new Set();
  const unique = names.filter((n) => {
    const k = n.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (unique.length === 0) return "";
  if (unique.length <= 3) return unique.join(", ");
  return `${unique.slice(0, 3).join(", ")} +${unique.length - 3} more`;
}

/* ---------- Per-entity CSV exports ---------- */

function exportCustomersCSV(customers) {
  const headers = [
    "Customer ID", "Company Name", "Contact Name",
    "Address Line 1", "Address Line 2", "City", "State", "ZIP", "Country",
    "Phone", "Email", "Residential", "Notes",
  ];
  const rows = customers.map((c) => [
    c.customerId || "",
    c.name || "",
    c.contactName || "",
    c.addressLine1 || "",
    c.addressLine2 || "",
    c.city || "",
    c.state || "",
    c.zip || "",
    c.country || "",
    c.phone || "",
    c.email || "",
    c.residential ? "Yes" : "No",
    c.notes || "",
  ]);
  downloadCSV(`customers-${todayStamp()}.csv`, rowsToCSV(headers, rows));
}

function exportProductsCSV(products) {
  const headers = [
    "Name", "CAS Number", "Default Unit", "Default Price (USD)",
    "Default Pack Size", "Current Batch #", "Default Description", "Notes",
  ];
  const rows = products.map((p) => [
    p.name || "",
    p.casNumber || "",
    p.defaultUnit || "",
    p.defaultPrice || "",
    p.defaultPackSize || "",
    p.batchNumber || "",
    p.defaultDescription || "",
    p.notes || "",
  ]);
  downloadCSV(`catalog-${todayStamp()}.csv`, rowsToCSV(headers, rows));
}

function exportOrdersSummaryCSV(orders) {
  const headers = [
    "Invoice #", "Date", "Customer", "Customer ID", "PO #",
    "Items Subtotal", "S&H", "Total", "Tracking #", "Service",
    "Ship City", "Ship State", "Ship ZIP",
  ];
  const rows = orders.map((o) => {
    const c = o.customerSnapshot || {};
    return [
      o.invoiceNumber || "",
      o.date || "",
      c.name || "",
      c.customerId || "",
      o.poNumber || "",
      Number(o.itemsSubtotal || 0).toFixed(2),
      Number(o.shipping || 0).toFixed(2),
      Number(o.total || 0).toFixed(2),
      o.tracking || "",
      o.shipService || "",
      c.city || "",
      c.state || "",
      c.zip || "",
    ];
  });
  downloadCSV(`orders-${todayStamp()}.csv`, rowsToCSV(headers, rows));
}

function exportOrdersLineItemsCSV(orders) {
  const headers = [
    "Invoice #", "Date", "Customer", "Customer ID",
    "Product Description", "CAS", "Unit", "Quantity", "Unit Price",
    "Pack Size", "Pack Count", "Batch #", "Line Amount",
    "Order S&H", "Order Total", "Tracking #",
  ];
  const rows = [];
  for (const o of orders) {
    const c = o.customerSnapshot || {};
    if (!o.lineItems || o.lineItems.length === 0) {
      rows.push([
        o.invoiceNumber || "", o.date || "", c.name || "", c.customerId || "",
        "(no line items)", "", "", "", "", "", "", "", "",
        Number(o.shipping || 0).toFixed(2), Number(o.total || 0).toFixed(2), o.tracking || "",
      ]);
      continue;
    }
    for (const li of o.lineItems) {
      rows.push([
        o.invoiceNumber || "",
        o.date || "",
        c.name || "",
        c.customerId || "",
        li.description || "",
        li.casNumber || "",
        li.unit || "",
        li.quantity || "",
        li.unitPriceNum || "",
        li.packSize || "",
        li.packCount || "",
        li.batchNumber || "",
        Number(li.amount || 0).toFixed(2),
        Number(o.shipping || 0).toFixed(2),
        Number(o.total || 0).toFixed(2),
        o.tracking || "",
      ]);
    }
  }
  downloadCSV(`order-line-items-${todayStamp()}.csv`, rowsToCSV(headers, rows));
}

const DEFAULT_COMPANY = {
  name: "RefDrug",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  zip: "",
  country: "US",
  phone: "",
  fax: "",
  email: "tyzhang@refdrug.com",
  website: "refdrug.com",
  bankName: "",
  bankAccount: "",
  bankRouting: "",
  bankAddress: "",
  signatoryName: "",
  logoDataUrl: "",
  signatureDataUrl: "",
  sealDataUrl: "",
};

const DEFAULT_FEDEX = {
  workerUrl: "",
  appAuthToken: "",
  defaultService: "FEDEX_GROUND",
  defaultPackaging: "YOUR_PACKAGING",
  markupPercent: 0,
  shipFrom: { /* falls back to company info if blank */
    contactName: "",
    companyName: "",
    phone: "",
    line1: "",
    line2: "",
    city: "",
    state: "",
    zip: "",
    country: "US",
  },
};

/* =========================================================================
   Root App
   ========================================================================= */

export default function App() {
  const [view, setView] = useState("orders");
  const [loading, setLoading] = useState(true);
  const [company, setCompany] = useState(DEFAULT_COMPANY);
  const [fedex, setFedex] = useState(DEFAULT_FEDEX);
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [counters, setCounters] = useState({ invoice: 1, order: 1 });
  const [printOrder, setPrintOrder] = useState(null);    // shows full-screen invoice/packing-slip
  const [printMode, setPrintMode] = useState("invoice"); // "invoice" | "packing"
  const [toast, setToast] = useState(null);

  const showToast = (msg, kind = "ok") => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3500);
  };

  /* ---------- load ---------- */
  useEffect(() => {
    (async () => {
      const [c, fx, ct, cust, prod, ord] = await Promise.all([
        store.get(KEYS.company, DEFAULT_COMPANY),
        store.get(KEYS.fedex, DEFAULT_FEDEX),
        store.get(KEYS.counters, { invoice: 1, order: 1 }),
        store.list("customers:"),
        store.list("products:"),
        store.list("orders:"),
      ]);
      setCompany({ ...DEFAULT_COMPANY, ...c });
      setFedex({ ...DEFAULT_FEDEX, ...fx, shipFrom: { ...DEFAULT_FEDEX.shipFrom, ...(fx?.shipFrom || {}) } });
      setCounters(ct);
      setCustomers(cust.sort((a, b) => a.name.localeCompare(b.name)));
      setProducts(prod.sort((a, b) => a.name.localeCompare(b.name)));
      setOrders(ord.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
      setLoading(false);
    })();
  }, []);

  /* ---------- prevent mouse wheel + arrow keys from changing focused number inputs ---------- */
  useEffect(() => {
    const onWheel = () => {
      const a = document.activeElement;
      if (a && a.tagName === "INPUT" && a.type === "number") {
        a.blur();
      }
    };
    const onKey = (e) => {
      const a = document.activeElement;
      if (a && a.tagName === "INPUT" && a.type === "number") {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
        }
      }
    };
    window.addEventListener("wheel", onWheel);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  /* ---------- CRUD wrappers ---------- */
  const saveCompany = async (next) => {
    setCompany(next);
    await store.set(KEYS.company, next);
    showToast("Settings saved");
  };
  const saveFedex = async (next) => {
    setFedex(next);
    await store.set(KEYS.fedex, next);
    showToast("FedEx config saved");
  };
  const saveCounters = async (next) => {
    setCounters(next);
    await store.set(KEYS.counters, next);
  };

  const upsertCustomer = async (c) => {
    const id = c.id || newId();
    const rec = { ...c, id, updatedAt: Date.now() };
    await store.set(KEYS.customer(id), rec);
    setCustomers((prev) => {
      const without = prev.filter((x) => x.id !== id);
      return [...without, rec].sort((a, b) => a.name.localeCompare(b.name));
    });
    showToast(c.id ? "Customer updated" : "Customer added");
    return rec;
  };
  const deleteCustomer = async (id) => {
    await store.del(KEYS.customer(id));
    setCustomers((prev) => prev.filter((x) => x.id !== id));
    showToast("Customer deleted");
  };

  const upsertProduct = async (p) => {
    const id = p.id || newId();
    const rec = { ...p, id, updatedAt: Date.now() };
    await store.set(KEYS.product(id), rec);
    setProducts((prev) => {
      const without = prev.filter((x) => x.id !== id);
      return [...without, rec].sort((a, b) => a.name.localeCompare(b.name));
    });
    showToast(p.id ? "Product updated" : "Product added");
    return rec;
  };
  const deleteProduct = async (id) => {
    await store.del(KEYS.product(id));
    setProducts((prev) => prev.filter((x) => x.id !== id));
    showToast("Product deleted");
  };

  const saveOrder = async (o) => {
    const id = o.id || newId();
    const rec = { ...o, id, updatedAt: Date.now(), createdAt: o.createdAt || Date.now() };
    await store.set(KEYS.order(id), rec);
    setOrders((prev) => {
      const without = prev.filter((x) => x.id !== id);
      return [rec, ...without].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    });
    if (!o.id) {
      const next = { ...counters, invoice: counters.invoice + 1, order: counters.order + 1 };
      await saveCounters(next);
    }
    return rec;
  };
  const deleteOrder = async (id) => {
    await store.del(KEYS.order(id));
    setOrders((prev) => prev.filter((x) => x.id !== id));
    showToast("Order deleted");
  };

  /* ---------- print preview gateway ---------- */
  const openPrint = (order, mode) => {
    setPrintOrder(order);
    setPrintMode(mode);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <Loader2 className="w-6 h-6 animate-spin text-stone-500" />
      </div>
    );
  }

  if (printOrder) {
    return (
      <PrintView
        order={printOrder}
        mode={printMode}
        company={company}
        onClose={() => setPrintOrder(null)}
        switchMode={(m) => setPrintMode(m)}
      />
    );
  }

  return (
    <div className="min-h-screen flex bg-stone-50 text-stone-900" style={{ fontFamily: "'Inter Tight', ui-sans-serif, system-ui, sans-serif" }}>
      <style>{`
        input[type="number"]::-webkit-inner-spin-button,
        input[type="number"]::-webkit-outer-spin-button {
          -webkit-appearance: none;
          margin: 0;
        }
        input[type="number"] {
          -moz-appearance: textfield;
          appearance: textfield;
        }
      `}</style>
      <Nav view={view} setView={setView} />
      <main className="flex-1 min-w-0">
        <div className="max-w-[1400px] mx-auto px-8 py-8">
          {view === "orders" && (
            <NewOrder
              customers={customers}
              products={products}
              counters={counters}
              company={company}
              fedex={fedex}
              onSave={saveOrder}
              onPrint={openPrint}
              showToast={showToast}
            />
          )}
          {view === "customers" && (
            <CustomersView
              customers={customers}
              onSave={upsertCustomer}
              onDelete={deleteCustomer}
              fedex={fedex}
            />
          )}
          {view === "products" && (
            <ProductsView
              products={products}
              onSave={upsertProduct}
              onDelete={deleteProduct}
            />
          )}
          {view === "history" && (
            <HistoryView
              orders={orders}
              onPrint={openPrint}
              onDelete={deleteOrder}
            />
          )}
          {view === "settings" && (
            <SettingsView
              company={company}
              fedex={fedex}
              counters={counters}
              onSaveCompany={saveCompany}
              onSaveFedex={saveFedex}
              onSaveCounters={saveCounters}
            />
          )}
        </div>
      </main>

      {toast && (
        <div
          className={`fixed bottom-6 right-6 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium ${
            toast.kind === "err" ? "bg-red-600 text-white" : "bg-stone-900 text-white"
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}

/* =========================================================================
   Nav
   ========================================================================= */

function Nav({ view, setView }) {
  const items = [
    { id: "orders", label: "New Order", icon: Plus },
    { id: "customers", label: "Customers", icon: Users },
    { id: "products", label: "Catalog", icon: FlaskConical },
    { id: "history", label: "Orders", icon: FileText },
    { id: "settings", label: "Settings", icon: SettingsIcon },
  ];
  return (
    <aside className="w-60 shrink-0 bg-white border-r border-stone-200 min-h-screen sticky top-0">
      <div className="px-5 py-6 border-b border-stone-200">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded bg-stone-900 text-white flex items-center justify-center">
            <Package className="w-4 h-4" />
          </div>
          <div>
            <div className="text-sm font-semibold tracking-tight">Shipping</div>
            <div className="text-[11px] text-stone-500 -mt-0.5">RefDrug</div>
          </div>
        </div>
      </div>
      <nav className="p-3 space-y-0.5">
        {items.map((it) => {
          const Icon = it.icon;
          const active = view === it.id;
          return (
            <button
              key={it.id}
              onClick={() => setView(it.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition ${
                active ? "bg-stone-900 text-white" : "text-stone-700 hover:bg-stone-100"
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              <span>{it.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

/* =========================================================================
   New Order
   ========================================================================= */

function NewOrder({ customers, products, counters, company, fedex, onSave, onPrint, showToast }) {
  const [customerId, setCustomerId] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [date, setDate] = useState(today());
  const [invoiceNumber, setInvoiceNumber] = useState(formatInvoice(counters.invoice, company));
  const [shipping, setShipping] = useState(0);
  const [lineItems, setLineItems] = useState([]);
  const [shipWeightLbs, setShipWeightLbs] = useState(2);
  const [shipDims, setShipDims] = useState({ length: 10, width: 8, height: 4 });
  const [shipService, setShipService] = useState(fedex.defaultService || "FEDEX_GROUND");
  const [signatureRequired, setSignatureRequired] = useState(false);
  const [shipping_state, setShippingState] = useState({ status: "idle", tracking: null, labelBase64: null, error: null });
  const [savedOrderId, setSavedOrderId] = useState(null);
  const [rates, setRates] = useState([]);
  const [ratesStatus, setRatesStatus] = useState("idle"); // idle | loading | ok | err
  const [ratesError, setRatesError] = useState(null);

  useEffect(() => {
    setInvoiceNumber(formatInvoice(counters.invoice, company));
  }, [counters.invoice, company.name]);

  const customer = customers.find((c) => c.id === customerId);
  const itemsSubtotal = useMemo(
    () => lineItems.reduce((s, x) => s + (Number(x.amount) || 0), 0),
    [lineItems]
  );
  const total = itemsSubtotal + (Number(shipping) || 0);

  const addLine = () => {
    setLineItems((prev) => [
      ...prev,
      {
        id: newId(),
        productId: "",
        description: "",
        casNumber: "",
        unit: "Gram",
        quantity: 0,
        unitPriceNum: 0,
        unitPriceDisplay: "",
        amount: 0,
        batchNumber: "",
        packSize: "",
        packCount: 1,
      },
    ]);
  };

  const updateLine = (id, patch) => {
    setLineItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const merged = { ...it, ...patch };
        // recompute amount when qty or unitPrice changes
        if ("quantity" in patch || "unitPriceNum" in patch) {
          const qty = Number(merged.quantity) || 0;
          const price = Number(merged.unitPriceNum) || 0;
          merged.amount = +(qty * price).toFixed(2);
          if (!merged.unitPriceDisplay && price > 0) {
            merged.unitPriceDisplay = `$${price}/${(merged.unit || "g").toLowerCase().slice(0, 1)}`;
          }
        }
        return merged;
      })
    );
  };

  const pickProduct = (lineId, productId) => {
    const p = products.find((x) => x.id === productId);
    if (!p) {
      updateLine(lineId, { productId: "" });
      return;
    }
    updateLine(lineId, {
      productId: p.id,
      description: p.defaultDescription || `${p.name}${p.defaultPackSize ? ", " + p.defaultPackSize : ""}`,
      casNumber: p.casNumber || "",
      unit: p.defaultUnit || "Gram",
      unitPriceNum: Number(p.defaultPrice) || 0,
      unitPriceDisplay: p.defaultPrice ? `$${p.defaultPrice}/g` : "",
      batchNumber: p.batchNumber || "",
      packSize: p.defaultPackSize || "",
    });
  };

  const removeLine = (id) => setLineItems((prev) => prev.filter((it) => it.id !== id));

  const buildOrder = () => ({
    invoiceNumber,
    poNumber,
    date,
    customerId: customer?.id,
    customerSnapshot: customer ? { ...customer } : null,
    lineItems,
    shipping: Number(shipping) || 0,
    itemsSubtotal,
    total,
    shipWeightLbs: Number(shipWeightLbs) || 0,
    shipDims,
    shipService,
    signatureRequired,
    tracking: shipping_state.tracking || null,
  });

  const validate = () => {
    if (!customer) return "Pick a customer";
    if (lineItems.length === 0) return "Add at least one line item";
    if (lineItems.some((x) => !x.description || !x.quantity)) return "Each line needs a description and quantity";
    return null;
  };

  const saveAndStay = async () => {
    const err = validate();
    if (err) return showToast(err, "err");
    const rec = await onSave(buildOrder());
    setSavedOrderId(rec.id);
    showToast("Order saved");
    return rec;
  };

  const handlePrint = async (mode) => {
    const err = validate();
    if (err) return showToast(err, "err");
    let order;
    if (savedOrderId) {
      order = { ...buildOrder(), id: savedOrderId };
      await onSave(order);
    } else {
      order = await onSave(buildOrder());
      setSavedOrderId(order.id);
    }
    onPrint(order, mode);
  };

  const markupRate = (amount) => {
    const pct = Number(fedex.markupPercent) || 0;
    return Number(amount) * (1 + pct / 100);
  };

  const useRate = (rate) => {
    setShipService(rate.serviceType);
    setShipping(markupRate(rate.amount).toFixed(2));
    showToast(`Set ${rate.serviceName || rate.serviceType} — ${fmtUSD(markupRate(rate.amount))}`);
  };

  const getRates = async () => {
    if (!customer) return showToast("Pick a customer first", "err");
    if (!fedex.workerUrl) return showToast("Set the FedEx Worker URL in Settings first", "err");
    if (!shipWeightLbs || Number(shipWeightLbs) <= 0) return showToast("Enter a weight", "err");

    setRatesStatus("loading");
    setRatesError(null);

    const shipFrom = buildShipFrom(fedex, company);
    const payload = {
      from: shipFrom,
      to: {
        address: {
          streetLines: [customer.addressLine1, customer.addressLine2].filter(Boolean),
          city: customer.city,
          stateOrProvinceCode: customer.state,
          postalCode: customer.zip,
          countryCode: customer.country || "US",
          residential: !!customer.residential,
        },
      },
      weightLbs: Number(shipWeightLbs),
      dimensionsIn: shipDims,
    };

    try {
      const res = await fetch(fedex.workerUrl + "/rate", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-app-auth": fedex.appAuthToken || "",
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Rate request failed");

      // Normalize: total field may be a number or { amount, currency }
      const normalized = (data.rates || []).map((r) => {
        const amount = typeof r.total === "object" && r.total !== null ? r.total.amount : r.total;
        return { ...r, amount: Number(amount) || 0 };
      }).filter((r) => r.amount > 0);

      normalized.sort((a, b) => a.amount - b.amount);
      setRates(normalized);
      setRatesStatus(normalized.length > 0 ? "ok" : "err");
      if (normalized.length === 0) setRatesError("No rates returned for this destination");
    } catch (e) {
      setRatesStatus("err");
      setRatesError(e.message);
    }
  };

  const handleShip = async () => {
    const err = validate();
    if (err) return showToast(err, "err");
    if (!fedex.workerUrl) return showToast("Set the FedEx Worker URL in Settings first", "err");

    setShippingState({ status: "loading", tracking: null, labelBase64: null, error: null });

    const shipFrom = buildShipFrom(fedex, company);
    const payload = {
      from: shipFrom,
      to: {
        contact: {
          personName: customer.contactName || customer.name,
          companyName: customer.name,
          phoneNumber: (customer.phone || "").replace(/\D/g, ""),
        },
        address: {
          streetLines: [customer.addressLine1, customer.addressLine2].filter(Boolean),
          city: customer.city,
          stateOrProvinceCode: customer.state,
          postalCode: customer.zip,
          countryCode: customer.country || "US",
        },
        residential: !!customer.residential,
      },
      weightLbs: Number(shipWeightLbs),
      dimensionsIn: shipDims,
      serviceType: shipService,
      packagingType: fedex.defaultPackaging || "YOUR_PACKAGING",
      reference: invoiceNumber,
      declaredValueUSD: total,
      signatureRequired,
    };

    try {
      const res = await fetch(fedex.workerUrl + "/ship", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-app-auth": fedex.appAuthToken || "",
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Ship request failed");

      setShippingState({
        status: "ok",
        tracking: data.trackingNumber,
        labelBase64: data.labelBase64,
        error: null,
      });

      // save with tracking
      const order = await onSave({
        ...buildOrder(),
        id: savedOrderId || undefined,
        tracking: data.trackingNumber,
        shippedAt: Date.now(),
      });
      setSavedOrderId(order.id);

      // open label in new tab
      if (data.labelBase64) openPdfFromBase64(data.labelBase64, `Label-${data.trackingNumber}.pdf`);
      showToast(`Shipped — tracking ${data.trackingNumber}`);
    } catch (e) {
      setShippingState({ status: "err", tracking: null, labelBase64: null, error: e.message });
      showToast(e.message, "err");
    }
  };

  const reset = () => {
    setCustomerId("");
    setPoNumber("");
    setDate(today());
    setShipping(0);
    setLineItems([]);
    setShippingState({ status: "idle", tracking: null, labelBase64: null, error: null });
    setSavedOrderId(null);
    setInvoiceNumber(formatInvoice(counters.invoice, company));
  };

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">New Order</h1>
          <p className="text-sm text-stone-500 mt-0.5">Create an invoice, packing slip, and FedEx label.</p>
        </div>
        <button
          onClick={reset}
          className="text-sm text-stone-600 hover:text-stone-900 px-3 py-1.5 rounded border border-stone-200 hover:bg-white"
        >
          Clear form
        </button>
      </header>

      {/* --- Header info --- */}
      <Card>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Field label="Invoice #">
            <input
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Date">
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Customer PO #">
            <input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Customer">
            <select
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
              className={inputCls}
            >
              <option value="">— Select customer —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
        </div>
        {customer && (
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <AddressCard label="Bill / Ship to" customer={customer} />
            <div className="text-xs text-stone-500 space-y-1 pt-1">
              <div>Customer ID: <span className="text-stone-700 font-medium">{customer.customerId || customer.id.slice(0, 6)}</span></div>
              {customer.contactName && <div>Contact: <span className="text-stone-700">{customer.contactName}</span></div>}
              {customer.phone && <div>Phone: <span className="text-stone-700">{customer.phone}</span></div>}
              {customer.email && <div>Email: <span className="text-stone-700">{customer.email}</span></div>}
            </div>
          </div>
        )}
      </Card>

      {/* --- Line items --- */}
      <Card>
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-semibold">Line items</h2>
          <button
            onClick={addLine}
            className="text-sm flex items-center gap-1.5 px-3 py-1.5 bg-stone-900 text-white rounded hover:bg-stone-800"
          >
            <Plus className="w-3.5 h-3.5" /> Add item
          </button>
        </div>

        {lineItems.length === 0 ? (
          <div className="border border-dashed border-stone-200 rounded-lg p-8 text-center text-sm text-stone-500">
            No items yet. Click <span className="font-medium">Add item</span> to start.
          </div>
        ) : (
          <div className="space-y-3">
            {lineItems.map((line, idx) => (
              <LineItemRow
                key={line.id}
                index={idx}
                line={line}
                products={products}
                onChange={(patch) => updateLine(line.id, patch)}
                onPick={(pid) => pickProduct(line.id, pid)}
                onRemove={() => removeLine(line.id)}
              />
            ))}
          </div>
        )}

        <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-stone-200 pt-4">
          <div className="flex items-center gap-3">
            <span className="text-sm text-stone-600">S&amp;H:</span>
            <input
              type="number"
              step="0.01"
              value={shipping}
              onChange={(e) => setShipping(e.target.value)}
              className={inputCls + " w-32"}
            />
          </div>
          <div className="text-right">
            <div className="text-sm text-stone-500">Items: {fmtUSD(itemsSubtotal)}</div>
            <div className="text-2xl font-semibold tracking-tight mt-1">
              Total: {fmtUSD(total)}
            </div>
          </div>
        </div>
      </Card>

      {/* --- Shipping params --- */}
      <Card>
        <h2 className="font-semibold mb-3">Shipping parameters</h2>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <Field label="Weight (lb)">
            <input type="number" step="0.1" value={shipWeightLbs} onChange={(e) => setShipWeightLbs(e.target.value)} className={inputCls} />
          </Field>
          <Field label="Length (in)">
            <input type="number" value={shipDims.length} onChange={(e) => setShipDims({ ...shipDims, length: e.target.value })} className={inputCls} />
          </Field>
          <Field label="Width (in)">
            <input type="number" value={shipDims.width} onChange={(e) => setShipDims({ ...shipDims, width: e.target.value })} className={inputCls} />
          </Field>
          <Field label="Height (in)">
            <input type="number" value={shipDims.height} onChange={(e) => setShipDims({ ...shipDims, height: e.target.value })} className={inputCls} />
          </Field>
          <Field label="Service">
            <select value={shipService} onChange={(e) => setShipService(e.target.value)} className={inputCls}>
              <option value="FEDEX_GROUND">FedEx Ground</option>
              <option value="FEDEX_2_DAY">FedEx 2Day</option>
              <option value="STANDARD_OVERNIGHT">Standard Overnight</option>
              <option value="PRIORITY_OVERNIGHT">Priority Overnight</option>
              <option value="FIRST_OVERNIGHT">First Overnight</option>
              <option value="FEDEX_EXPRESS_SAVER">Express Saver</option>
              <option value="INTERNATIONAL_PRIORITY">International Priority</option>
              <option value="INTERNATIONAL_ECONOMY">International Economy</option>
            </select>
          </Field>
          <Field label="Signature">
            <label className="flex items-center gap-2 h-10 px-3 border border-stone-200 rounded text-sm">
              <input type="checkbox" checked={signatureRequired} onChange={(e) => setSignatureRequired(e.target.checked)} />
              Required
            </label>
          </Field>
        </div>

        <div className="mt-5 pt-4 border-t border-stone-200">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-sm font-medium">Live FedEx rates</div>
              <div className="text-xs text-stone-500 mt-0.5">
                Quote based on the customer's address, weight, and dimensions above
                {Number(fedex.markupPercent) > 0 && ` · ${fedex.markupPercent}% markup applied`}
              </div>
            </div>
            <button
              onClick={getRates}
              disabled={ratesStatus === "loading"}
              className="px-3 py-1.5 rounded bg-white border border-stone-300 hover:bg-stone-100 text-sm font-medium flex items-center gap-2 disabled:opacity-50"
            >
              {ratesStatus === "loading" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <DollarSign className="w-3.5 h-3.5" />}
              Get rates
            </button>
          </div>

          {ratesStatus === "err" && (
            <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{ratesError}</span>
            </div>
          )}

          {ratesStatus === "ok" && rates.length > 0 && (
            <div className="border border-stone-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-stone-50 text-xs text-stone-500 uppercase tracking-wider">
                  <tr>
                    <th className="text-left py-2 px-3 font-medium">Service</th>
                    <th className="text-left py-2 px-3 font-medium">Transit</th>
                    <th className="text-right py-2 px-3 font-medium">FedEx cost</th>
                    {Number(fedex.markupPercent) > 0 && (
                      <th className="text-right py-2 px-3 font-medium">Your price</th>
                    )}
                    <th className="py-2 px-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {rates.map((r) => {
                    const yourPrice = markupRate(r.amount);
                    const isSelected =
                      shipService === r.serviceType &&
                      Math.abs(Number(shipping) - yourPrice) < 0.01;
                    return (
                      <tr key={r.serviceType} className={isSelected ? "bg-emerald-50" : ""}>
                        <td className="py-2 px-3 font-medium">{r.serviceName || r.serviceType}</td>
                        <td className="py-2 px-3 text-stone-600">{r.transitTime || "—"}</td>
                        <td className="py-2 px-3 text-right tabular-nums">{fmtUSD(r.amount)}</td>
                        {Number(fedex.markupPercent) > 0 && (
                          <td className="py-2 px-3 text-right tabular-nums font-medium">
                            {fmtUSD(yourPrice)}
                          </td>
                        )}
                        <td className="py-2 px-3 text-right">
                          <button
                            onClick={() => useRate(r)}
                            className={`text-xs px-2.5 py-1 rounded font-medium ${
                              isSelected
                                ? "bg-emerald-600 text-white"
                                : "bg-stone-900 text-white hover:bg-stone-800"
                            }`}
                          >
                            {isSelected ? "Used" : "Use"}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Card>

      {/* --- Actions --- */}
      <Card>
        <div className="flex flex-wrap gap-3 items-center">
          <button
            onClick={saveAndStay}
            className="px-4 py-2 rounded bg-white border border-stone-300 hover:bg-stone-100 text-sm font-medium flex items-center gap-2"
          >
            <Check className="w-4 h-4" />
            Save draft
          </button>
          <button
            onClick={() => handlePrint("invoice")}
            className="px-4 py-2 rounded bg-white border border-stone-300 hover:bg-stone-100 text-sm font-medium flex items-center gap-2"
          >
            <Printer className="w-4 h-4" />
            Invoice (PDF)
          </button>
          <button
            onClick={() => handlePrint("packing")}
            className="px-4 py-2 rounded bg-white border border-stone-300 hover:bg-stone-100 text-sm font-medium flex items-center gap-2"
          >
            <Printer className="w-4 h-4" />
            Packing slip (PDF)
          </button>
          <div className="flex-1" />
          <button
            onClick={handleShip}
            disabled={shipping_state.status === "loading"}
            className="px-5 py-2 rounded bg-stone-900 text-white text-sm font-medium flex items-center gap-2 hover:bg-stone-800 disabled:opacity-50"
          >
            {shipping_state.status === "loading" ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Truck className="w-4 h-4" />
            )}
            Ship via FedEx
          </button>
        </div>

        {shipping_state.status === "ok" && shipping_state.tracking && (
          <div className="mt-4 p-3 bg-emerald-50 border border-emerald-200 rounded flex items-center justify-between">
            <div className="text-sm">
              <div className="font-medium text-emerald-900">Shipped successfully</div>
              <div className="text-emerald-700 mt-0.5">
                Tracking: <span className="font-mono">{shipping_state.tracking}</span>
              </div>
            </div>
            <CopyButton text={shipping_state.tracking} />
          </div>
        )}
        {shipping_state.status === "err" && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <div>
              <div className="font-medium">Shipping failed</div>
              <div className="mt-0.5 break-all">{shipping_state.error}</div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function formatInvoice(n, company) {
  const prefix = (company.name || "INV").slice(0, 3).toUpperCase().replace(/[^A-Z]/g, "X");
  const d = new Date();
  const ym = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${String(d.getFullYear()).slice(2)}`;
  return `${prefix}-${ym}-${String(n).padStart(3, "0")}`;
}

function buildShipFrom(fedex, company) {
  const f = fedex.shipFrom || {};
  return {
    contact: {
      personName: f.contactName || company.signatoryName || company.name,
      companyName: f.companyName || company.name,
      phoneNumber: (f.phone || company.phone || "").replace(/\D/g, ""),
    },
    address: {
      streetLines: [f.line1 || company.addressLine1, f.line2 || company.addressLine2].filter(Boolean),
      city: f.city || company.city,
      stateOrProvinceCode: f.state || company.state,
      postalCode: f.zip || company.zip,
      countryCode: f.country || company.country || "US",
    },
  };
}

function openPdfFromBase64(b64, filename) {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
    // also offer download
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    console.error(e);
  }
}

/* ---------- Line item row ---------- */

function LineItemRow({ index, line, products, onChange, onPick, onRemove }) {
  return (
    <div className="border border-stone-200 rounded-lg bg-stone-50/50 p-3">
      <div className="flex items-start gap-3">
        <div className="text-xs text-stone-400 font-mono pt-2 w-6">{index + 1}.</div>
        <div className="flex-1 grid grid-cols-12 gap-2">
          <div className="col-span-12 md:col-span-3">
            <label className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">Product</label>
            <select
              value={line.productId}
              onChange={(e) => onPick(e.target.value)}
              className={inputCls + " mt-1"}
            >
              <option value="">— Custom —</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="col-span-12 md:col-span-4">
            <label className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">Description</label>
            <input
              value={line.description}
              onChange={(e) => onChange({ description: e.target.value })}
              className={inputCls + " mt-1"}
              placeholder="e.g. Dihexa, 5x10g bottle"
            />
          </div>
          <div className="col-span-6 md:col-span-2">
            <label className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">CAS</label>
            <input
              value={line.casNumber}
              onChange={(e) => onChange({ casNumber: e.target.value })}
              className={inputCls + " mt-1 font-mono text-xs"}
            />
          </div>
          <div className="col-span-6 md:col-span-1">
            <label className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">Unit</label>
            <input
              value={line.unit}
              onChange={(e) => onChange({ unit: e.target.value })}
              className={inputCls + " mt-1"}
            />
          </div>
          <div className="col-span-4 md:col-span-1">
            <label className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">Qty</label>
            <input
              type="number"
              step="0.01"
              value={line.quantity}
              onChange={(e) => onChange({ quantity: e.target.value })}
              className={inputCls + " mt-1"}
            />
          </div>
          <div className="col-span-4 md:col-span-1">
            <label className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">$ / unit</label>
            <input
              type="number"
              step="0.01"
              value={line.unitPriceNum}
              onChange={(e) => onChange({ unitPriceNum: e.target.value, unitPriceDisplay: `$${e.target.value}/${(line.unit || "g").toLowerCase().slice(0, 1)}` })}
              className={inputCls + " mt-1"}
            />
          </div>
          <div className="col-span-12 grid grid-cols-12 gap-2">
            <div className="col-span-12 md:col-span-3">
              <label className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">Batch #</label>
              <input
                value={line.batchNumber}
                onChange={(e) => onChange({ batchNumber: e.target.value })}
                className={inputCls + " mt-1 font-mono text-xs"}
                placeholder="HXDHX251001"
              />
            </div>
            <div className="col-span-6 md:col-span-3">
              <label className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">Pack size (label)</label>
              <input
                value={line.packSize}
                onChange={(e) => onChange({ packSize: e.target.value })}
                className={inputCls + " mt-1"}
                placeholder="50g/bottle"
              />
            </div>
            <div className="col-span-6 md:col-span-2">
              <label className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">Pack count</label>
              <input
                type="number"
                value={line.packCount}
                onChange={(e) => onChange({ packCount: e.target.value })}
                className={inputCls + " mt-1"}
              />
            </div>
            <div className="col-span-12 md:col-span-3">
              <label className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">Display $/unit</label>
              <input
                value={line.unitPriceDisplay}
                onChange={(e) => onChange({ unitPriceDisplay: e.target.value })}
                className={inputCls + " mt-1"}
                placeholder="$95/g"
              />
            </div>
            <div className="col-span-12 md:col-span-1 flex flex-col">
              <label className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">Amount</label>
              <div className="mt-1 h-10 flex items-center font-medium tabular-nums">
                {fmtUSD(line.amount)}
              </div>
            </div>
          </div>
        </div>
        <button
          onClick={onRemove}
          className="text-stone-400 hover:text-red-600 p-1.5 rounded hover:bg-red-50 mt-5"
          title="Remove line"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

/* =========================================================================
   Customers
   ========================================================================= */

function CustomersView({ customers, onSave, onDelete, fedex }) {
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter(
      (c) =>
        c.name?.toLowerCase().includes(q) ||
        c.contactName?.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.city?.toLowerCase().includes(q)
    );
  }, [customers, search]);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="text-sm text-stone-500 mt-0.5">{customers.length} record{customers.length === 1 ? "" : "s"}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => exportCustomersCSV(customers)}
            disabled={customers.length === 0}
            className="px-3 py-2 border border-stone-300 text-sm rounded hover:bg-stone-50 flex items-center gap-1.5 disabled:opacity-40"
          >
            <Download className="w-4 h-4" /> Export CSV
          </button>
          <button
            onClick={() => setEditing({})}
            className="px-3 py-2 bg-stone-900 text-white text-sm rounded hover:bg-stone-800 flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> New customer
          </button>
        </div>
      </header>

      <Card>
        <div className="relative mb-3">
          <Search className="w-4 h-4 absolute left-3 top-3 text-stone-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customers…"
            className={inputCls + " pl-9"}
          />
        </div>

        {filtered.length === 0 ? (
          <Empty msg={customers.length === 0 ? "No customers yet — add one to get started." : "No matches."} />
        ) : (
          <div className="divide-y divide-stone-200">
            {filtered.map((c) => (
              <div key={c.id} className="py-3 flex items-start gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{c.name}</span>
                    {c.customerId && <span className="text-xs text-stone-500 font-mono">#{c.customerId}</span>}
                  </div>
                  <div className="text-sm text-stone-600 mt-0.5">
                    {[c.contactName, c.addressLine1, [c.city, c.state, c.zip].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}
                  </div>
                  <div className="text-xs text-stone-500 mt-0.5">
                    {[c.phone, c.email].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <IconButton onClick={() => setEditing(c)} icon={Pencil} title="Edit" />
                  <IconButton onClick={() => { if (confirm(`Delete ${c.name}?`)) onDelete(c.id); }} icon={Trash2} title="Delete" danger />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {editing && (
        <Modal onClose={() => setEditing(null)} title={editing.id ? "Edit customer" : "New customer"}>
          <CustomerForm
            initial={editing}
            onCancel={() => setEditing(null)}
            onSave={async (rec) => { await onSave(rec); setEditing(null); }}
            fedex={fedex}
          />
        </Modal>
      )}
    </div>
  );
}

function CustomerForm({ initial, onSave, onCancel, fedex }) {
  const [c, setC] = useState({
    customerId: "",
    name: "",
    contactName: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    zip: "",
    country: "US",
    phone: "",
    email: "",
    residential: false,
    notes: "",
    ...initial,
  });
  const [validation, setValidation] = useState({ status: "idle", result: null, error: null });

  const set = (patch) => {
    setC({ ...c, ...patch });
    // Any address change invalidates the prior validation result
    if (
      "addressLine1" in patch || "addressLine2" in patch ||
      "city" in patch || "state" in patch || "zip" in patch || "country" in patch
    ) {
      if (validation.status !== "idle") setValidation({ status: "idle", result: null, error: null });
    }
  };

  const submit = () => {
    if (!c.name?.trim()) return;
    onSave(c);
  };

  const validate = async () => {
    if (!fedex?.workerUrl) {
      setValidation({ status: "err", result: null, error: "Set the FedEx Worker URL in Settings first." });
      return;
    }
    if (!c.addressLine1?.trim()) {
      setValidation({ status: "err", result: null, error: "Address Line 1 is required." });
      return;
    }
    setValidation({ status: "loading", result: null, error: null });
    try {
      const res = await fetch(fedex.workerUrl.replace(/\/+$/, "") + "/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-app-auth": fedex.appAuthToken || "" },
        body: JSON.stringify({
          address: {
            streetLines: [c.addressLine1, c.addressLine2].filter(Boolean),
            city: c.city,
            stateOrProvinceCode: c.state,
            postalCode: c.zip,
            countryCode: c.country || "US",
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Validation request failed");
      setValidation({ status: "ok", result: data, error: null });
    } catch (e) {
      setValidation({ status: "err", result: null, error: e.message });
    }
  };

  const applyStandardized = () => {
    const s = validation.result?.standardized;
    if (!s) return;
    const patch = {
      addressLine1: s.streetLines[0] || c.addressLine1,
      addressLine2: s.streetLines[1] || "",
      city: s.city || c.city,
      state: s.stateOrProvinceCode || c.state,
      zip: s.postalCode || c.zip,
      country: s.countryCode || c.country,
    };
    // Also apply residential classification if FedEx is confident
    if (validation.result?.classification === "RESIDENTIAL") patch.residential = true;
    if (validation.result?.classification === "BUSINESS") patch.residential = false;
    setC({ ...c, ...patch });
    setValidation({ status: "applied", result: validation.result, error: null });
  };

  const r = validation.result;
  const standardizedDiffers =
    r?.standardized &&
    (
      (r.standardized.streetLines[0] || "").toUpperCase() !== (c.addressLine1 || "").toUpperCase() ||
      (r.standardized.streetLines[1] || "").toUpperCase() !== (c.addressLine2 || "").toUpperCase() ||
      (r.standardized.city || "").toUpperCase() !== (c.city || "").toUpperCase() ||
      (r.standardized.stateOrProvinceCode || "").toUpperCase() !== (c.state || "").toUpperCase() ||
      (r.standardized.postalCode || "") !== (c.zip || "")
    );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Company name *">
          <input value={c.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} autoFocus />
        </Field>
        <Field label="Customer ID">
          <input value={c.customerId} onChange={(e) => set({ customerId: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Contact name">
          <input value={c.contactName} onChange={(e) => set({ contactName: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Phone">
          <input value={c.phone} onChange={(e) => set({ phone: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Email" wide>
          <input value={c.email} onChange={(e) => set({ email: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Address line 1" wide>
          <input value={c.addressLine1} onChange={(e) => set({ addressLine1: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Address line 2" wide>
          <input value={c.addressLine2} onChange={(e) => set({ addressLine2: e.target.value })} className={inputCls} />
        </Field>
        <Field label="City">
          <input value={c.city} onChange={(e) => set({ city: e.target.value })} className={inputCls} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="State">
            <input value={c.state} onChange={(e) => set({ state: e.target.value })} className={inputCls} />
          </Field>
          <Field label="ZIP">
            <input value={c.zip} onChange={(e) => set({ zip: e.target.value })} className={inputCls} />
          </Field>
        </div>
        <Field label="Country">
          <input value={c.country} onChange={(e) => set({ country: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Residential">
          <label className="flex items-center gap-2 h-10 px-3 border border-stone-200 rounded text-sm">
            <input type="checkbox" checked={!!c.residential} onChange={(e) => set({ residential: e.target.checked })} />
            Residential delivery
          </label>
        </Field>
      </div>

      {/* --- Address validation panel --- */}
      <div className="pt-3 border-t border-stone-200">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs uppercase tracking-wider text-stone-500 font-medium">Address validation</div>
          <button
            onClick={validate}
            disabled={validation.status === "loading"}
            className="px-3 py-1.5 text-sm rounded border border-stone-300 hover:bg-stone-50 flex items-center gap-1.5 disabled:opacity-50"
          >
            {validation.status === "loading" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MapPin className="w-3.5 h-3.5" />}
            Validate with FedEx
          </button>
        </div>

        {validation.status === "err" && (
          <div className="p-2.5 bg-red-50 border border-red-200 rounded text-sm text-red-700 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{validation.error}</span>
          </div>
        )}

        {(validation.status === "ok" || validation.status === "applied") && r && (
          <div className={`p-3 border rounded text-sm ${r.ok ? "bg-emerald-50 border-emerald-200" : "bg-amber-50 border-amber-200"}`}>
            <div className="flex items-center gap-2 font-medium mb-1.5">
              {r.ok ? <Check className="w-4 h-4 text-emerald-700" /> : <AlertCircle className="w-4 h-4 text-amber-700" />}
              <span className={r.ok ? "text-emerald-900" : "text-amber-900"}>
                {r.ok ? "FedEx recognizes this address" : "FedEx couldn't fully verify this address"}
              </span>
              <span className="ml-auto text-xs font-normal text-stone-600">
                Classification: <span className="font-medium">{r.classification}</span>
              </span>
            </div>

            {r.standardized && (
              <div className="text-xs text-stone-700 leading-relaxed mb-2">
                <div className="font-medium text-stone-800">FedEx-standardized version:</div>
                <div>{r.standardized.streetLines.join(", ")}</div>
                <div>
                  {[r.standardized.city, r.standardized.stateOrProvinceCode, r.standardized.postalCode].filter(Boolean).join(", ")}
                  {r.standardized.countryCode ? ` ${r.standardized.countryCode}` : ""}
                </div>
              </div>
            )}

            {validation.status === "ok" && standardizedDiffers && (
              <button
                onClick={applyStandardized}
                className="text-xs px-2.5 py-1 rounded bg-stone-900 text-white hover:bg-stone-800"
              >
                Apply FedEx-standardized version
              </button>
            )}
            {validation.status === "applied" && (
              <div className="text-xs text-emerald-700">✓ Standardized version applied to the form above.</div>
            )}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-2 border-t border-stone-200">
        <button onClick={onCancel} className="px-3 py-1.5 text-sm rounded border border-stone-300 hover:bg-stone-50">Cancel</button>
        <button onClick={submit} className="px-3 py-1.5 text-sm rounded bg-stone-900 text-white hover:bg-stone-800">Save</button>
      </div>
    </div>
  );
}

/* =========================================================================
   Products / Catalog
   ========================================================================= */

function ProductsView({ products, onSave, onDelete }) {
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) => p.name?.toLowerCase().includes(q) || p.casNumber?.toLowerCase().includes(q)
    );
  }, [products, search]);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Catalog</h1>
          <p className="text-sm text-stone-500 mt-0.5">{products.length} APIs</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => exportProductsCSV(products)}
            disabled={products.length === 0}
            className="px-3 py-2 border border-stone-300 text-sm rounded hover:bg-stone-50 flex items-center gap-1.5 disabled:opacity-40"
          >
            <Download className="w-4 h-4" /> Export CSV
          </button>
          <button
            onClick={() => setEditing({})}
            className="px-3 py-2 bg-stone-900 text-white text-sm rounded hover:bg-stone-800 flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" /> New product
          </button>
        </div>
      </header>

      <Card>
        <div className="relative mb-3">
          <Search className="w-4 h-4 absolute left-3 top-3 text-stone-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or CAS…"
            className={inputCls + " pl-9"}
          />
        </div>

        {filtered.length === 0 ? (
          <Empty msg={products.length === 0 ? "No products yet — add your first API." : "No matches."} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-stone-500 uppercase tracking-wider border-b border-stone-200">
                <tr>
                  <th className="py-2 pr-4 font-medium">Name</th>
                  <th className="py-2 pr-4 font-medium">CAS</th>
                  <th className="py-2 pr-4 font-medium">Default unit</th>
                  <th className="py-2 pr-4 font-medium">Default price</th>
                  <th className="py-2 pr-4 font-medium">Pack size</th>
                  <th className="py-2 pr-4 font-medium">Batch</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {filtered.map((p) => (
                  <tr key={p.id}>
                    <td className="py-2.5 pr-4 font-medium">{p.name}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs">{p.casNumber}</td>
                    <td className="py-2.5 pr-4">{p.defaultUnit}</td>
                    <td className="py-2.5 pr-4 tabular-nums">{p.defaultPrice ? `$${p.defaultPrice}` : ""}</td>
                    <td className="py-2.5 pr-4">{p.defaultPackSize}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-stone-500">{p.batchNumber}</td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      <IconButton onClick={() => setEditing(p)} icon={Pencil} title="Edit" />
                      <IconButton onClick={() => { if (confirm(`Delete ${p.name}?`)) onDelete(p.id); }} icon={Trash2} title="Delete" danger />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <Modal onClose={() => setEditing(null)} title={editing.id ? "Edit product" : "New product"}>
          <ProductForm
            initial={editing}
            onCancel={() => setEditing(null)}
            onSave={async (rec) => { await onSave(rec); setEditing(null); }}
          />
        </Modal>
      )}
    </div>
  );
}

function ProductForm({ initial, onSave, onCancel }) {
  const [p, setP] = useState({
    name: "",
    casNumber: "",
    defaultUnit: "Gram",
    defaultPrice: "",
    defaultPackSize: "",
    defaultDescription: "",
    batchNumber: "",
    notes: "",
    ...initial,
  });
  const set = (patch) => setP({ ...p, ...patch });
  const submit = () => {
    if (!p.name?.trim()) return;
    onSave(p);
  };
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name *">
          <input value={p.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} autoFocus />
        </Field>
        <Field label="CAS Number">
          <input value={p.casNumber} onChange={(e) => set({ casNumber: e.target.value })} className={inputCls + " font-mono"} />
        </Field>
        <Field label="Default unit">
          <input value={p.defaultUnit} onChange={(e) => set({ defaultUnit: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Default price ($/unit)">
          <input type="number" step="0.01" value={p.defaultPrice} onChange={(e) => set({ defaultPrice: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Default pack size">
          <input value={p.defaultPackSize} onChange={(e) => set({ defaultPackSize: e.target.value })} className={inputCls} placeholder="10g/bottle" />
        </Field>
        <Field label="Current batch #">
          <input value={p.batchNumber} onChange={(e) => set({ batchNumber: e.target.value })} className={inputCls + " font-mono"} placeholder="HXDHX251001" />
        </Field>
        <Field label="Default invoice description" wide>
          <input value={p.defaultDescription} onChange={(e) => set({ defaultDescription: e.target.value })} className={inputCls} placeholder="Auto from name + pack size if blank" />
        </Field>
      </div>
      <div className="flex justify-end gap-2 pt-2 border-t border-stone-200">
        <button onClick={onCancel} className="px-3 py-1.5 text-sm rounded border border-stone-300 hover:bg-stone-50">Cancel</button>
        <button onClick={submit} className="px-3 py-1.5 text-sm rounded bg-stone-900 text-white hover:bg-stone-800">Save</button>
      </div>
    </div>
  );
}

/* =========================================================================
   History
   ========================================================================= */

function HistoryView({ orders, onPrint, onDelete }) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter(
      (o) =>
        o.invoiceNumber?.toLowerCase().includes(q) ||
        o.customerSnapshot?.name?.toLowerCase().includes(q) ||
        o.tracking?.toLowerCase().includes(q)
    );
  }, [orders, search]);

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
          <p className="text-sm text-stone-500 mt-0.5">{orders.length} order{orders.length === 1 ? "" : "s"}</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => exportOrdersSummaryCSV(orders)}
            disabled={orders.length === 0}
            className="px-3 py-2 border border-stone-300 text-sm rounded hover:bg-stone-50 flex items-center gap-1.5 disabled:opacity-40"
          >
            <Download className="w-4 h-4" /> Orders CSV
          </button>
          <button
            onClick={() => exportOrdersLineItemsCSV(orders)}
            disabled={orders.length === 0}
            className="px-3 py-2 border border-stone-300 text-sm rounded hover:bg-stone-50 flex items-center gap-1.5 disabled:opacity-40"
            title="One row per line item — useful for accounting/inventory"
          >
            <Download className="w-4 h-4" /> Line items CSV
          </button>
        </div>
      </header>

      <Card>
        <div className="relative mb-3">
          <Search className="w-4 h-4 absolute left-3 top-3 text-stone-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by invoice #, customer, or tracking…"
            className={inputCls + " pl-9"}
          />
        </div>

        {filtered.length === 0 ? (
          <Empty msg={orders.length === 0 ? "No orders yet." : "No matches."} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-stone-500 uppercase tracking-wider border-b border-stone-200">
                <tr>
                  <th className="py-2 pr-4 font-medium">Invoice #</th>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Customer</th>
                  <th className="py-2 pr-4 font-medium text-right">Total</th>
                  <th className="py-2 pr-4 font-medium">Tracking</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {filtered.map((o) => (
                  <tr key={o.id}>
                    <td className="py-2.5 pr-4 font-medium">{o.invoiceNumber}</td>
                    <td className="py-2.5 pr-4 text-stone-600">{niceDate(o.date)}</td>
                    <td className="py-2.5 pr-4">{o.customerSnapshot?.name}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{fmtUSD(o.total)}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs">
                      {o.tracking ? (
                        <a
                          href={`https://www.fedex.com/fedextrack/?trknbr=${o.tracking}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-700 hover:underline"
                        >
                          {o.tracking}
                        </a>
                      ) : (
                        <span className="text-stone-400">—</span>
                      )}
                    </td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      <IconButton onClick={() => onPrint(o, "invoice")} icon={FileText} title="Invoice" />
                      <IconButton onClick={() => onPrint(o, "packing")} icon={Package} title="Packing slip" />
                      <IconButton onClick={() => { if (confirm(`Delete order ${o.invoiceNumber}?`)) onDelete(o.id); }} icon={Trash2} title="Delete" danger />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/* =========================================================================
   Settings
   ========================================================================= */

function DataSyncCard() {
  const cur = readBackendCfg() || { url: "", token: "" };
  const [url, setUrl] = useState(cur.url);
  const [token, setToken] = useState(cur.token);

  const save = () => {
    writeBackendCfg({ url: url.trim(), token: token.trim() });
    location.reload();
  };
  const disable = () => {
    if (!confirm("Stop syncing? Data will fall back to local browser storage. Existing backend data is not deleted.")) return;
    writeBackendCfg(null);
    location.reload();
  };

  const modeLabel = {
    backend: { text: "Synced to backend", desc: "Customers, products, and orders sync across all devices and team members.", color: "bg-emerald-50 border-emerald-200 text-emerald-900" },
    local: { text: "Stored in this browser only", desc: "Data is local to this browser and won't appear on other devices. Configure a backend below to enable sync.", color: "bg-amber-50 border-amber-200 text-amber-900" },
  }[store.mode];

  return (
    <Card>
      <h2 className="font-semibold mb-1">Data sync</h2>
      <div className={`mt-3 mb-4 p-3 border rounded text-sm ${modeLabel.color}`}>
        <div className="font-medium">{modeLabel.text}</div>
        <div className="text-xs mt-1 opacity-90">{modeLabel.desc}</div>
      </div>

      <div className="grid grid-cols-1 gap-3">
        <Field label="Data Worker URL">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://shipping-data.your-subdomain.workers.dev"
            className={inputCls}
          />
        </Field>
        <Field label="App auth token">
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="The APP_AUTH_TOKEN you set on the data Worker"
            className={inputCls + " font-mono"}
            type="password"
          />
        </Field>
      </div>

      <div className="flex justify-between items-center mt-4 pt-4 border-t border-stone-200">
        <div className="text-xs text-stone-500">
          Saving will reload the page to apply the new mode.
        </div>
        <div className="flex gap-2">
          {store.mode === "backend" && (
            <button onClick={disable} className="px-3 py-1.5 text-sm rounded border border-stone-300 hover:bg-stone-50">
              Disable sync
            </button>
          )}
          <button
            onClick={save}
            disabled={!url.trim()}
            className="px-4 py-2 bg-stone-900 text-white rounded text-sm hover:bg-stone-800 disabled:opacity-50"
          >
            Save and reload
          </button>
        </div>
      </div>
    </Card>
  );
}

function SettingsView({ company, fedex, counters, onSaveCompany, onSaveFedex, onSaveCounters }) {
  const [c, setC] = useState(company);
  const [f, setF] = useState(fedex);
  const [ct, setCt] = useState(counters);

  useEffect(() => setC(company), [company]);
  useEffect(() => setF(fedex), [fedex]);
  useEffect(() => setCt(counters), [counters]);

  const setCField = (patch) => setC({ ...c, ...patch });
  const setFField = (patch) => setF({ ...f, ...patch });
  const setShipFromField = (patch) => setF({ ...f, shipFrom: { ...(f.shipFrom || {}), ...patch } });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      </header>

      <DataSyncCard />

      <Card>
        <h2 className="font-semibold mb-4">Company info <span className="text-xs text-stone-500 font-normal">— shows on invoices and packing slips</span></h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Company name"><input value={c.name} onChange={(e) => setCField({ name: e.target.value })} className={inputCls} /></Field>
          <Field label="Website"><input value={c.website} onChange={(e) => setCField({ website: e.target.value })} className={inputCls} /></Field>
          <Field label="Email"><input value={c.email} onChange={(e) => setCField({ email: e.target.value })} className={inputCls} /></Field>
          <Field label="Phone"><input value={c.phone} onChange={(e) => setCField({ phone: e.target.value })} className={inputCls} /></Field>
          <Field label="Fax"><input value={c.fax} onChange={(e) => setCField({ fax: e.target.value })} className={inputCls} /></Field>
          <Field label="Signatory name"><input value={c.signatoryName} onChange={(e) => setCField({ signatoryName: e.target.value })} className={inputCls} /></Field>
          <ImageUploadField
            label="Company logo"
            value={c.logoDataUrl}
            onChange={(v) => setCField({ logoDataUrl: v })}
            previewClass="h-14 max-w-[220px]"
            help="Shown at the top of invoices and packing slips · PNG/SVG · max 800 KB"
          />
          <ImageUploadField
            label="Signature image"
            value={c.signatureDataUrl}
            onChange={(v) => setCField({ signatureDataUrl: v })}
            previewClass="h-14 max-w-[200px]"
            help="Shown above the signatory name · transparent PNG strongly recommended · max 800 KB"
          />
          <ImageUploadField
            label="Corporate seal"
            value={c.sealDataUrl}
            onChange={(v) => setCField({ sealDataUrl: v })}
            previewClass="h-20 w-20"
            help="Stamps next to the signature · transparent PNG of the round seal · max 800 KB"
          />
          <Field label="Address line 1" wide><input value={c.addressLine1} onChange={(e) => setCField({ addressLine1: e.target.value })} className={inputCls} /></Field>
          <Field label="Address line 2" wide><input value={c.addressLine2} onChange={(e) => setCField({ addressLine2: e.target.value })} className={inputCls} /></Field>
          <Field label="City"><input value={c.city} onChange={(e) => setCField({ city: e.target.value })} className={inputCls} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="State"><input value={c.state} onChange={(e) => setCField({ state: e.target.value })} className={inputCls} /></Field>
            <Field label="ZIP"><input value={c.zip} onChange={(e) => setCField({ zip: e.target.value })} className={inputCls} /></Field>
          </div>
        </div>
        <h3 className="font-medium mt-5 mb-2 text-sm">Banking (for invoice footer)</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bank name"><input value={c.bankName} onChange={(e) => setCField({ bankName: e.target.value })} className={inputCls} /></Field>
          <Field label="Bank routing #"><input value={c.bankRouting} onChange={(e) => setCField({ bankRouting: e.target.value })} className={inputCls} /></Field>
          <Field label="Bank account #"><input value={c.bankAccount} onChange={(e) => setCField({ bankAccount: e.target.value })} className={inputCls} /></Field>
          <Field label="Bank address"><input value={c.bankAddress} onChange={(e) => setCField({ bankAddress: e.target.value })} className={inputCls} /></Field>
        </div>
        <div className="flex justify-end mt-4 pt-4 border-t border-stone-200">
          <button onClick={() => onSaveCompany(c)} className="px-4 py-2 bg-stone-900 text-white rounded text-sm hover:bg-stone-800">
            Save company info
          </button>
        </div>
      </Card>

      <Card>
        <h2 className="font-semibold mb-1">FedEx integration</h2>
        <p className="text-xs text-stone-500 mb-4">
          Point this to your deployed Cloudflare Worker. The Worker holds your FedEx API credentials —
          this app never sees them.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Worker URL" wide>
            <input value={f.workerUrl} onChange={(e) => setFField({ workerUrl: e.target.value })} className={inputCls} placeholder="https://fedex-worker.yourdomain.workers.dev" />
          </Field>
          <Field label="App auth token" wide>
            <input value={f.appAuthToken} onChange={(e) => setFField({ appAuthToken: e.target.value })} className={inputCls + " font-mono"} placeholder="The APP_AUTH_TOKEN you set on the Worker" />
          </Field>
          <Field label="Default service">
            <select value={f.defaultService} onChange={(e) => setFField({ defaultService: e.target.value })} className={inputCls}>
              <option value="FEDEX_GROUND">FedEx Ground</option>
              <option value="FEDEX_2_DAY">FedEx 2Day</option>
              <option value="STANDARD_OVERNIGHT">Standard Overnight</option>
              <option value="PRIORITY_OVERNIGHT">Priority Overnight</option>
            </select>
          </Field>
          <Field label="Default packaging">
            <select value={f.defaultPackaging} onChange={(e) => setFField({ defaultPackaging: e.target.value })} className={inputCls}>
              <option value="YOUR_PACKAGING">Your packaging</option>
              <option value="FEDEX_PAK">FedEx Pak</option>
              <option value="FEDEX_BOX">FedEx Box</option>
              <option value="FEDEX_TUBE">FedEx Tube</option>
              <option value="FEDEX_ENVELOPE">FedEx Envelope</option>
            </select>
          </Field>
          <Field label="S&H markup (%)">
            <input
              type="number"
              step="0.1"
              value={f.markupPercent ?? 0}
              onChange={(e) => setFField({ markupPercent: e.target.value })}
              className={inputCls}
              placeholder="0"
            />
          </Field>
          <div />
        </div>

        <h3 className="font-medium mt-5 mb-2 text-sm">Ship-from address <span className="text-xs text-stone-500 font-normal">(leave blank to use Company info above)</span></h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contact name"><input value={f.shipFrom?.contactName || ""} onChange={(e) => setShipFromField({ contactName: e.target.value })} className={inputCls} /></Field>
          <Field label="Phone"><input value={f.shipFrom?.phone || ""} onChange={(e) => setShipFromField({ phone: e.target.value })} className={inputCls} /></Field>
          <Field label="Address line 1" wide><input value={f.shipFrom?.line1 || ""} onChange={(e) => setShipFromField({ line1: e.target.value })} className={inputCls} /></Field>
          <Field label="Address line 2" wide><input value={f.shipFrom?.line2 || ""} onChange={(e) => setShipFromField({ line2: e.target.value })} className={inputCls} /></Field>
          <Field label="City"><input value={f.shipFrom?.city || ""} onChange={(e) => setShipFromField({ city: e.target.value })} className={inputCls} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="State"><input value={f.shipFrom?.state || ""} onChange={(e) => setShipFromField({ state: e.target.value })} className={inputCls} /></Field>
            <Field label="ZIP"><input value={f.shipFrom?.zip || ""} onChange={(e) => setShipFromField({ zip: e.target.value })} className={inputCls} /></Field>
          </div>
        </div>

        <div className="flex justify-end mt-4 pt-4 border-t border-stone-200">
          <button onClick={() => onSaveFedex(f)} className="px-4 py-2 bg-stone-900 text-white rounded text-sm hover:bg-stone-800">
            Save FedEx config
          </button>
        </div>
      </Card>

      <Card>
        <h2 className="font-semibold mb-3">Counters</h2>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Next invoice #">
            <input type="number" value={ct.invoice} onChange={(e) => setCt({ ...ct, invoice: parseInt(e.target.value) || 1 })} className={inputCls} />
          </Field>
          <Field label="Next order #">
            <input type="number" value={ct.order} onChange={(e) => setCt({ ...ct, order: parseInt(e.target.value) || 1 })} className={inputCls} />
          </Field>
        </div>
        <div className="flex justify-end mt-4 pt-4 border-t border-stone-200">
          <button onClick={() => onSaveCounters(ct)} className="px-4 py-2 bg-stone-900 text-white rounded text-sm hover:bg-stone-800">
            Save counters
          </button>
        </div>
      </Card>
    </div>
  );
}

/* =========================================================================
   Print View — Invoice / Packing Slip
   ========================================================================= */

function PrintView({ order, mode, company, onClose, switchMode }) {
  const printRef = useRef(null);

  // Set browser tab title — also becomes the default PDF filename when printing
  useEffect(() => {
    const prev = document.title;
    const customer = order.customerSnapshot?.name || "Customer";
    const datePart = formatTitleDate(order.date);
    const productPart = formatProductNames(order.lineItems);

    const companyPrefix = (company.name || "").trim();
    const prefix = mode === "invoice"
      ? (companyPrefix ? `${companyPrefix} Invoice` : "Invoice")
      : "Packing Slip";

    document.title = [prefix, "to", customer, datePart, productPart]
      .filter(Boolean)
      .join(" ");
    return () => { document.title = prev; };
  }, [order, mode, company.name]);

  const doPrint = () => {
    window.print();
  };

  return (
    <div className="min-h-screen bg-stone-200 print:bg-white">
      {/* toolbar - hidden on print */}
      <div className="bg-white border-b border-stone-200 sticky top-0 z-10 print:hidden">
        <div className="max-w-[900px] mx-auto px-6 py-3 flex items-center gap-3">
          <button onClick={onClose} className="text-sm text-stone-600 hover:text-stone-900 flex items-center gap-1">
            <X className="w-4 h-4" /> Close
          </button>
          <div className="flex-1" />
          <div className="flex items-center bg-stone-100 rounded p-0.5">
            <button
              onClick={() => switchMode("invoice")}
              className={`px-3 py-1 text-sm rounded ${mode === "invoice" ? "bg-white shadow-sm" : "text-stone-600"}`}
            >
              Invoice
            </button>
            <button
              onClick={() => switchMode("packing")}
              className={`px-3 py-1 text-sm rounded ${mode === "packing" ? "bg-white shadow-sm" : "text-stone-600"}`}
            >
              Packing slip
            </button>
          </div>
          <button
            onClick={doPrint}
            className="px-4 py-1.5 bg-stone-900 text-white rounded text-sm flex items-center gap-2 hover:bg-stone-800"
          >
            <Printer className="w-4 h-4" />
            Print / Save as PDF
          </button>
        </div>
      </div>

      <div className="py-8 print:py-0">
        <div ref={printRef} className="print-area max-w-[816px] mx-auto bg-white shadow-md print:shadow-none print:max-w-none">
          {mode === "invoice" ? (
            <InvoiceDoc order={order} company={company} />
          ) : (
            <PackingDoc order={order} company={company} />
          )}
        </div>
      </div>

      <style>{`
        @media print {
          @page { size: letter; margin: 0.5in; }
          body { background: white !important; }
          .print\\:hidden { display: none !important; }
          .print-area { box-shadow: none !important; max-width: none !important; }
        }
      `}</style>
    </div>
  );
}

function InvoiceDoc({ order, company }) {
  const c = order.customerSnapshot || {};
  return (
    <div className="p-12 text-[11pt]" style={{ fontFamily: "'Inter Tight', ui-sans-serif, system-ui, sans-serif" }}>
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="w-[260px] flex-shrink-0">
          {company.logoDataUrl && (
            <img src={company.logoDataUrl} alt={company.name} className="h-24 max-w-[260px] object-contain object-left" />
          )}
        </div>
        <div className="text-2xl font-semibold tracking-wide pt-6 whitespace-nowrap">PRO FORMA INVOICE</div>
        <div className="w-[260px] flex-shrink-0" />
      </div>

      <div className="grid grid-cols-2 gap-8 text-[10pt] mb-6">
        <div>
          <div className="font-semibold text-base mb-1">{company.name}</div>
          {company.fax && <div>Fax: {company.fax}</div>}
          {company.website && <div>{company.website}</div>}
          {company.email && <div>Email: {company.email}</div>}
        </div>
        <div className="text-right">
          <table className="ml-auto">
            <tbody>
              <tr><td className="text-stone-500 pr-3">Date:</td><td className="font-medium">{niceDate(order.date)}</td></tr>
              <tr><td className="text-stone-500 pr-3">Invoice #</td><td className="font-mono">{order.invoiceNumber}</td></tr>
              <tr><td className="text-stone-500 pr-3">Customer ID</td><td>{c.customerId || (c.id || "").slice(0, 6)}</td></tr>
              {order.poNumber && <tr><td className="text-stone-500 pr-3">Customer PO #</td><td>{order.poNumber}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-8 text-[10pt] mb-6">
        <PartyBlock label="Bill To" customer={c} />
        <PartyBlock label="Ship To" customer={c} />
      </div>

      <table className="w-full text-[10pt] border-collapse">
        <thead>
          <tr className="border-y-2 border-stone-800">
            <th className="text-left py-2 pr-2 font-semibold">Product Description</th>
            <th className="text-left py-2 px-2 font-semibold">CAS</th>
            <th className="text-left py-2 px-2 font-semibold">Unit</th>
            <th className="text-right py-2 px-2 font-semibold">Quantity</th>
            <th className="text-right py-2 px-2 font-semibold">Unit Price (USD)</th>
            <th className="text-right py-2 pl-2 font-semibold">Amount (USD)</th>
          </tr>
        </thead>
        <tbody>
          {order.lineItems.map((it) => (
            <tr key={it.id} className="border-b border-stone-200">
              <td className="py-2 pr-2">{it.description}</td>
              <td className="py-2 px-2 font-mono text-[9pt]">{it.casNumber}</td>
              <td className="py-2 px-2">{it.unit}</td>
              <td className="py-2 px-2 text-right tabular-nums">{it.quantity}{(it.unit || "g").toLowerCase().slice(0,1)}</td>
              <td className="py-2 px-2 text-right">{it.unitPriceDisplay || `$${it.unitPriceNum}/g`}</td>
              <td className="py-2 pl-2 text-right tabular-nums">{Number(it.amount).toFixed(2)}</td>
            </tr>
          ))}
          <tr className="border-b border-stone-200">
            <td colSpan="5" className="py-2 pr-2 text-right text-stone-600">S&amp;H</td>
            <td className="py-2 pl-2 text-right tabular-nums">{Number(order.shipping || 0).toFixed(2)}</td>
          </tr>
          <tr className="border-b-2 border-stone-800">
            <td colSpan="5" className="py-2 pr-2 text-right font-semibold">Total</td>
            <td className="py-2 pl-2 text-right font-semibold tabular-nums">{Number(order.total).toFixed(2)}</td>
          </tr>
        </tbody>
      </table>

      <div className="mt-10 flex items-start justify-between gap-8">
        <div className="text-[9.5pt] text-stone-700 flex-1 min-w-0">
          <div className="font-semibold mb-1.5">ELECTRONIC FUNDS TRANSFER</div>
          <div>{company.name}</div>
          {company.bankName && <div>Bank Name: {company.bankName}</div>}
          {company.bankAccount && <div>Account #: {company.bankAccount}</div>}
          {company.bankAddress && <div>Bank Address: {company.bankAddress}</div>}
          {company.bankRouting && <div>Domestic Wiring routing number: {company.bankRouting}</div>}
          {(company.addressLine1 || company.city) && (
            <div>Company address: {[company.addressLine1, company.addressLine2, company.city, company.state, company.zip].filter(Boolean).join(", ")}</div>
          )}
        </div>
        {(company.signatureDataUrl || company.sealDataUrl) && (
          <div className="flex items-center gap-3 shrink-0 pt-4">
            {company.signatureDataUrl && (
              <img
                src={company.signatureDataUrl}
                alt="Signature"
                className="h-16 max-w-[180px] object-contain"
              />
            )}
            {company.sealDataUrl && (
              <img
                src={company.sealDataUrl}
                alt="Corporate seal"
                className="h-24 w-24 object-contain"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PartyBlock({ label, customer }) {
  return (
    <div>
      <div className="font-bold text-[12pt] mb-1.5">{label}:</div>
      <div>{customer.name}</div>
      {customer.addressLine1 && <div>{customer.addressLine1}</div>}
      {customer.addressLine2 && <div>{customer.addressLine2}</div>}
      <div>{[customer.city, customer.state, customer.zip].filter(Boolean).join(", ")}</div>
      {customer.contactName && <div className="mt-1">Contact: {customer.contactName}</div>}
      {customer.phone && <div>P: {customer.phone}</div>}
      {customer.email && <div>E: {customer.email}</div>}
    </div>
  );
}

function PackingDoc({ order, company }) {
  const c = order.customerSnapshot || {};
  const totalGrams = order.lineItems.reduce((s, x) => s + (Number(x.quantity) || 0) * (Number(x.packCount) || 1), 0);

  return (
    <div className="p-12 text-[11pt]" style={{ fontFamily: "'Inter Tight', ui-sans-serif, system-ui, sans-serif" }}>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          {company.logoDataUrl && (
            <img src={company.logoDataUrl} alt={company.name} className="h-24 max-w-[300px] object-contain object-left" />
          )}
        </div>
        <div className="text-right text-[9pt] text-stone-500">RLD/Comparator, CTM</div>
      </div>
      <div className="text-2xl font-bold mb-6">Packing Slip</div>

      <div className="mb-6 text-[11pt] leading-relaxed">
        <div className="font-bold text-base">{c.name}</div>
        {c.contactName && <div className="font-semibold">{c.contactName}</div>}
        {c.addressLine1 && <div className="font-semibold">{c.addressLine1}</div>}
        {c.addressLine2 && <div className="font-semibold">{c.addressLine2}</div>}
        <div className="font-semibold">{[c.city, c.state, c.zip].filter(Boolean).join(", ")}</div>
        {c.phone && <div className="font-semibold">{c.phone}</div>}
      </div>

      <div className="mb-3 font-medium">Product in the package:</div>

      <table className="w-full text-[10pt] border-collapse border border-stone-700">
        <thead>
          <tr className="bg-stone-100">
            <th className="border border-stone-700 py-2 px-2 text-left font-bold">Product Name</th>
            <th className="border border-stone-700 py-2 px-2 text-left font-bold">Batch number</th>
            <th className="border border-stone-700 py-2 px-2 text-left font-bold">Pack size</th>
            <th className="border border-stone-700 py-2 px-2 text-left font-bold">Pack number</th>
            <th className="border border-stone-700 py-2 px-2 text-left font-bold">Total ({order.lineItems[0]?.unit?.toLowerCase().slice(0, 1) || "g"}ram)</th>
          </tr>
        </thead>
        <tbody>
          {order.lineItems.map((it) => {
            const unit = (it.unit || "g").toLowerCase().slice(0, 1);
            const total = (Number(it.quantity) || 0) * (Number(it.packCount) || 1);
            return (
              <tr key={it.id}>
                <td className="border border-stone-700 py-2 px-2">{stripPackInfo(it.description)}</td>
                <td className="border border-stone-700 py-2 px-2 font-mono text-[9pt]">{it.batchNumber}</td>
                <td className="border border-stone-700 py-2 px-2">{it.packSize || `${it.quantity}${unit}/bottle`}</td>
                <td className="border border-stone-700 py-2 px-2">{it.packCount || 1}</td>
                <td className="border border-stone-700 py-2 px-2">{total}{unit}</td>
              </tr>
            );
          })}
          <tr className="bg-stone-50">
            <td className="border border-stone-700 py-2 px-2 font-bold">total</td>
            <td className="border border-stone-700 py-2 px-2"></td>
            <td className="border border-stone-700 py-2 px-2"></td>
            <td className="border border-stone-700 py-2 px-2"></td>
            <td className="border border-stone-700 py-2 px-2 font-bold">{totalGrams}{(order.lineItems[0]?.unit || "g").toLowerCase().slice(0, 1)}</td>
          </tr>
        </tbody>
      </table>

      <div className="mt-12 flex items-end justify-between gap-8">
        <div>
          {company.signatureDataUrl && (
            <img
              src={company.signatureDataUrl}
              alt="Signature"
              className="h-14 max-w-[200px] object-contain mb-1"
            />
          )}
          <div className="font-medium">{company.signatoryName}</div>
          <div className="text-stone-500 mt-1">{niceDate(order.date)}</div>
        </div>
        {company.sealDataUrl && (
          <img
            src={company.sealDataUrl}
            alt="Corporate seal"
            className="h-24 w-24 object-contain shrink-0"
          />
        )}
      </div>

      <div className="mt-12 pt-4 border-t border-stone-300 text-[9pt] text-stone-600 text-center space-y-0.5">
        <div>
          {company.phone && <>Tel: {company.phone}{"   "}</>}
          {company.fax && <>Fax: {company.fax}{"   "}</>}
          {company.email && <>E-mail: {company.email}</>}
        </div>
        {(company.addressLine1 || company.city) && (
          <div>Address: {[company.addressLine1, company.addressLine2, company.city, company.state, company.zip].filter(Boolean).join(", ")}</div>
        )}
        {company.website && <div>{company.website}</div>}
      </div>
    </div>
  );
}

// "Dihexa, 5x10g bottle" → "Dihexa"
function stripPackInfo(desc) {
  if (!desc) return "";
  return desc.split(",")[0].trim();
}

/* =========================================================================
   UI primitives
   ========================================================================= */

const inputCls =
  "w-full h-10 px-3 border border-stone-200 rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400";

function Card({ children }) {
  return (
    <div className="bg-white border border-stone-200 rounded-lg p-5">
      {children}
    </div>
  );
}

function Field({ label, children, wide }) {
  return (
    <div className={wide ? "col-span-2" : ""}>
      <label className="text-xs text-stone-600 font-medium block mb-1">{label}</label>
      {children}
    </div>
  );
}

function IconButton({ onClick, icon: Icon, title, danger }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`p-1.5 rounded ${danger ? "text-stone-400 hover:text-red-600 hover:bg-red-50" : "text-stone-500 hover:text-stone-900 hover:bg-stone-100"}`}
    >
      <Icon className="w-4 h-4" />
    </button>
  );
}

function Empty({ msg }) {
  return (
    <div className="text-center py-12 text-sm text-stone-500">{msg}</div>
  );
}

function Modal({ children, onClose, title }) {
  return (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-start justify-center p-6 overflow-y-auto" onClick={onClose}>
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-2xl mt-12"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-stone-200">
          <h3 className="font-semibold">{title}</h3>
          <button onClick={onClose} className="text-stone-500 hover:text-stone-900">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function AddressCard({ label, customer }) {
  return (
    <div className="text-xs text-stone-600 leading-relaxed">
      <div className="text-[10px] uppercase tracking-wider text-stone-500 font-medium mb-1">{label}</div>
      <div className="font-medium text-stone-900">{customer.name}</div>
      {customer.addressLine1 && <div>{customer.addressLine1}</div>}
      {customer.addressLine2 && <div>{customer.addressLine2}</div>}
      <div>{[customer.city, customer.state, customer.zip].filter(Boolean).join(", ")}</div>
    </div>
  );
}

function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
      }}
      className="p-1.5 rounded hover:bg-emerald-100 text-emerald-700"
      title="Copy tracking #"
    >
      {copied ? <ClipboardCheck className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
    </button>
  );
}

function ImageUploadField({ label, value, onChange, previewClass = "h-14 max-w-[200px]", help }) {
  const onPick = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 800_000) {
      alert(`${label} too large — please use an image under 800 KB. PNG with transparent background or SVG works best.`);
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => onChange(reader.result);
    reader.readAsDataURL(file);
    e.target.value = "";
  };
  return (
    <Field label={label} wide>
      <div className="flex items-center gap-3 flex-wrap">
        {value ? (
          <img
            src={value}
            alt={label}
            className={`${previewClass} object-contain border border-stone-200 rounded p-1.5 bg-white`}
          />
        ) : (
          <div className={`${previewClass} border border-dashed border-stone-300 rounded flex items-center justify-center text-xs text-stone-400`}>
            None
          </div>
        )}
        <label className="cursor-pointer px-3 py-2 border border-stone-300 rounded text-sm hover:bg-stone-50 inline-flex items-center gap-1.5">
          <input
            type="file"
            accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
            onChange={onPick}
            className="hidden"
          />
          <Plus className="w-3.5 h-3.5" />
          {value ? "Replace" : "Upload"}
        </label>
        {value && (
          <button
            onClick={() => onChange("")}
            className="px-3 py-2 text-sm text-stone-500 hover:text-red-600 hover:bg-red-50 rounded"
          >
            Remove
          </button>
        )}
        {help && <span className="text-xs text-stone-500 flex-1 min-w-0">{help}</span>}
      </div>
    </Field>
  );
}
