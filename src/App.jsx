import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Package, Users, FlaskConical, FileText, Settings as SettingsIcon,
  Plus, Trash2, Pencil, Search, Printer, Truck, X, Check,
  ChevronRight, AlertCircle, Loader2, Copy, ClipboardCheck, DollarSign, Download, MapPin, Briefcase,
  TrendingUp, TrendingDown, Minus, Mail,
} from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, CartesianGrid,
} from "recharts";

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

/* ---------- Tracking email template fill-in ---------- */

function fillTrackingTemplate(template, { order, company }) {
  const c = order.customerSnapshot || {};
  const contact = c.contactName || c.name || "there";
  const itemsList = (order.lineItems || []).map((li) => {
    const qty = li.quantity ? `${li.quantity}${(li.unit || "g").toLowerCase().slice(0, 1)}` : "";
    const desc = li.description || "";
    return `  - ${desc}${qty ? ` (${qty})` : ""}`;
  }).join("\n");

  return template
    .replaceAll("{contact}", contact)
    .replaceAll("{customer}", c.name || "")
    .replaceAll("{invoice}", order.invoiceNumber || "")
    .replaceAll("{tracking}", order.tracking || "")
    .replaceAll("{service}", order.shipService || "")
    .replaceAll("{total}", fmtUSD(order.total || 0))
    .replaceAll("{date}", niceDate(order.date))
    .replaceAll("{company}", company.name || "")
    .replaceAll("{signatory}", company.signatoryName || company.name || "")
    .replaceAll("{po}", order.poNumber || "")
    .replaceAll("{poLine}", order.poNumber ? `Customer PO: ${order.poNumber}\n\n` : "")
    .replaceAll("{itemsLine}", itemsList ? `Contents:\n${itemsList}\n\n` : "")
    .replaceAll("{items}", itemsList);
}

function buildTrackingMailto({ order, company, template }) {
  const c = order.customerSnapshot || {};
  const to = c.email || "";
  const subject = fillTrackingTemplate(template?.subject || "", { order, company });
  const body = fillTrackingTemplate(template?.body || "", { order, company });
  // mailto links require the body and subject to be URL-encoded
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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
    "Pack Sizes", "Current Batch #", "Default Description", "Notes",
  ];
  const rows = products.map((p) => [
    p.name || "",
    p.casNumber || "",
    p.defaultUnit || "",
    p.defaultPrice || "",
    productPackSizes(p).join("; "),
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

const DEFAULT_EMAIL_TEMPLATES = [
  {
    id: "shipped_standard",
    name: "Shipped — standard",
    subject: "Your order from {company} has shipped — Tracking {tracking} (Invoice attached)",
    body: `Hi {contact},

Your order #{invoice} from {company} shipped today via FedEx. The invoice is attached for your records.

Tracking number: {tracking}
Track here: https://www.fedex.com/fedextrack/?trknbr={tracking}

{poLine}{itemsLine}Please let us know if anything looks off when the package arrives.

Thanks,
{signatory}
{company}`,
  },
  {
    id: "shipped_brief",
    name: "Shipped — short",
    subject: "Order #{invoice} shipped — {tracking} (Invoice attached)",
    body: `Hi {contact},

Your order has shipped. Invoice attached. Tracking: {tracking}

https://www.fedex.com/fedextrack/?trknbr={tracking}

{signatory}`,
  },
  {
    id: "delivery_followup",
    name: "Follow-up — confirm delivery",
    subject: "Did your order from {company} arrive okay?",
    body: `Hi {contact},

Just following up on order #{invoice} that we shipped a few days ago (tracking {tracking}). Wanted to make sure it arrived in good condition and everything met your expectations.

If anything's off — packaging, quantities, paperwork — please let me know and we'll make it right.

Thanks,
{signatory}
{company}`,
  },
];

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
  salesReps: [], // [{ id, name, email, notes }]
  packagePresets: [
    { id: "small", name: "Small box", length: 6, width: 6, height: 4 },
    { id: "medium", name: "Medium box", length: 10, width: 8, height: 4 },
    { id: "large", name: "Large box", length: 12, width: 10, height: 6 },
  ],
  emailTemplates: DEFAULT_EMAIL_TEMPLATES,
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
  const [editingOrderId, setEditingOrderId] = useState(null); // when set, NewOrder loads this order for editing
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
  const deleteOrder = async (id, reason) => {
    const order = orders.find((o) => o.id === id);
    if (!order) throw new Error("Order not found");

    // Soft-delete: keep the record but mark it deleted with a reason.
    // The Orders tab filters these out by default; they can be exported via CSV
    // or recovered from KV directly if needed for audit/dispute purposes.
    const updated = {
      ...order,
      deletedAt: Date.now(),
      deletedReason: reason || "",
    };
    await store.set(KEYS.order(id), updated);
    setOrders((prev) => prev.map((o) => (o.id === id ? updated : o)));
    showToast("Order deleted");
    return updated;
  };

  const assignSalesRep = async (orderId, repId) => {
    const order = orders.find((o) => o.id === orderId);
    if (!order) return;
    const rep = (company.salesReps || []).find((r) => r.id === repId);
    const updated = {
      ...order,
      salesRepId: repId || null,
      salesRepSnapshot: rep ? { id: rep.id, name: rep.name, email: rep.email || "" } : null,
      updatedAt: Date.now(),
    };
    await store.set(KEYS.order(orderId), updated);
    setOrders((prev) => prev.map((o) => (o.id === orderId ? updated : o)));
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
      <Nav view={view} setView={(next) => {
        // Switching tabs implicitly cancels any in-progress edit
        if (next !== view && editingOrderId) setEditingOrderId(null);
        setView(next);
      }} />
      <main className="flex-1 min-w-0">
        <div className="max-w-[1400px] mx-auto px-8 py-8">
          {view === "orders" && (
            <NewOrder
              customers={customers}
              products={products}
              counters={counters}
              company={company}
              fedex={fedex}
              orders={orders}
              onSave={saveOrder}
              onPrint={openPrint}
              showToast={showToast}
              editingOrderId={editingOrderId}
              onClearEditing={() => setEditingOrderId(null)}
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
              onEdit={(order) => {
                setEditingOrderId(order.id);
                setView("orders");
              }}
              salesReps={company.salesReps || []}
              onAssignRep={assignSalesRep}
              company={company}
            />
          )}
          {view === "commissions" && (
            <CommissionsView orders={orders} salesReps={company.salesReps || []} />
          )}
          {view === "reports" && (
            <ReportsView
              orders={orders}
              customers={customers}
              products={products}
              salesReps={company.salesReps || []}
            />
          )}
          {view === "settings" && (
            <SettingsView
              company={company}
              fedex={fedex}
              counters={counters}
              customers={customers}
              products={products}
              orders={orders}
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
    { id: "commissions", label: "Commissions", icon: Briefcase },
    { id: "reports", label: "Reports", icon: AlertCircle },
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

function NewOrder({ customers, products, counters, company, fedex, orders, onSave, onPrint, showToast, editingOrderId, onClearEditing }) {
  const [customerId, setCustomerId] = useState("");
  const [poNumber, setPoNumber] = useState("");
  const [date, setDate] = useState(today());
  const [invoiceNumber, setInvoiceNumber] = useState(formatInvoice(counters.invoice, company));
  const [shipping, setShipping] = useState(0);
  const [lineItems, setLineItems] = useState([]);
  const [shipWeightLbs, setShipWeightLbs] = useState("");
  const [shipDims, setShipDims] = useState({ length: 10, width: 8, height: 4 });
  const [shipService, setShipService] = useState(fedex.defaultService || "FEDEX_GROUND");
  const [signatureRequired, setSignatureRequired] = useState(false);
  const [shipping_state, setShippingState] = useState({ status: "idle", tracking: null, labelBase64: null, error: null });
  const [savedOrderId, setSavedOrderId] = useState(null);
  const [rates, setRates] = useState([]);
  const [ratesStatus, setRatesStatus] = useState("idle"); // idle | loading | ok | err
  const [ratesError, setRatesError] = useState(null);

  useEffect(() => {
    // When new (no saved order), keep invoice # in sync with the counter
    if (!savedOrderId) setInvoiceNumber(formatInvoice(counters.invoice, company));
  }, [counters.invoice, company.name, savedOrderId]);

  // Load an existing order into the form when editingOrderId changes
  useEffect(() => {
    if (!editingOrderId) return;
    const o = orders.find((x) => x.id === editingOrderId);
    if (!o) return;
    setSavedOrderId(o.id);
    setInvoiceNumber(o.invoiceNumber || "");
    setPoNumber(o.poNumber || "");
    setDate(o.date || today());
    setCustomerId(o.customerId || (o.customerSnapshot?.id) || "");
    setLineItems((o.lineItems || []).map((li) => ({ ...li, id: li.id || newId() })));
    setShipping(o.shipping || 0);
    setShipWeightLbs(o.shipWeightLbs || "");
    setShipDims(o.shipDims || { length: 10, width: 8, height: 4 });
    setShipService(o.shipService || fedex.defaultService || "FEDEX_GROUND");
    setSignatureRequired(!!o.signatureRequired);
    setShippingState({
      status: o.tracking ? "ok" : "idle",
      tracking: o.tracking || null,
      labelBase64: o.labelBase64 || null,
      error: null,
    });
    setRates([]);
    setRatesStatus("idle");
    setRatesError(null);
  }, [editingOrderId, orders]);

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
        }
        // Auto-rebuild description if user hasn't manually overridden it,
        // and packCount/packSize changed
        if (("packCount" in patch || "packSize" in patch) && merged.productName) {
          // Only rebuild if the current description still matches the auto-format —
          // this protects manual edits the user has made
          const expectedOld = buildLineDescription(merged.productName, it.packCount, it.packSize);
          if (it.description === expectedOld || !it.description) {
            merged.description = buildLineDescription(merged.productName, merged.packCount, merged.packSize);
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
    const packSizes = productPackSizes(p);
    const firstPackSize = packSizes[0] || "";
    updateLine(lineId, {
      productId: p.id,
      productName: p.name || "",
      description: buildLineDescription(p.name, 1, firstPackSize),
      casNumber: p.casNumber || "",
      unit: p.defaultUnit || "Gram",
      unitPriceNum: Number(p.defaultPrice) || 0,
      batchNumber: p.batchNumber || "",
      packSize: firstPackSize,
    });
  };

  const removeLine = (id) => setLineItems((prev) => prev.filter((it) => it.id !== id));

  const buildOrder = () => {
    const existing = savedOrderId ? orders.find((o) => o.id === savedOrderId) : null;
    return {
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
      // Sales rep — set via Orders tab, never via this form. Preserve any prior value.
      salesRepId: existing?.salesRepId || null,
      salesRepSnapshot: existing?.salesRepSnapshot || null,
      // Persisted shipping fields — carry forward from the existing record
      tracking: shipping_state.tracking || existing?.tracking || null,
      labelBase64: existing?.labelBase64 || null,
      labelFormat: existing?.labelFormat || null,
      shippedAt: existing?.shippedAt || null,
    };
  };

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

      // save with tracking + label PDF
      const order = await onSave({
        ...buildOrder(),
        id: savedOrderId || undefined,
        tracking: data.trackingNumber,
        labelBase64: data.labelBase64 || null,
        labelFormat: data.labelFormat || "application/pdf",
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
    setShipWeightLbs("");
    setShippingState({ status: "idle", tracking: null, labelBase64: null, error: null });
    setSavedOrderId(null);
    setInvoiceNumber(formatInvoice(counters.invoice, company));
    if (editingOrderId) onClearEditing?.();
  };

  const isEditing = !!editingOrderId;
  const isShipped = !!shipping_state.tracking;

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {isEditing ? (isShipped ? "Edit Order" : "Edit Draft") : "New Order"}
          </h1>
          <p className="text-sm text-stone-500 mt-0.5">
            {isEditing
              ? `Editing ${invoiceNumber}. Changes save back to the same order.`
              : "Create an invoice, packing slip, and FedEx label."}
          </p>
        </div>
        <button
          onClick={reset}
          className="text-sm text-stone-600 hover:text-stone-900 px-3 py-1.5 rounded border border-stone-200 hover:bg-white"
        >
          {isEditing ? "Done editing" : "Clear form"}
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
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h2 className="font-semibold">Shipping parameters</h2>
          {(company.packagePresets || []).length > 0 && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-stone-500 font-medium">Package preset:</label>
              <select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  const preset = (company.packagePresets || []).find((p) => p.id === e.target.value);
                  if (!preset) return;
                  setShipDims({
                    length: preset.length || 0,
                    width: preset.width || 0,
                    height: preset.height || 0,
                  });
                  e.target.value = "";
                }}
                className="h-9 px-2 border border-stone-200 rounded text-sm bg-white"
              >
                <option value="">Choose a preset…</option>
                {(company.packagePresets || []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {p.length}×{p.width}×{p.height} in
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
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

          {/* Row 1: Product, Description, CAS, Batch # */}
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
              placeholder="e.g. Dihexa, 5x10g"
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
          <div className="col-span-6 md:col-span-3">
            <label className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">Batch #</label>
            <input
              value={line.batchNumber}
              onChange={(e) => onChange({ batchNumber: e.target.value })}
              className={inputCls + " mt-1 font-mono text-xs"}
              placeholder="HXDHX251001"
            />
          </div>

          {/* Row 2: Qty, Unit, Pack size, Pack count, $/Unit, Amount */}
          <div className="col-span-4 md:col-span-2">
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
            <label className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">Unit</label>
            <input
              value={line.unit}
              onChange={(e) => onChange({ unit: e.target.value })}
              className={inputCls + " mt-1"}
            />
          </div>
          <div className="col-span-6 md:col-span-3">
            <label className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">Pack size</label>
            {(() => {
              const product = products.find((p) => p.id === line.productId);
              const sizes = productPackSizes(product);
              if (sizes.length === 0) {
                return (
                  <div className={inputCls + " mt-1 text-stone-400 flex items-center text-xs"}>
                    Add pack sizes in Catalog
                  </div>
                );
              }
              return (
                <select
                  value={line.packSize || sizes[0]}
                  onChange={(e) => onChange({ packSize: e.target.value })}
                  className={inputCls + " mt-1"}
                >
                  {sizes.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              );
            })()}
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
          <div className="col-span-6 md:col-span-2">
            <label className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">$ / unit</label>
            <input
              type="number"
              step="0.01"
              value={line.unitPriceNum}
              onChange={(e) => onChange({ unitPriceNum: e.target.value })}
              className={inputCls + " mt-1"}
            />
          </div>
          <div className="col-span-6 md:col-span-2 flex flex-col">
            <label className="text-[10px] uppercase tracking-wider text-stone-500 font-medium">Amount</label>
            <div className="mt-1 h-10 flex items-center font-medium tabular-nums">
              {fmtUSD(line.amount)}
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
  const [deleteTarget, setDeleteTarget] = useState(null);

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
                  <IconButton onClick={() => setDeleteTarget(c)} icon={Trash2} title="Delete" danger />
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

      {deleteTarget && (
        <ConfirmDeleteModal
          entityType="Customer"
          entityName={deleteTarget.name}
          details={
            <>
              <div><span className="text-stone-500">Name:</span> <span className="font-medium">{deleteTarget.name}</span></div>
              {deleteTarget.customerId && <div><span className="text-stone-500">ID:</span> <span className="font-mono">{deleteTarget.customerId}</span></div>}
              {deleteTarget.contactName && <div><span className="text-stone-500">Contact:</span> {deleteTarget.contactName}</div>}
              {(deleteTarget.city || deleteTarget.state) && (
                <div><span className="text-stone-500">Location:</span> {[deleteTarget.city, deleteTarget.state].filter(Boolean).join(", ")}</div>
              )}
            </>
          }
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => {
            await onDelete(deleteTarget.id);
            setDeleteTarget(null);
          }}
        />
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
  const [deleteTarget, setDeleteTarget] = useState(null);

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
                  <th className="py-2 pr-4 font-medium">Pack sizes</th>
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
                    <td className="py-2.5 pr-4">
                      {(() => {
                        const sizes = productPackSizes(p);
                        if (sizes.length === 0) return <span className="text-stone-400">—</span>;
                        if (sizes.length <= 3) return sizes.join(", ");
                        return (
                          <span title={sizes.join(", ")}>
                            {sizes.slice(0, 3).join(", ")} <span className="text-stone-400">+{sizes.length - 3}</span>
                          </span>
                        );
                      })()}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-stone-500">{p.batchNumber}</td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      <IconButton onClick={() => setEditing(p)} icon={Pencil} title="Edit" />
                      <IconButton onClick={() => setDeleteTarget(p)} icon={Trash2} title="Delete" danger />
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

      {deleteTarget && (
        <ConfirmDeleteModal
          entityType="Product"
          entityName={deleteTarget.name}
          details={
            <>
              <div><span className="text-stone-500">Name:</span> <span className="font-medium">{deleteTarget.name}</span></div>
              {deleteTarget.casNumber && <div><span className="text-stone-500">CAS:</span> <span className="font-mono">{deleteTarget.casNumber}</span></div>}
              {(() => {
                const sizes = productPackSizes(deleteTarget);
                return sizes.length > 0 ? (
                  <div><span className="text-stone-500">Pack sizes:</span> {sizes.join(", ")}</div>
                ) : null;
              })()}
              {deleteTarget.batchNumber && <div><span className="text-stone-500">Current batch:</span> <span className="font-mono">{deleteTarget.batchNumber}</span></div>}
            </>
          }
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => {
            await onDelete(deleteTarget.id);
            setDeleteTarget(null);
          }}
        />
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
    defaultDescription: "",
    batchNumber: "",
    notes: "",
    packSizes: [],
    ...initial,
  });
  const [newSize, setNewSize] = useState("");
  const set = (patch) => setP({ ...p, ...patch });

  const addPackSize = () => {
    const s = newSize.trim();
    if (!s) return;
    if (p.packSizes.includes(s)) {
      setNewSize("");
      return;
    }
    set({ packSizes: [...p.packSizes, s] });
    setNewSize("");
  };

  const removePackSize = (idx) => {
    set({ packSizes: p.packSizes.filter((_, i) => i !== idx) });
  };

  const movePackSize = (idx, direction) => {
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= p.packSizes.length) return;
    const next = [...p.packSizes];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    set({ packSizes: next });
  };

  const submit = () => {
    if (!p.name?.trim()) return;
    onSave({ ...p, packSizes: p.packSizes.filter(Boolean) });
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
        <Field label="Current batch #">
          <input value={p.batchNumber} onChange={(e) => set({ batchNumber: e.target.value })} className={inputCls + " font-mono"} placeholder="HXDHX251001" />
        </Field>
        <Field label="Default invoice description">
          <input value={p.defaultDescription} onChange={(e) => set({ defaultDescription: e.target.value })} className={inputCls} placeholder="Auto from name + pack size if blank" />
        </Field>
      </div>

      {/* Pack sizes — list editor */}
      <div className="pt-2">
        <label className="text-xs text-stone-600 font-medium block mb-1.5">
          Available pack sizes <span className="text-stone-400 font-normal">— shown in a dropdown when picking this product</span>
        </label>
        <div className="border border-stone-200 rounded">
          {p.packSizes.length === 0 ? (
            <div className="px-3 py-2.5 text-sm text-stone-400">No pack sizes yet — add one below.</div>
          ) : (
            <div className="divide-y divide-stone-100">
              {p.packSizes.map((size, idx) => (
                <div key={idx} className="px-3 py-2 flex items-center gap-2">
                  <span className="text-xs text-stone-400 w-6 text-right tabular-nums">{idx + 1}.</span>
                  <span className="flex-1 text-sm font-mono">{size}</span>
                  <button
                    onClick={() => movePackSize(idx, -1)}
                    disabled={idx === 0}
                    className="text-xs text-stone-500 hover:text-stone-900 px-1 disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Move up"
                  >▲</button>
                  <button
                    onClick={() => movePackSize(idx, 1)}
                    disabled={idx === p.packSizes.length - 1}
                    className="text-xs text-stone-500 hover:text-stone-900 px-1 disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Move down"
                  >▼</button>
                  <IconButton onClick={() => removePackSize(idx)} icon={X} title="Remove" danger />
                </div>
              ))}
            </div>
          )}
          <div className="border-t border-stone-100 p-2 flex gap-2">
            <input
              value={newSize}
              onChange={(e) => setNewSize(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addPackSize(); } }}
              placeholder="e.g. 5g, 10g, 50g, 100g, 5g Bottle, 10mg vial"
              className={inputCls}
            />
            <button
              onClick={addPackSize}
              disabled={!newSize.trim()}
              className="px-3 py-1.5 text-sm rounded bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50 whitespace-nowrap"
            >
              Add
            </button>
          </div>
        </div>
        <div className="text-[11px] text-stone-500 mt-1.5 leading-relaxed">
          Order matters — the first pack size becomes the default when this product is picked. Use the arrows to reorder.
        </div>
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

function HistoryView({ orders, onPrint, onDelete, onEdit, salesReps, onAssignRep, company }) {
  const [search, setSearch] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null); // order being deleted
  const [emailTarget, setEmailTarget] = useState(null); // order being emailed
  const [showDeleted, setShowDeleted] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let base = showDeleted ? orders : orders.filter((o) => !o.deletedAt);
    if (!q) return base;
    return base.filter((o) => {
      if (o.invoiceNumber?.toLowerCase().includes(q)) return true;
      if (o.customerSnapshot?.name?.toLowerCase().includes(q)) return true;
      if (o.tracking?.toLowerCase().includes(q)) return true;
      if (o.poNumber?.toLowerCase().includes(q)) return true;
      if (o.salesRepSnapshot?.name?.toLowerCase().includes(q)) return true;
      // Line item match: description, CAS number, or batch number
      if (o.lineItems?.some((li) =>
        li.description?.toLowerCase().includes(q) ||
        li.casNumber?.toLowerCase().includes(q) ||
        li.batchNumber?.toLowerCase().includes(q)
      )) return true;
      return false;
    });
  }, [orders, search, showDeleted]);

  const deletedCount = orders.filter((o) => o.deletedAt).length;

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            {orders.length - deletedCount} active
            {deletedCount > 0 && ` · ${deletedCount} deleted`}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          {deletedCount > 0 && (
            <label className="flex items-center gap-1.5 text-sm text-stone-600 px-2 cursor-pointer">
              <input
                type="checkbox"
                checked={showDeleted}
                onChange={(e) => setShowDeleted(e.target.checked)}
              />
              Show deleted
            </label>
          )}
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
            placeholder="Search by invoice #, customer, tracking, PO #, sales rep, product, CAS, or batch…"
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
                  <th className="py-2 pr-4 font-medium">Sales rep</th>
                  <th className="py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {filtered.map((o) => (
                  <tr key={o.id} className={o.deletedAt ? "bg-stone-50 opacity-60" : ""}>
                    <td className="py-2.5 pr-4 font-medium">
                      {o.deletedAt && <span className="text-[10px] uppercase tracking-wider text-red-700 bg-red-50 px-1.5 py-0.5 rounded mr-2">Deleted</span>}
                      {!o.deletedAt && !o.tracking && <span className="text-[10px] uppercase tracking-wider text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded mr-2">Draft</span>}
                      <span className={o.deletedAt ? "line-through" : ""}>{o.invoiceNumber}</span>
                    </td>
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
                    <td className="py-2.5 pr-4">
                      {!o.deletedAt ? (
                        <select
                          value={o.salesRepId || ""}
                          onChange={(e) => onAssignRep(o.id, e.target.value)}
                          className="h-8 px-2 border border-stone-200 rounded text-xs bg-white max-w-[140px] focus:outline-none focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400"
                        >
                          <option value="">— None —</option>
                          {salesReps.map((r) => (
                            <option key={r.id} value={r.id}>{r.name}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs text-stone-400">{o.salesRepSnapshot?.name || "—"}</span>
                      )}
                    </td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      {!o.deletedAt && (
                        <IconButton onClick={() => onEdit(o)} icon={Pencil} title={o.tracking ? "Edit order" : "Edit draft"} />
                      )}
                      <IconButton onClick={() => onPrint(o, "invoice")} icon={FileText} title="Invoice" />
                      <IconButton onClick={() => onPrint(o, "packing")} icon={Package} title="Packing slip" />
                      {o.labelBase64 && (
                        <IconButton
                          onClick={() => openPdfFromBase64(o.labelBase64, `Label-${o.tracking || o.invoiceNumber}.pdf`)}
                          icon={Truck}
                          title="FedEx label"
                        />
                      )}
                      {o.tracking && !o.deletedAt && (
                        <IconButton
                          onClick={() => {
                            const email = o.customerSnapshot?.email;
                            if (!email) {
                              alert("This customer has no email on file. Add one to the customer record first.");
                              return;
                            }
                            setEmailTarget(o);
                          }}
                          icon={Mail}
                          title="Send tracking email"
                        />
                      )}
                      {!o.deletedAt && (
                        <IconButton onClick={() => setDeleteTarget(o)} icon={Trash2} title="Delete" danger />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {deleteTarget && (
        <DeleteOrderModal
          order={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async (reason) => {
            await onDelete(deleteTarget.id, reason);
            setDeleteTarget(null);
          }}
        />
      )}

      {emailTarget && (
        <EmailPickerModal
          order={emailTarget}
          company={company}
          onClose={() => setEmailTarget(null)}
        />
      )}
    </div>
  );
}


/* ---------- Reusable confirm-delete modal: type-to-confirm pattern ---------- */

function ConfirmDeleteModal({ entityType, entityName, details, onClose, onConfirm }) {
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const expected = (entityName || "").trim();
  const matches = typed.trim() === expected;

  const submit = async () => {
    if (!matches) {
      setError(`Type the ${entityType.toLowerCase()} name exactly to confirm.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError(e.message || "Deletion failed");
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={submitting ? () => {} : onClose} title={`Delete ${entityType.toLowerCase()}`}>
      <div className="space-y-4">
        <div className="p-4 bg-amber-50 border border-amber-200 rounded text-sm text-amber-900">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold mb-1">This permanently deletes the {entityType.toLowerCase()}.</div>
              <div>Past orders that referenced this {entityType.toLowerCase()} keep their snapshot, so order history is preserved. The {entityType.toLowerCase()} itself cannot be recovered.</div>
            </div>
          </div>
        </div>

        {details && (
          <div className="border border-stone-200 rounded p-3 text-sm space-y-1">
            <div className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-1.5">{entityType} being deleted</div>
            {details}
          </div>
        )}

        <Field label={
          <>Type <code className="font-mono bg-stone-100 px-1 py-0.5 rounded text-stone-900">{expected}</code> to confirm</>
        }>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className={inputCls + " font-mono"}
            placeholder={expected}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && matches && !submitting) submit();
            }}
          />
        </Field>

        {error && (
          <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-3 border-t border-stone-200">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-sm rounded border border-stone-300 hover:bg-stone-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || !matches}
            className="px-4 py-2 bg-red-600 text-white text-sm rounded hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            Delete {entityType.toLowerCase()}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- Email picker — pick a template, send via mailto ---------- */

function EmailPickerModal({ order, company, onClose }) {
  const templates = company.emailTemplates || [];
  const [selectedId, setSelectedId] = useState(templates[0]?.id || null);
  const selected = templates.find((t) => t.id === selectedId);

  const send = () => {
    if (!selected) return;
    window.location.href = buildTrackingMailto({ order, company, template: selected });
    onClose();
  };

  // Build live preview of the chosen template
  const previewSubject = selected ? fillTrackingTemplate(selected.subject || "", { order, company }) : "";
  const previewBody = selected ? fillTrackingTemplate(selected.body || "", { order, company }) : "";

  if (templates.length === 0) {
    return (
      <Modal onClose={onClose} title="Send tracking email">
        <div className="space-y-4">
          <Empty msg="No email templates yet. Add one in Settings → Tracking email templates." />
          <div className="flex justify-end pt-3 border-t border-stone-200">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-stone-300 hover:bg-stone-50">
              Close
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} title="Send tracking email">
      <div className="space-y-4">
        <div className="text-sm text-stone-700">
          Sending to <span className="font-medium">{order.customerSnapshot?.email}</span> for invoice <span className="font-mono">{order.invoiceNumber}</span>.
        </div>

        <div>
          <div className="text-xs text-stone-600 font-medium mb-2">Choose a template</div>
          <div className="border border-stone-200 rounded divide-y divide-stone-100 max-h-[200px] overflow-y-auto">
            {templates.map((t) => (
              <label
                key={t.id}
                className={`flex items-start gap-2.5 p-3 cursor-pointer ${selectedId === t.id ? "bg-stone-50" : "hover:bg-stone-50"}`}
              >
                <input
                  type="radio"
                  name="email-template"
                  value={t.id}
                  checked={selectedId === t.id}
                  onChange={() => setSelectedId(t.id)}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{t.name}</div>
                  <div className="text-xs text-stone-500 mt-0.5 truncate">
                    {fillTrackingTemplate(t.subject || "", { order, company })}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>

        {selected && (
          <div className="bg-stone-50 border border-stone-200 rounded p-3">
            <div className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-2">Preview</div>
            <div className="text-xs text-stone-500 mb-1">Subject:</div>
            <div className="text-sm font-medium mb-3">{previewSubject}</div>
            <div className="text-xs text-stone-500 mb-1">Body:</div>
            <pre className="text-xs whitespace-pre-wrap text-stone-700 font-sans leading-relaxed max-h-[240px] overflow-y-auto">{previewBody}</pre>
          </div>
        )}

        <div className="text-xs text-stone-500 leading-relaxed">
          Your default mail app will open with this draft. Review and click Send when ready. To attach the invoice PDF, click <span className="font-medium">Invoice (PDF)</span> on this order to download it, then drag the downloaded file into your email window.
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-stone-200">
          <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-stone-300 hover:bg-stone-50">
            Cancel
          </button>
          <button
            onClick={send}
            disabled={!selected}
            className="px-4 py-2 bg-stone-900 text-white rounded text-sm hover:bg-stone-800 disabled:opacity-50 flex items-center gap-2"
          >
            <Mail className="w-4 h-4" />
            Open in mail app
          </button>
        </div>
      </div>
    </Modal>
  );
}

function DeleteOrderModal({ order, onClose, onConfirm }) {
  const [step, setStep] = useState(1);
  const [reason, setReason] = useState("");
  const [acknowledgeChecked, setAcknowledgeChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const c = order.customerSnapshot || {};
  const hasActiveLabel = !!order.tracking;

  const submit = async () => {
    if (!reason.trim()) {
      setError("Please enter a reason — this protects you from accidental deletions.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
    } catch (e) {
      setError(e.message || "Deletion failed");
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={submitting ? () => {} : onClose} title="Delete order">
      {step === 1 && (
        <div className="space-y-4">
          <div className="p-4 bg-amber-50 border border-amber-200 rounded">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-amber-700 mt-0.5 shrink-0" />
              <div className="text-sm text-amber-900">
                <div className="font-semibold mb-1">Make sure this is the right order to delete.</div>
                <div>The order will be marked deleted and hidden from the default Orders view, but the record stays in your data for audit. Toggle <span className="font-medium">Show deleted</span> to see it again.</div>
              </div>
            </div>
          </div>

          {hasActiveLabel && (
            <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-800">
              <div className="font-semibold mb-1 flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4" />
                This order has an active FedEx label
              </div>
              <div>
                Tracking <span className="font-mono">{order.tracking}</span> is still live with FedEx and may bill when scanned.
                If the package isn't going out, <span className="font-medium">cancel the label first</span> using the red ❌ button — then delete the order.
              </div>
            </div>
          )}

          <div className="border border-stone-200 rounded p-3 text-sm space-y-1">
            <div className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-1.5">Order being deleted</div>
            <div><span className="text-stone-500">Invoice:</span> <span className="font-medium">{order.invoiceNumber}</span></div>
            <div><span className="text-stone-500">Customer:</span> <span className="font-medium">{c.name}</span></div>
            <div><span className="text-stone-500">Date:</span> {niceDate(order.date)}</div>
            <div><span className="text-stone-500">Total:</span> {fmtUSD(order.total)}</div>
            {order.tracking && <div><span className="text-stone-500">Tracking:</span> <span className="font-mono">{order.tracking}</span></div>}
          </div>

          <label className="flex items-start gap-2 text-sm cursor-pointer p-2 hover:bg-stone-50 rounded">
            <input
              type="checkbox"
              checked={acknowledgeChecked}
              onChange={(e) => setAcknowledgeChecked(e.target.checked)}
              className="mt-1"
            />
            <span className="text-stone-700">
              I want to delete this order. I've reviewed the details above and confirm this is the right one.
            </span>
          </label>

          <div className="flex justify-end gap-2 pt-3 border-t border-stone-200">
            <button onClick={onClose} className="px-3 py-1.5 text-sm rounded border border-stone-300 hover:bg-stone-50">
              Keep order
            </button>
            <button
              onClick={() => setStep(2)}
              disabled={!acknowledgeChecked}
              className="px-4 py-2 bg-red-600 text-white text-sm rounded hover:bg-red-700 disabled:opacity-50"
            >
              Continue to delete
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="text-sm text-stone-700">
            Last step. Briefly note why you're deleting this order — it gets saved on the record so you can look back later.
          </div>

          <Field label="Reason for deleting *">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full min-h-[80px] px-3 py-2 border border-stone-200 rounded text-sm bg-white focus:outline-none focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400"
              placeholder="e.g. Duplicate order, customer cancelled, test order"
              autoFocus
            />
          </Field>

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex justify-between items-center pt-3 border-t border-stone-200">
            <button
              onClick={() => setStep(1)}
              disabled={submitting}
              className="text-sm text-stone-600 hover:text-stone-900 disabled:opacity-50"
            >
              ← Back
            </button>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                disabled={submitting}
                className="px-3 py-1.5 text-sm rounded border border-stone-300 hover:bg-stone-50 disabled:opacity-50"
              >
                Keep order
              </button>
              <button
                onClick={submit}
                disabled={submitting || !reason.trim()}
                className="px-4 py-2 bg-red-600 text-white text-sm rounded hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                Delete order
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
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

/* =========================================================================
   Backup & Restore
   ========================================================================= */

function BackupCard({ company, fedex, counters, customers, products, orders }) {
  const [restoring, setRestoring] = useState(false);
  const [restoreState, setRestoreState] = useState(null); // null | { error } | { ok, summary }

  const exportBackup = () => {
    const snapshot = {
      _meta: {
        format: "shipping-app-backup-v1",
        exportedAt: new Date().toISOString(),
        appVersion: "1",
        counts: {
          customers: customers.length,
          products: products.length,
          orders: orders.length,
        },
      },
      settings: {
        company,
        fedex: { ...fedex, appAuthToken: fedex.appAuthToken ? "***REDACTED***" : "" },
        counters,
      },
      customers,
      products,
      orders,
    };
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shipping-backup-${todayStamp()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const handleRestore = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setRestoring(true);
    setRestoreState(null);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (data?._meta?.format !== "shipping-app-backup-v1") {
          throw new Error("File is not a recognized backup format.");
        }
        const confirmText = `RESTORE BACKUP

This will OVERWRITE all current data with the backup contents:
- ${(data.customers || []).length} customers
- ${(data.products || []).length} products
- ${(data.orders || []).length} orders

Backup was taken: ${data._meta.exportedAt || "unknown"}

This cannot be undone. Continue?`;
        if (!confirm(confirmText)) {
          setRestoring(false);
          return;
        }

        // Restore: write each record to storage. Existing records with the same ID
        // are overwritten; records present locally but not in backup are NOT deleted
        // (the merge model — safer than wholesale wipe-and-replace).
        let touched = 0;
        if (data.settings?.company) { await store.set(KEYS.company, data.settings.company); touched++; }
        if (data.settings?.fedex && data.settings.fedex.appAuthToken !== "***REDACTED***") {
          await store.set(KEYS.fedex, data.settings.fedex); touched++;
        }
        if (data.settings?.counters) { await store.set(KEYS.counters, data.settings.counters); touched++; }
        for (const c of (data.customers || [])) { await store.set(KEYS.customer(c.id), c); touched++; }
        for (const p of (data.products || [])) { await store.set(KEYS.product(p.id), p); touched++; }
        for (const o of (data.orders || [])) { await store.set(KEYS.order(o.id), o); touched++; }

        setRestoreState({ ok: true, summary: `Restored ${touched} records. Reloading…` });
        setTimeout(() => location.reload(), 1500);
      } catch (err) {
        setRestoreState({ error: err.message || "Restore failed" });
        setRestoring(false);
      }
    };
    reader.onerror = () => {
      setRestoreState({ error: "Failed to read file" });
      setRestoring(false);
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  return (
    <Card>
      <h2 className="font-semibold mb-1">Backup & restore</h2>
      <p className="text-xs text-stone-500 mb-4">
        Cloudflare KV doesn't auto-backup. Export a JSON snapshot of all your data weekly and store it somewhere safe (Google Drive, Dropbox, your laptop). Restore from any snapshot if data is lost or corrupted.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="p-3 border border-stone-200 rounded">
          <div className="text-sm font-medium mb-1">Export snapshot</div>
          <div className="text-xs text-stone-500 mb-3 leading-relaxed">
            Downloads a single JSON file containing all customers ({customers.length}), products ({products.length}), orders ({orders.length}), and settings. Safe to email or upload — secrets like the FedEx auth token are redacted.
          </div>
          <button
            onClick={exportBackup}
            className="px-3 py-2 bg-stone-900 text-white text-sm rounded hover:bg-stone-800 flex items-center gap-1.5 w-fit"
          >
            <Download className="w-4 h-4" /> Download backup
          </button>
        </div>

        <div className="p-3 border border-stone-200 rounded">
          <div className="text-sm font-medium mb-1">Restore from backup</div>
          <div className="text-xs text-stone-500 mb-3 leading-relaxed">
            Upload a previously exported JSON snapshot. Records with matching IDs are <span className="font-medium">overwritten</span>. Records that exist locally but not in the backup are <span className="font-medium">left alone</span> — restore is additive, not destructive.
          </div>
          <label className={`px-3 py-2 border border-stone-300 text-sm rounded inline-flex items-center gap-1.5 cursor-pointer w-fit ${restoring ? "opacity-50 cursor-not-allowed" : "hover:bg-stone-50"}`}>
            <input type="file" accept=".json,application/json" onChange={handleRestore} disabled={restoring} className="hidden" />
            {restoring ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Choose backup file
          </label>
        </div>
      </div>

      {restoreState?.error && (
        <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{restoreState.error}</span>
        </div>
      )}
      {restoreState?.ok && (
        <div className="mt-3 p-3 bg-emerald-50 border border-emerald-200 rounded text-sm text-emerald-700 flex items-start gap-2">
          <Check className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{restoreState.summary}</span>
        </div>
      )}

      <div className="mt-4 pt-4 border-t border-stone-200 text-xs text-stone-500 leading-relaxed">
        <span className="font-medium text-stone-700">For automated weekly backups:</span> see <code className="bg-stone-100 px-1 py-0.5 rounded">backup-script.js</code> in your project files. Schedule it on your Mac via cron or launchd to auto-export to Google Drive, Dropbox, or any cloud folder.
      </div>
    </Card>
  );
}

/* =========================================================================
   Sales reps management (Settings card)
   ========================================================================= */

function SalesRepsCard({ reps, onChange }) {
  const [editing, setEditing] = useState(null); // { id?, name, email, notes }
  const [deleteTarget, setDeleteTarget] = useState(null);

  const submit = (rep) => {
    if (!rep.name?.trim()) return;
    let next;
    if (rep.id) {
      next = reps.map((r) => (r.id === rep.id ? { ...r, ...rep } : r));
    } else {
      next = [...reps, { ...rep, id: newId() }];
    }
    onChange(next);
    setEditing(null);
  };

  const remove = (id) => {
    onChange(reps.filter((r) => r.id !== id));
    setDeleteTarget(null);
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-semibold">Sales reps <span className="text-xs text-stone-500 font-normal">— internal only, never shown on invoices or packing slips</span></h2>
          <p className="text-xs text-stone-500 mt-0.5">Used for tagging orders and tracking commission.</p>
        </div>
        <button
          onClick={() => setEditing({ name: "", email: "", notes: "" })}
          className="px-3 py-2 bg-stone-900 text-white text-sm rounded hover:bg-stone-800 flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" /> Add rep
        </button>
      </div>

      {reps.length === 0 ? (
        <Empty msg="No reps yet. Add one to start tagging orders for commission tracking." />
      ) : (
        <div className="divide-y divide-stone-100 border border-stone-200 rounded">
          {reps.map((r) => (
            <div key={r.id} className="px-3 py-2 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-medium">{r.name}</div>
                {(r.email || r.notes) && (
                  <div className="text-xs text-stone-500 mt-0.5">
                    {[r.email, r.notes].filter(Boolean).join(" · ")}
                  </div>
                )}
              </div>
              <IconButton onClick={() => setEditing(r)} icon={Pencil} title="Edit" />
              <IconButton onClick={() => setDeleteTarget(r)} icon={Trash2} title="Remove" danger />
            </div>
          ))}
        </div>
      )}

      {editing && (
        <Modal onClose={() => setEditing(null)} title={editing.id ? "Edit rep" : "Add rep"}>
          <SalesRepForm initial={editing} onCancel={() => setEditing(null)} onSave={submit} />
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmDeleteModal
          entityType="Rep"
          entityName={deleteTarget.name}
          details={
            <>
              <div><span className="text-stone-500">Name:</span> <span className="font-medium">{deleteTarget.name}</span></div>
              {deleteTarget.email && <div><span className="text-stone-500">Email:</span> {deleteTarget.email}</div>}
              <div className="text-xs text-stone-500 pt-1">Past orders attributed to this rep will keep the rep's name on record (snapshot).</div>
            </>
          }
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => remove(deleteTarget.id)}
        />
      )}
    </Card>
  );
}

function SalesRepForm({ initial, onSave, onCancel }) {
  const [r, setR] = useState({ name: "", email: "", notes: "", ...initial });
  const set = (patch) => setR({ ...r, ...patch });
  return (
    <div className="space-y-3">
      <Field label="Name *">
        <input value={r.name} onChange={(e) => set({ name: e.target.value })} className={inputCls} autoFocus />
      </Field>
      <Field label="Email">
        <input value={r.email} onChange={(e) => set({ email: e.target.value })} className={inputCls} />
      </Field>
      <Field label="Notes">
        <input value={r.notes} onChange={(e) => set({ notes: e.target.value })} className={inputCls} placeholder="e.g. ABCMB LLC contractor; 10% on Reta/Tirz" />
      </Field>
      <div className="flex justify-end gap-2 pt-2 border-t border-stone-200">
        <button onClick={onCancel} className="px-3 py-1.5 text-sm rounded border border-stone-300 hover:bg-stone-50">Cancel</button>
        <button onClick={() => onSave(r)} className="px-3 py-1.5 text-sm rounded bg-stone-900 text-white hover:bg-stone-800">Save</button>
      </div>
    </div>
  );
}


/* =========================================================================
   Package presets (Settings card)
   ========================================================================= */

function PackagePresetsCard({ presets, onChange }) {
  const [editing, setEditing] = useState(null); // { id?, name, length, width, height }
  const [deleteTarget, setDeleteTarget] = useState(null);

  const submit = (preset) => {
    if (!preset.name?.trim()) return;
    let next;
    if (preset.id) {
      next = presets.map((p) => (p.id === preset.id ? { ...p, ...preset } : p));
    } else {
      next = [...presets, { ...preset, id: newId() }];
    }
    onChange(next);
    setEditing(null);
  };

  const remove = (id) => {
    onChange(presets.filter((p) => p.id !== id));
    setDeleteTarget(null);
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <div>
          <h2 className="font-semibold">Package presets</h2>
          <p className="text-xs text-stone-500 mt-0.5">Saved box dimensions you ship with most often. Pickable from a dropdown on every new order.</p>
        </div>
        <button
          onClick={() => setEditing({ name: "", length: "", width: "", height: "" })}
          className="px-3 py-1.5 bg-stone-900 text-white text-sm rounded hover:bg-stone-800 flex items-center gap-1.5"
        >
          <Plus className="w-3.5 h-3.5" /> Add preset
        </button>
      </div>

      {presets.length === 0 ? (
        <Empty msg="No package presets yet. Add one to skip typing dimensions on each new order." />
      ) : (
        <div className="border border-stone-200 rounded divide-y divide-stone-100 mt-3">
          {presets.map((p) => (
            <div key={p.id} className="px-3 py-2 flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm">{p.name}</div>
                <div className="text-xs text-stone-500 mt-0.5 tabular-nums">
                  {p.length}″ L × {p.width}″ W × {p.height}″ H
                </div>
              </div>
              <IconButton onClick={() => setEditing(p)} icon={Pencil} title="Edit" />
              <IconButton onClick={() => setDeleteTarget(p)} icon={Trash2} title="Remove" danger />
            </div>
          ))}
        </div>
      )}

      {editing && (
        <Modal onClose={() => setEditing(null)} title={editing.id ? "Edit preset" : "Add preset"}>
          <PackagePresetForm initial={editing} onCancel={() => setEditing(null)} onSave={submit} />
        </Modal>
      )}

      {deleteTarget && (
        <ConfirmDeleteModal
          entityType="Preset"
          entityName={deleteTarget.name}
          details={
            <div><span className="text-stone-500">Dimensions:</span> {deleteTarget.length}″ × {deleteTarget.width}″ × {deleteTarget.height}″</div>
          }
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => remove(deleteTarget.id)}
        />
      )}
    </Card>
  );
}

function PackagePresetForm({ initial, onSave, onCancel }) {
  const [p, setP] = useState({ name: "", length: "", width: "", height: "", ...initial });
  const set = (patch) => setP({ ...p, ...patch });
  const valid = p.name?.trim() && Number(p.length) > 0 && Number(p.width) > 0 && Number(p.height) > 0;

  return (
    <div className="space-y-3">
      <Field label="Name *">
        <input
          value={p.name}
          onChange={(e) => set({ name: e.target.value })}
          className={inputCls}
          placeholder="e.g. Small box, Medium box, Cold-pack mailer"
          autoFocus
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Length (in) *">
          <input type="number" step="0.1" value={p.length} onChange={(e) => set({ length: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Width (in) *">
          <input type="number" step="0.1" value={p.width} onChange={(e) => set({ width: e.target.value })} className={inputCls} />
        </Field>
        <Field label="Height (in) *">
          <input type="number" step="0.1" value={p.height} onChange={(e) => set({ height: e.target.value })} className={inputCls} />
        </Field>
      </div>
      <div className="flex justify-end gap-2 pt-2 border-t border-stone-200">
        <button onClick={onCancel} className="px-3 py-1.5 text-sm rounded border border-stone-300 hover:bg-stone-50">Cancel</button>
        <button
          onClick={() => onSave({
            ...p,
            length: Number(p.length) || 0,
            width: Number(p.width) || 0,
            height: Number(p.height) || 0,
          })}
          disabled={!valid}
          className="px-3 py-1.5 text-sm rounded bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}


/* =========================================================================
   Tracking email templates (Settings card) — multi-template version
   ========================================================================= */

function EmailTemplatesCard({ company, onChange }) {
  const templates = company.emailTemplates || [];
  const [editingId, setEditingId] = useState(null); // template id being edited; "new" for a new one
  const [showPreviewId, setShowPreviewId] = useState(null);

  const editingTemplate = editingId === "new"
    ? { id: "", name: "", subject: "", body: "" }
    : templates.find((t) => t.id === editingId);

  const saveTemplate = (rec) => {
    if (!rec.name?.trim()) return;
    let next;
    if (editingId === "new" || !rec.id) {
      next = [...templates, { ...rec, id: rec.id || newId() }];
    } else {
      next = templates.map((t) => (t.id === rec.id ? { ...t, ...rec } : t));
    }
    onChange({ emailTemplates: next });
    setEditingId(null);
  };

  const deleteTemplate = (id) => {
    onChange({ emailTemplates: templates.filter((t) => t.id !== id) });
  };

  const resetToDefaults = () => {
    if (!confirm("Reset all email templates to the default set? Your custom templates will be lost.")) return;
    onChange({ emailTemplates: DEFAULT_EMAIL_TEMPLATES });
  };

  return (
    <Card>
      <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
        <h2 className="font-semibold">Tracking email templates</h2>
        <div className="flex gap-2">
          <button
            onClick={resetToDefaults}
            className="text-xs text-stone-500 hover:text-stone-900 px-2 py-1.5 rounded hover:bg-stone-50"
          >
            Reset to defaults
          </button>
          <button
            onClick={() => setEditingId("new")}
            className="px-3 py-1.5 bg-stone-900 text-white text-sm rounded hover:bg-stone-800 flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" /> Add template
          </button>
        </div>
      </div>
      <p className="text-xs text-stone-500 mb-4">
        Used by the <Mail className="inline w-3 h-3 -mt-0.5" /> button on shipped orders. When you click it, you'll pick a template from a list. Use placeholders like <code className="bg-stone-100 px-1 rounded">{"{tracking}"}</code> — they're replaced with real values automatically.
      </p>

      {templates.length === 0 ? (
        <Empty msg="No templates yet. Click Add template, or Reset to defaults to get the starter set." />
      ) : (
        <div className="border border-stone-200 rounded divide-y divide-stone-100">
          {templates.map((t) => (
            <div key={t.id} className="p-3">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm">{t.name}</div>
                  <div className="text-xs text-stone-500 mt-0.5 truncate">{t.subject}</div>
                </div>
                <button
                  onClick={() => setShowPreviewId(showPreviewId === t.id ? null : t.id)}
                  className="text-xs text-stone-600 hover:text-stone-900 px-2 py-1 rounded hover:bg-stone-100"
                >
                  {showPreviewId === t.id ? "Hide" : "Preview"}
                </button>
                <IconButton onClick={() => setEditingId(t.id)} icon={Pencil} title="Edit" />
                <IconButton
                  onClick={() => {
                    if (confirm(`Delete template "${t.name}"?`)) deleteTemplate(t.id);
                  }}
                  icon={Trash2}
                  title="Delete"
                  danger
                />
              </div>
              {showPreviewId === t.id && (
                <div className="mt-3 bg-stone-50 border border-stone-200 rounded p-3">
                  <div className="text-xs text-stone-500 mb-1">Preview with sample data:</div>
                  <div className="text-sm font-medium mb-2">
                    {fillTrackingTemplate(t.subject || "", { order: SAMPLE_ORDER, company })}
                  </div>
                  <pre className="text-xs whitespace-pre-wrap text-stone-700 font-sans leading-relaxed">
                    {fillTrackingTemplate(t.body || "", { order: SAMPLE_ORDER, company })}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editingId !== null && editingTemplate && (
        <Modal
          onClose={() => setEditingId(null)}
          title={editingId === "new" ? "Add email template" : "Edit email template"}
        >
          <EmailTemplateForm
            initial={editingTemplate}
            company={company}
            onCancel={() => setEditingId(null)}
            onSave={saveTemplate}
          />
        </Modal>
      )}
    </Card>
  );
}

const SAMPLE_ORDER = {
  invoiceNumber: "REF-04-30-26-007",
  poNumber: "PO-12345",
  date: today(),
  tracking: "794912345678",
  shipService: "FEDEX_GROUND",
  total: 1337.75,
  customerSnapshot: {
    name: "CRE8 Pharmacy",
    contactName: "Esan Forde",
    email: "esan@cre8pharmacy.com",
  },
  lineItems: [
    { description: "GHK-Cu, 1x5g bottle", quantity: 5, unit: "g" },
    { description: "Dihexa, 5x10g bottle", quantity: 50, unit: "g" },
  ],
};

function EmailTemplateForm({ initial, company, onCancel, onSave }) {
  const [t, setT] = useState({
    id: initial.id || "",
    name: initial.name || "",
    subject: initial.subject || "",
    body: initial.body || "",
  });
  const [showPreview, setShowPreview] = useState(false);
  const set = (patch) => setT({ ...t, ...patch });

  const placeholders = [
    { token: "{contact}", desc: "Contact name (falls back to company name)" },
    { token: "{customer}", desc: "Customer's company name" },
    { token: "{invoice}", desc: "Invoice number" },
    { token: "{tracking}", desc: "FedEx tracking number" },
    { token: "{service}", desc: "Shipping service" },
    { token: "{date}", desc: "Order date, formatted" },
    { token: "{total}", desc: "Order total in USD" },
    { token: "{po}", desc: "Customer PO number (or empty)" },
    { token: "{poLine}", desc: "“Customer PO: ___” line, blank if no PO" },
    { token: "{items}", desc: "Bullet list of line items" },
    { token: "{itemsLine}", desc: "“Contents:” block, blank if empty" },
    { token: "{company}", desc: "Your company name" },
    { token: "{signatory}", desc: "Your signatory name" },
  ];

  const previewSubject = fillTrackingTemplate(t.subject, { order: SAMPLE_ORDER, company });
  const previewBody = fillTrackingTemplate(t.body, { order: SAMPLE_ORDER, company });

  return (
    <div className="space-y-3">
      <Field label="Template name *">
        <input
          value={t.name}
          onChange={(e) => set({ name: e.target.value })}
          className={inputCls}
          placeholder="e.g. Shipped — short"
          autoFocus
        />
      </Field>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="md:col-span-2 space-y-3">
          <Field label="Subject">
            <input
              value={t.subject}
              onChange={(e) => set({ subject: e.target.value })}
              className={inputCls}
            />
          </Field>
          <Field label="Body">
            <textarea
              value={t.body}
              onChange={(e) => set({ body: e.target.value })}
              className="w-full min-h-[260px] px-3 py-2 border border-stone-200 rounded text-sm font-mono bg-white focus:outline-none focus:ring-2 focus:ring-stone-900/10 focus:border-stone-400"
              spellCheck="false"
            />
          </Field>
        </div>
        <div>
          <div className="text-xs text-stone-600 font-medium mb-2">Placeholders</div>
          <div className="border border-stone-200 rounded p-1 max-h-[300px] overflow-y-auto">
            {placeholders.map((p) => (
              <button
                key={p.token}
                onClick={() => navigator.clipboard?.writeText(p.token)}
                title={`Click to copy: ${p.token}`}
                className="block w-full text-left px-2 py-1.5 hover:bg-stone-50 rounded text-xs group"
              >
                <code className="font-mono text-stone-900 group-hover:bg-stone-100 px-1 rounded">{p.token}</code>
                <div className="text-[11px] text-stone-500 mt-0.5">{p.desc}</div>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="flex justify-between items-center pt-3 border-t border-stone-200">
        <button
          onClick={() => setShowPreview(!showPreview)}
          className="text-sm text-stone-600 hover:text-stone-900 px-3 py-1.5 rounded border border-stone-200 hover:bg-stone-50"
        >
          {showPreview ? "Hide preview" : "Show preview"}
        </button>
        <div className="flex gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm rounded border border-stone-300 hover:bg-stone-50">Cancel</button>
          <button
            onClick={() => onSave(t)}
            disabled={!t.name?.trim()}
            className="px-3 py-1.5 text-sm rounded bg-stone-900 text-white hover:bg-stone-800 disabled:opacity-50"
          >
            Save template
          </button>
        </div>
      </div>

      {showPreview && (
        <div className="bg-stone-50 border border-stone-200 rounded p-3 mt-2">
          <div className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-2">Preview</div>
          <div className="text-xs text-stone-500 mb-1">Subject:</div>
          <div className="text-sm font-medium mb-3">{previewSubject}</div>
          <div className="text-xs text-stone-500 mb-1">Body:</div>
          <pre className="text-xs whitespace-pre-wrap text-stone-700 font-sans leading-relaxed">{previewBody}</pre>
        </div>
      )}
    </div>
  );
}

/* =========================================================================
   Commissions view
   ========================================================================= */

const COMMISSION_PERIODS = [
  { id: "all", label: "All time" },
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "ytd", label: "Year to date" },
  { id: "last_30", label: "Last 30 days" },
  { id: "last_90", label: "Last 90 days" },
];

function periodRange(periodId) {
  const now = new Date();
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const startOfMonth = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), 1); return x; };
  const endOfMonth = (d) => { const x = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999); return x; };

  if (periodId === "all") return { start: null, end: null };
  if (periodId === "this_month") return { start: startOfMonth(now), end: now };
  if (periodId === "last_month") {
    const lastMo = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { start: startOfMonth(lastMo), end: endOfMonth(lastMo) };
  }
  if (periodId === "ytd") return { start: new Date(now.getFullYear(), 0, 1), end: now };
  if (periodId === "last_30") return { start: startOfDay(new Date(now.getTime() - 30 * 86400_000)), end: now };
  if (periodId === "last_90") return { start: startOfDay(new Date(now.getTime() - 90 * 86400_000)), end: now };
  return { start: null, end: null };
}

function CommissionsView({ orders, salesReps }) {
  const [period, setPeriod] = useState("this_month");
  const [drilldownRepId, setDrilldownRepId] = useState(null);

  // Filter to non-deleted orders only — deleted orders don't count toward commissions
  const activeOrders = useMemo(() => orders.filter((o) => !o.deletedAt), [orders]);

  // Apply date range to orders. Use order.date (the invoice date) as the basis.
  const { start, end } = periodRange(period);
  const inRange = useMemo(() => {
    if (!start && !end) return activeOrders;
    return activeOrders.filter((o) => {
      if (!o.date) return false;
      const d = new Date(o.date + (o.date.length === 10 ? "T00:00:00" : ""));
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  }, [activeOrders, start, end]);

  // Group by salesRepId (use snapshot id; fall back to "unassigned" bucket)
  const summary = useMemo(() => {
    const map = new Map(); // repId -> { repId, repName, orderCount, revenue, itemsRevenue, shipping }
    for (const o of inRange) {
      const repId = o.salesRepId || "__unassigned";
      const repName = o.salesRepSnapshot?.name || "(Unassigned)";
      if (!map.has(repId)) {
        map.set(repId, { repId, repName, orderCount: 0, revenue: 0, itemsRevenue: 0, shipping: 0 });
      }
      const row = map.get(repId);
      row.orderCount += 1;
      row.revenue += Number(o.total) || 0;
      row.itemsRevenue += Number(o.itemsSubtotal) || 0;
      row.shipping += Number(o.shipping) || 0;
    }
    // Make sure every defined rep appears even with zero orders, but only when not "all time"
    for (const r of salesReps) {
      if (!map.has(r.id)) {
        map.set(r.id, { repId: r.id, repName: r.name, orderCount: 0, revenue: 0, itemsRevenue: 0, shipping: 0 });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
  }, [inRange, salesReps]);

  const totals = useMemo(() => {
    return summary.reduce(
      (acc, r) => ({
        orderCount: acc.orderCount + r.orderCount,
        revenue: acc.revenue + r.revenue,
        itemsRevenue: acc.itemsRevenue + r.itemsRevenue,
        shipping: acc.shipping + r.shipping,
      }),
      { orderCount: 0, revenue: 0, itemsRevenue: 0, shipping: 0 }
    );
  }, [summary]);

  const drilldownOrders = useMemo(() => {
    if (!drilldownRepId) return [];
    return inRange
      .filter((o) => (o.salesRepId || "__unassigned") === drilldownRepId)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }, [inRange, drilldownRepId]);

  const drilldownRep = summary.find((r) => r.repId === drilldownRepId);

  const exportSummary = () => {
    const headers = ["Sales Rep", "Orders", "Items Revenue", "Shipping", "Total Revenue"];
    const rows = summary.map((r) => [
      r.repName,
      r.orderCount,
      r.itemsRevenue.toFixed(2),
      r.shipping.toFixed(2),
      r.revenue.toFixed(2),
    ]);
    rows.push(["TOTAL", totals.orderCount, totals.itemsRevenue.toFixed(2), totals.shipping.toFixed(2), totals.revenue.toFixed(2)]);
    downloadCSV(`commissions-${period}-${todayStamp()}.csv`, rowsToCSV(headers, rows));
  };

  const exportRepDetail = () => {
    if (!drilldownRep) return;
    const headers = ["Invoice #", "Date", "Customer", "Items Subtotal", "Shipping", "Total", "Tracking"];
    const rows = drilldownOrders.map((o) => [
      o.invoiceNumber || "",
      o.date || "",
      o.customerSnapshot?.name || "",
      Number(o.itemsSubtotal || 0).toFixed(2),
      Number(o.shipping || 0).toFixed(2),
      Number(o.total || 0).toFixed(2),
      o.tracking || "",
    ]);
    const safeName = drilldownRep.repName.replace(/[^a-z0-9]+/gi, "-");
    downloadCSV(`commissions-${safeName}-${period}-${todayStamp()}.csv`, rowsToCSV(headers, rows));
  };

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Commissions</h1>
          <p className="text-sm text-stone-500 mt-0.5">
            Orders attributed to each sales rep. Commission rates are calculated externally.
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="h-10 px-3 border border-stone-200 rounded text-sm bg-white"
          >
            {COMMISSION_PERIODS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          <button
            onClick={exportSummary}
            disabled={summary.length === 0}
            className="px-3 py-2 border border-stone-300 text-sm rounded hover:bg-stone-50 flex items-center gap-1.5 disabled:opacity-40"
          >
            <Download className="w-4 h-4" /> Export summary
          </button>
        </div>
      </header>

      {!drilldownRepId && (
        <Card>
          {summary.length === 0 || totals.orderCount === 0 ? (
            <Empty msg={salesReps.length === 0
              ? "No sales reps yet. Add one in Settings to start tracking commissions."
              : "No orders in this period."} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-stone-500 uppercase tracking-wider border-b border-stone-200">
                  <tr>
                    <th className="py-2 pr-4 font-medium">Sales Rep</th>
                    <th className="py-2 pr-4 font-medium text-right">Orders</th>
                    <th className="py-2 pr-4 font-medium text-right">Items Revenue</th>
                    <th className="py-2 pr-4 font-medium text-right">Shipping</th>
                    <th className="py-2 pr-4 font-medium text-right">Total Revenue</th>
                    <th className="py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100">
                  {summary.map((r) => (
                    <tr key={r.repId} className={r.orderCount === 0 ? "text-stone-400" : ""}>
                      <td className="py-2.5 pr-4 font-medium">
                        {r.repName}
                        {r.repId === "__unassigned" && (
                          <span className="text-[10px] uppercase tracking-wider text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded ml-2">No rep</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">{r.orderCount}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums">{fmtUSD(r.itemsRevenue)}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums text-stone-500">{fmtUSD(r.shipping)}</td>
                      <td className="py-2.5 pr-4 text-right tabular-nums font-semibold">{fmtUSD(r.revenue)}</td>
                      <td className="py-2.5 text-right">
                        {r.orderCount > 0 && (
                          <button
                            onClick={() => setDrilldownRepId(r.repId)}
                            className="text-xs text-stone-600 hover:text-stone-900 px-2 py-1 rounded hover:bg-stone-100 inline-flex items-center gap-1"
                          >
                            View orders <ChevronRight className="w-3 h-3" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t-2 border-stone-300">
                  <tr className="font-semibold">
                    <td className="py-2.5 pr-4">Total</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{totals.orderCount}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{fmtUSD(totals.itemsRevenue)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums text-stone-500">{fmtUSD(totals.shipping)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{fmtUSD(totals.revenue)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>
      )}

      {drilldownRepId && drilldownRep && (
        <Card>
          <div className="flex items-center justify-between mb-3">
            <div>
              <button
                onClick={() => setDrilldownRepId(null)}
                className="text-sm text-stone-600 hover:text-stone-900 mb-1"
              >
                ← Back to all reps
              </button>
              <h2 className="font-semibold text-lg">
                {drilldownRep.repName}
                {drilldownRep.repId === "__unassigned" && <span className="text-stone-500 font-normal text-sm"> (orders without a rep tagged)</span>}
              </h2>
              <p className="text-xs text-stone-500 mt-0.5">
                {drilldownRep.orderCount} orders · {fmtUSD(drilldownRep.revenue)} total revenue
              </p>
            </div>
            <button
              onClick={exportRepDetail}
              className="px-3 py-2 border border-stone-300 text-sm rounded hover:bg-stone-50 flex items-center gap-1.5"
            >
              <Download className="w-4 h-4" /> Export detail
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-stone-500 uppercase tracking-wider border-b border-stone-200">
                <tr>
                  <th className="py-2 pr-4 font-medium">Invoice #</th>
                  <th className="py-2 pr-4 font-medium">Date</th>
                  <th className="py-2 pr-4 font-medium">Customer</th>
                  <th className="py-2 pr-4 font-medium text-right">Items</th>
                  <th className="py-2 pr-4 font-medium text-right">Shipping</th>
                  <th className="py-2 pr-4 font-medium text-right">Total</th>
                  <th className="py-2 pr-4 font-medium">Tracking</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {drilldownOrders.map((o) => (
                  <tr key={o.id}>
                    <td className="py-2.5 pr-4 font-medium">{o.invoiceNumber}</td>
                    <td className="py-2.5 pr-4 text-stone-600">{niceDate(o.date)}</td>
                    <td className="py-2.5 pr-4">{o.customerSnapshot?.name}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{fmtUSD(o.itemsSubtotal)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums text-stone-500">{fmtUSD(o.shipping)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums font-medium">{fmtUSD(o.total)}</td>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/* =========================================================================
   Reports — dashboard with KPIs, trends, top tables, and dormant customers
   ========================================================================= */

const REPORT_PERIODS = [
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "ytd", label: "Year to date" },
  { id: "last_30", label: "Last 30 days" },
  { id: "last_90", label: "Last 90 days" },
  { id: "last_12_months", label: "Last 12 months" },
  { id: "all", label: "All time" },
];

const DORMANT_THRESHOLDS = [
  { id: 30, label: "30+ days" },
  { id: 60, label: "60+ days" },
  { id: 90, label: "90+ days" },
  { id: 180, label: "6+ months" },
];

// Color palette for charts — stone-grays + a few accents that print/render well
const CHART_COLORS = ["#1c1917", "#57534e", "#a8a29e", "#0e7490", "#0891b2", "#22c55e", "#eab308", "#dc2626"];

function reportPeriodRange(periodId) {
  const now = new Date();
  const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
  const endOfMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
  const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

  if (periodId === "all") return { start: null, end: null, label: "all time" };
  if (periodId === "this_month") return { start: startOfMonth(now), end: now, label: "this month" };
  if (periodId === "last_month") {
    const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { start: startOfMonth(last), end: endOfMonth(last), label: "last month" };
  }
  if (periodId === "ytd") return { start: new Date(now.getFullYear(), 0, 1), end: now, label: "year to date" };
  if (periodId === "last_30") return { start: startOfDay(new Date(now.getTime() - 30 * 86400_000)), end: now, label: "last 30 days" };
  if (periodId === "last_90") return { start: startOfDay(new Date(now.getTime() - 90 * 86400_000)), end: now, label: "last 90 days" };
  if (periodId === "last_12_months") {
    const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    return { start, end: now, label: "last 12 months" };
  }
  return { start: null, end: null, label: "all time" };
}

function priorPeriodRange(periodId) {
  const now = new Date();
  if (periodId === "this_month") {
    const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    return { start: new Date(last.getFullYear(), last.getMonth(), 1), end: new Date(last.getFullYear(), last.getMonth() + 1, 0, 23, 59, 59, 999) };
  }
  if (periodId === "last_month") {
    const month = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    return { start: new Date(month.getFullYear(), month.getMonth(), 1), end: new Date(month.getFullYear(), month.getMonth() + 1, 0, 23, 59, 59, 999) };
  }
  if (periodId === "ytd") {
    const lastYearSameSpan = new Date(now.getFullYear() - 1, 0, 1);
    const lastYearSameDay = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate(), 23, 59, 59, 999);
    return { start: lastYearSameSpan, end: lastYearSameDay };
  }
  if (periodId === "last_30") return { start: new Date(now.getTime() - 60 * 86400_000), end: new Date(now.getTime() - 30 * 86400_000) };
  if (periodId === "last_90") return { start: new Date(now.getTime() - 180 * 86400_000), end: new Date(now.getTime() - 90 * 86400_000) };
  if (periodId === "last_12_months") {
    return { start: new Date(now.getFullYear() - 1, now.getMonth() - 11, 1), end: new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()) };
  }
  return null; // No prior comparison for "all time"
}

function orderInRange(order, start, end) {
  if (!order.date) return false;
  const d = new Date(order.date + (order.date.length === 10 ? "T00:00:00" : ""));
  if (isNaN(d)) return false;
  if (start && d < start) return false;
  if (end && d > end) return false;
  return true;
}

function pctChange(current, prior) {
  if (prior === 0 || prior === null || prior === undefined) {
    return current === 0 ? 0 : null; // null = no comparison possible
  }
  return ((current - prior) / Math.abs(prior)) * 100;
}

function ReportsView({ orders, customers, products, salesReps }) {
  const [period, setPeriod] = useState("this_month");
  const [threshold, setThreshold] = useState(30);
  const [includeNeverOrdered, setIncludeNeverOrdered] = useState(false);

  // Active orders only — deleted ones don't count for any reporting
  const activeOrders = useMemo(() => orders.filter((o) => !o.deletedAt), [orders]);

  const { start, end, label: periodLabel } = reportPeriodRange(period);
  const ordersInPeriod = useMemo(
    () => activeOrders.filter((o) => orderInRange(o, start, end)),
    [activeOrders, start, end]
  );

  const priorRange = priorPeriodRange(period);
  const ordersInPriorPeriod = useMemo(
    () => priorRange ? activeOrders.filter((o) => orderInRange(o, priorRange.start, priorRange.end)) : null,
    [activeOrders, priorRange]
  );

  // ----- Topline KPIs -----
  const kpis = useMemo(() => {
    const revenue = ordersInPeriod.reduce((s, o) => s + (Number(o.total) || 0), 0);
    const orderCount = ordersInPeriod.length;
    const avgOrder = orderCount > 0 ? revenue / orderCount : 0;
    const activeCustomerIds = new Set(ordersInPeriod.map((o) => o.customerId || o.customerSnapshot?.id).filter(Boolean));
    const activeCustomers = activeCustomerIds.size;

    let priorRevenue = null, priorOrderCount = null, priorAvgOrder = null, priorActiveCustomers = null;
    if (ordersInPriorPeriod) {
      priorRevenue = ordersInPriorPeriod.reduce((s, o) => s + (Number(o.total) || 0), 0);
      priorOrderCount = ordersInPriorPeriod.length;
      priorAvgOrder = priorOrderCount > 0 ? priorRevenue / priorOrderCount : 0;
      const priorIds = new Set(ordersInPriorPeriod.map((o) => o.customerId || o.customerSnapshot?.id).filter(Boolean));
      priorActiveCustomers = priorIds.size;
    }

    return {
      revenue, orderCount, avgOrder, activeCustomers,
      revenueDelta: priorRevenue !== null ? pctChange(revenue, priorRevenue) : null,
      orderCountDelta: priorOrderCount !== null ? pctChange(orderCount, priorOrderCount) : null,
      avgOrderDelta: priorAvgOrder !== null ? pctChange(avgOrder, priorAvgOrder) : null,
      activeCustomersDelta: priorActiveCustomers !== null ? pctChange(activeCustomers, priorActiveCustomers) : null,
    };
  }, [ordersInPeriod, ordersInPriorPeriod]);

  // ----- Monthly revenue (always last 12 months, regardless of period selector) -----
  const monthlyRevenue = useMemo(() => {
    const now = new Date();
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
        label: d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
        start: d,
        end: new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999),
        direct: 0,
        rep: 0,
      });
    }
    for (const o of activeOrders) {
      if (!o.date) continue;
      const d = new Date(o.date + (o.date.length === 10 ? "T00:00:00" : ""));
      if (isNaN(d)) continue;
      const bucket = months.find((m) => d >= m.start && d <= m.end);
      if (!bucket) continue;
      const total = Number(o.total) || 0;
      if (o.salesRepId) bucket.rep += total;
      else bucket.direct += total;
    }
    return months.map((m) => ({ month: m.label, Direct: Math.round(m.direct), "Rep-attributed": Math.round(m.rep) }));
  }, [activeOrders]);

  // ----- Direct vs rep breakdown (current period) -----
  const sourceMix = useMemo(() => {
    const repBuckets = new Map(); // repId -> revenue
    let direct = 0;
    for (const o of ordersInPeriod) {
      const rev = Number(o.total) || 0;
      if (o.salesRepId) {
        repBuckets.set(o.salesRepId, (repBuckets.get(o.salesRepId) || 0) + rev);
      } else {
        direct += rev;
      }
    }
    const result = [];
    if (direct > 0) result.push({ name: "Direct", value: Math.round(direct) });
    for (const [repId, val] of repBuckets) {
      const rep = salesReps.find((r) => r.id === repId);
      const name = rep?.name || ordersInPeriod.find((o) => o.salesRepId === repId)?.salesRepSnapshot?.name || "Unknown rep";
      result.push({ name, value: Math.round(val) });
    }
    return result.sort((a, b) => b.value - a.value);
  }, [ordersInPeriod, salesReps]);

  // ----- Top customers -----
  const topCustomers = useMemo(() => {
    const map = new Map();
    for (const o of ordersInPeriod) {
      const id = o.customerId || o.customerSnapshot?.id;
      if (!id) continue;
      const name = o.customerSnapshot?.name || "Unknown";
      const cur = map.get(id) || { id, name, revenue: 0, orderCount: 0, lastDate: null };
      cur.revenue += Number(o.total) || 0;
      cur.orderCount += 1;
      const orderDate = o.date ? new Date(o.date + (o.date.length === 10 ? "T00:00:00" : "")) : null;
      if (orderDate && (!cur.lastDate || orderDate > cur.lastDate)) cur.lastDate = orderDate;
      map.set(id, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue).slice(0, 10);
  }, [ordersInPeriod]);

  // ----- Top products -----
  const topProducts = useMemo(() => {
    const map = new Map(); // key by description (since products may not all have a productId)
    for (const o of ordersInPeriod) {
      for (const li of (o.lineItems || [])) {
        const key = (li.description || "").split(",")[0].trim() || "(unnamed)";
        const cur = map.get(key) || { name: key, revenue: 0, units: 0, orderCount: 0, _orderIds: new Set() };
        cur.revenue += Number(li.amount) || 0;
        cur.units += (Number(li.quantity) || 0) * (Number(li.packCount) || 1);
        cur._orderIds.add(o.id);
        map.set(key, cur);
      }
    }
    return Array.from(map.values())
      .map((p) => ({ ...p, orderCount: p._orderIds.size }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);
  }, [ordersInPeriod]);

  // Top products as donut (top 5 + Other)
  const productMix = useMemo(() => {
    if (topProducts.length === 0) return [];
    const top5 = topProducts.slice(0, 5);
    const others = topProducts.slice(5).reduce((s, p) => s + p.revenue, 0);
    const result = top5.map((p) => ({ name: p.name, value: Math.round(p.revenue) }));
    if (others > 0) result.push({ name: "Other", value: Math.round(others) });
    return result;
  }, [topProducts]);

  // ----- Sales rep performance (period) -----
  const repPerformance = useMemo(() => {
    const map = new Map();
    for (const o of ordersInPeriod) {
      if (!o.salesRepId) continue;
      const cur = map.get(o.salesRepId) || {
        repId: o.salesRepId,
        repName: o.salesRepSnapshot?.name || "Unknown",
        revenue: 0, orderCount: 0,
      };
      cur.revenue += Number(o.total) || 0;
      cur.orderCount += 1;
      map.set(o.salesRepId, cur);
    }
    return Array.from(map.values())
      .map((r) => ({ ...r, avgOrder: r.orderCount > 0 ? r.revenue / r.orderCount : 0 }))
      .sort((a, b) => b.revenue - a.revenue);
  }, [ordersInPeriod]);

  // ----- Dormant customers (independent of period selector — always relative to "now") -----
  const customerStats = useMemo(() => {
    const map = new Map();
    for (const o of activeOrders) {
      const cid = o.customerId || o.customerSnapshot?.id;
      if (!cid) continue;
      const orderDate = o.date ? new Date(o.date + (o.date.length === 10 ? "T00:00:00" : "")) : null;
      if (!orderDate || isNaN(orderDate)) continue;
      const cur = map.get(cid) || { lastOrderDate: null, totalOrders: 0, totalRevenue: 0 };
      if (!cur.lastOrderDate || orderDate > cur.lastOrderDate) cur.lastOrderDate = orderDate;
      cur.totalOrders += 1;
      cur.totalRevenue += Number(o.total) || 0;
      map.set(cid, cur);
    }
    return map;
  }, [activeOrders]);

  const dormant = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - threshold);
    cutoff.setHours(0, 0, 0, 0);
    const rows = [];
    for (const c of customers) {
      const stats = customerStats.get(c.id);
      if (!stats) {
        if (includeNeverOrdered) {
          rows.push({ customer: c, lastOrderDate: null, daysSince: null, totalOrders: 0, totalRevenue: 0, neverOrdered: true });
        }
        continue;
      }
      if (stats.lastOrderDate < cutoff) {
        const daysSince = Math.floor((Date.now() - stats.lastOrderDate.getTime()) / 86400_000);
        rows.push({ customer: c, lastOrderDate: stats.lastOrderDate, daysSince, totalOrders: stats.totalOrders, totalRevenue: stats.totalRevenue, neverOrdered: false });
      }
    }
    rows.sort((a, b) => {
      if (a.neverOrdered && !b.neverOrdered) return 1;
      if (!a.neverOrdered && b.neverOrdered) return -1;
      if (a.neverOrdered && b.neverOrdered) return (a.customer.name || "").localeCompare(b.customer.name || "");
      return b.daysSince - a.daysSince;
    });
    return rows;
  }, [customers, customerStats, threshold, includeNeverOrdered]);

  const exportDormantCSV = () => {
    const headers = ["Customer", "Customer ID", "Contact", "Email", "Phone", "Last Order Date", "Days Since Last Order", "Total Orders", "Total Revenue"];
    const rows = dormant.map((r) => [
      r.customer.name || "", r.customer.customerId || "", r.customer.contactName || "",
      r.customer.email || "", r.customer.phone || "",
      r.lastOrderDate ? r.lastOrderDate.toISOString().slice(0, 10) : "Never",
      r.daysSince !== null ? r.daysSince : "",
      r.totalOrders, r.totalRevenue.toFixed(2),
    ]);
    downloadCSV(`dormant-customers-${threshold}d-${todayStamp()}.csv`, rowsToCSV(headers, rows));
  };

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
          <p className="text-sm text-stone-500 mt-0.5">Sales metrics for {periodLabel}.</p>
        </div>
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="h-10 px-3 border border-stone-200 rounded text-sm bg-white"
        >
          {REPORT_PERIODS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
      </header>

      {/* ----- KPI cards ----- */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard label="Revenue" value={fmtUSD(kpis.revenue)} delta={kpis.revenueDelta} />
        <KpiCard label="Orders" value={kpis.orderCount.toLocaleString()} delta={kpis.orderCountDelta} />
        <KpiCard label="Avg order value" value={fmtUSD(kpis.avgOrder)} delta={kpis.avgOrderDelta} />
        <KpiCard label="Active customers" value={kpis.activeCustomers.toLocaleString()} delta={kpis.activeCustomersDelta} />
      </div>

      {/* ----- Monthly revenue chart ----- */}
      <Card>
        <h2 className="font-semibold mb-1">Revenue, last 12 months</h2>
        <p className="text-xs text-stone-500 mb-4">
          Stacked bars show direct vs rep-attributed revenue per month.
          Hover any bar for the breakdown.
        </p>
        <div style={{ width: "100%", height: 280 }}>
          <ResponsiveContainer>
            <BarChart data={monthlyRevenue} margin={{ top: 5, right: 10, bottom: 5, left: 0 }}>
              <CartesianGrid stroke="#e7e5e4" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: "#78716c" }} axisLine={{ stroke: "#d6d3d1" }} tickLine={false} />
              <YAxis tick={{ fontSize: 11, fill: "#78716c" }} axisLine={false} tickLine={false} tickFormatter={(v) => v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`} />
              <RTooltip
                cursor={{ fill: "#f5f5f4" }}
                contentStyle={{ fontSize: 12, border: "1px solid #d6d3d1", borderRadius: 4 }}
                formatter={(value) => fmtUSD(value)}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Direct" stackId="a" fill="#1c1917" />
              <Bar dataKey="Rep-attributed" stackId="a" fill="#a8a29e" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* ----- Mix donuts ----- */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <h2 className="font-semibold mb-1">Revenue source ({periodLabel})</h2>
          <p className="text-xs text-stone-500 mb-3">Direct sales vs each sales rep.</p>
          {sourceMix.length === 0 ? (
            <Empty msg="No revenue in this period." />
          ) : (
            <DonutChart data={sourceMix} />
          )}
        </Card>
        <Card>
          <h2 className="font-semibold mb-1">Top products by revenue ({periodLabel})</h2>
          <p className="text-xs text-stone-500 mb-3">Top 5 + others combined.</p>
          {productMix.length === 0 ? (
            <Empty msg="No products sold in this period." />
          ) : (
            <DonutChart data={productMix} />
          )}
        </Card>
      </div>

      {/* ----- Top tables ----- */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <h2 className="font-semibold mb-3">Top customers</h2>
          {topCustomers.length === 0 ? (
            <Empty msg="No customer activity in this period." />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-stone-500 uppercase tracking-wider border-b border-stone-200">
                <tr>
                  <th className="py-2 pr-2 font-medium">Customer</th>
                  <th className="py-2 px-2 font-medium text-right">Orders</th>
                  <th className="py-2 pl-2 font-medium text-right">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {topCustomers.map((c) => (
                  <tr key={c.id}>
                    <td className="py-2 pr-2 font-medium truncate max-w-[200px]" title={c.name}>{c.name}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{c.orderCount}</td>
                    <td className="py-2 pl-2 text-right tabular-nums font-medium">{fmtUSD(c.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card>
          <h2 className="font-semibold mb-3">Top products</h2>
          {topProducts.length === 0 ? (
            <Empty msg="No products sold in this period." />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-stone-500 uppercase tracking-wider border-b border-stone-200">
                <tr>
                  <th className="py-2 pr-2 font-medium">Product</th>
                  <th className="py-2 px-2 font-medium text-right">Orders</th>
                  <th className="py-2 px-2 font-medium text-right">Units</th>
                  <th className="py-2 pl-2 font-medium text-right">Revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {topProducts.map((p, i) => (
                  <tr key={i}>
                    <td className="py-2 pr-2 font-medium truncate max-w-[180px]" title={p.name}>{p.name}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{p.orderCount}</td>
                    <td className="py-2 px-2 text-right tabular-nums">{p.units}</td>
                    <td className="py-2 pl-2 text-right tabular-nums font-medium">{fmtUSD(p.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      {/* ----- Sales rep performance ----- */}
      {repPerformance.length > 0 && (
        <Card>
          <h2 className="font-semibold mb-3">Sales rep performance ({periodLabel})</h2>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-stone-500 uppercase tracking-wider border-b border-stone-200">
              <tr>
                <th className="py-2 pr-2 font-medium">Rep</th>
                <th className="py-2 px-2 font-medium text-right">Orders</th>
                <th className="py-2 px-2 font-medium text-right">Avg order</th>
                <th className="py-2 pl-2 font-medium text-right">Revenue</th>
                <th className="py-2 pl-4 font-medium text-right">% of total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {repPerformance.map((r) => (
                <tr key={r.repId}>
                  <td className="py-2 pr-2 font-medium">{r.repName}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{r.orderCount}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{fmtUSD(r.avgOrder)}</td>
                  <td className="py-2 pl-2 text-right tabular-nums font-medium">{fmtUSD(r.revenue)}</td>
                  <td className="py-2 pl-4 text-right tabular-nums text-stone-500">
                    {kpis.revenue > 0 ? `${((r.revenue / kpis.revenue) * 100).toFixed(1)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* ----- Dormant customers (existing) ----- */}
      <Card>
        <div className="flex items-end justify-between gap-3 mb-4 flex-wrap">
          <div>
            <h2 className="font-semibold">Reorder follow-up</h2>
            <p className="text-xs text-stone-500 mt-0.5">
              Customers who haven't ordered recently. Useful for proactive outreach before they buy from a competitor.
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <select
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="h-10 px-3 border border-stone-200 rounded text-sm bg-white"
            >
              {DORMANT_THRESHOLDS.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-xs text-stone-600 px-2 cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={includeNeverOrdered}
                onChange={(e) => setIncludeNeverOrdered(e.target.checked)}
              />
              Include never-ordered
            </label>
            <button
              onClick={exportDormantCSV}
              disabled={dormant.length === 0}
              className="px-3 py-2 border border-stone-300 text-sm rounded hover:bg-stone-50 flex items-center gap-1.5 disabled:opacity-40"
            >
              <Download className="w-4 h-4" /> Export CSV
            </button>
          </div>
        </div>

        {dormant.length === 0 ? (
          <Empty msg={
            customers.length === 0
              ? "No customers yet."
              : `Great — every customer has ordered within the last ${threshold} days.`
          } />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-stone-500 uppercase tracking-wider border-b border-stone-200">
                <tr>
                  <th className="py-2 pr-4 font-medium">Customer</th>
                  <th className="py-2 pr-4 font-medium">Contact</th>
                  <th className="py-2 pr-4 font-medium">Last order</th>
                  <th className="py-2 pr-4 font-medium text-right">Days since</th>
                  <th className="py-2 pr-4 font-medium text-right">Past orders</th>
                  <th className="py-2 pr-4 font-medium text-right">Lifetime revenue</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100">
                {dormant.map((r) => (
                  <tr key={r.customer.id}>
                    <td className="py-2.5 pr-4">
                      <div className="font-medium">{r.customer.name}</div>
                      {r.customer.customerId && <div className="text-xs text-stone-500 font-mono">#{r.customer.customerId}</div>}
                    </td>
                    <td className="py-2.5 pr-4">
                      {r.customer.contactName && <div>{r.customer.contactName}</div>}
                      <div className="text-xs text-stone-500">
                        {[r.customer.email, r.customer.phone].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td className="py-2.5 pr-4 text-stone-600">
                      {r.neverOrdered ? (
                        <span className="text-xs uppercase tracking-wider text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">Never ordered</span>
                      ) : (
                        r.lastOrderDate.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
                      )}
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">
                      {r.daysSince !== null ? (
                        <span className={r.daysSince >= 90 ? "text-red-700 font-medium" : r.daysSince >= 60 ? "text-amber-700" : ""}>
                          {r.daysSince}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{r.totalOrders}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{fmtUSD(r.totalRevenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {dormant.length > 0 && (
          <div className="mt-4 pt-3 border-t border-stone-200 text-xs text-stone-500">
            Showing <span className="font-medium text-stone-700">{dormant.length}</span> customer{dormant.length === 1 ? "" : "s"} who haven't ordered in {threshold}+ days{includeNeverOrdered ? " (including never-ordered)" : ""}.
          </div>
        )}
      </Card>
    </div>
  );
}

/* ---------- Reusable KPI card with optional vs-prior delta ---------- */

function KpiCard({ label, value, delta }) {
  let deltaUI = null;
  if (delta !== null && delta !== undefined) {
    const pct = Math.abs(delta).toFixed(1);
    if (Math.abs(delta) < 0.5) {
      deltaUI = (
        <span className="text-xs text-stone-500 flex items-center gap-1">
          <Minus className="w-3 h-3" /> flat vs prior
        </span>
      );
    } else if (delta > 0) {
      deltaUI = (
        <span className="text-xs text-emerald-700 flex items-center gap-1">
          <TrendingUp className="w-3 h-3" /> {pct}% vs prior
        </span>
      );
    } else {
      deltaUI = (
        <span className="text-xs text-red-700 flex items-center gap-1">
          <TrendingDown className="w-3 h-3" /> {pct}% vs prior
        </span>
      );
    }
  }
  return (
    <Card>
      <div className="text-xs uppercase tracking-wider text-stone-500 font-medium">{label}</div>
      <div className="text-2xl font-semibold tracking-tight mt-1 tabular-nums">{value}</div>
      <div className="mt-1 h-4">{deltaUI}</div>
    </Card>
  );
}

/* ---------- Reusable donut chart with side legend ---------- */

function DonutChart({ data }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <div className="flex items-center gap-4 flex-wrap">
      <div style={{ width: 180, height: 180, flexShrink: 0 }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={45}
              outerRadius={80}
              paddingAngle={1}
            >
              {data.map((entry, i) => (
                <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
              ))}
            </Pie>
            <RTooltip
              contentStyle={{ fontSize: 12, border: "1px solid #d6d3d1", borderRadius: 4 }}
              formatter={(value) => fmtUSD(value)}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="flex-1 min-w-0 text-sm space-y-1.5">
        {data.map((d, i) => {
          const pct = total > 0 ? (d.value / total) * 100 : 0;
          return (
            <div key={i} className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded shrink-0" style={{ background: CHART_COLORS[i % CHART_COLORS.length] }} />
              <span className="flex-1 truncate min-w-0" title={d.name}>{d.name}</span>
              <span className="tabular-nums text-stone-500 text-xs">{pct.toFixed(0)}%</span>
              <span className="tabular-nums font-medium w-20 text-right">{fmtUSD(d.value)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SettingsView({ company, fedex, counters, customers, products, orders, onSaveCompany, onSaveFedex, onSaveCounters }) {
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

      <BackupCard
        company={company}
        fedex={fedex}
        counters={counters}
        customers={customers}
        products={products}
        orders={orders}
      />

      <SalesRepsCard
        reps={c.salesReps || []}
        onChange={(reps) => {
          const next = { ...c, salesReps: reps };
          setC(next);
          onSaveCompany(next);
        }}
      />

      <PackagePresetsCard
        presets={c.packagePresets || []}
        onChange={(presets) => {
          const next = { ...c, packagePresets: presets };
          setC(next);
          onSaveCompany(next);
        }}
      />

      <EmailTemplatesCard
        company={c}
        onChange={(patch) => {
          const next = { ...c, ...patch };
          setC(next);
          onSaveCompany(next);
        }}
      />

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
              <td className="py-2 px-2 text-right">${Number.isInteger(Number(it.unitPriceNum)) ? Number(it.unitPriceNum) : Number(it.unitPriceNum).toFixed(2)}/{(it.unit || "g").toLowerCase().slice(0,1)}</td>
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
  // `quantity` already represents the total grams across all packs in this line item.
  // Don't multiply by packCount — that double-counts.
  const totalGrams = order.lineItems.reduce((s, x) => s + (Number(x.quantity) || 0), 0);

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
            const total = Number(it.quantity) || 0;
            return (
              <tr key={it.id}>
                <td className="border border-stone-700 py-2 px-2">{stripPackInfo(it.description)}</td>
                <td className="border border-stone-700 py-2 px-2 font-mono text-[9pt]">{it.batchNumber}</td>
                <td className="border border-stone-700 py-2 px-2">{it.packSize || `${unit}`}</td>
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

/**
 * Returns the available pack sizes for a product. Always returns an array
 * (possibly empty). A product can have one size or many — the array shape
 * is the same either way.
 */
function productPackSizes(product) {
  if (!product || !Array.isArray(product.packSizes)) return [];
  return product.packSizes.filter(Boolean);
}

/**
 * Build the line item description from product name + pack count + pack size.
 * "GHK-CU" + 10 packs of "5g Bottle" → "GHK-CU, 10x5g Bottle"
 * If pack count is 1 or missing, just "GHK-CU, 5g Bottle".
 * If pack size is missing, just the product name.
 */
function buildLineDescription(productName, packCount, packSize) {
  const name = (productName || "").trim();
  const size = (packSize || "").trim();
  const count = Number(packCount) || 0;
  if (!name) return "";
  if (!size) return name;
  if (count > 1) return `${name}, ${count}x${size}`;
  return `${name}, ${size}`;
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
