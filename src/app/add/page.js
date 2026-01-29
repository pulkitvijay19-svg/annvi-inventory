"use client";

import { useEffect, useMemo, useState } from "react";
import QRCode from "react-qr-code";
import { supabase } from "@/lib/supabaseClient";
import { useRequireLogin, doLogout } from "@/lib/useRequireLogin";
import { useRouter } from "next/navigation";

const STORAGE_KEY = "annvi_items_v1";
const ITEMS_BUCKET = "item-images";
const PAGE_SIZE = 30;

// ✅ Category list
const CATEGORIES = [
  "Ladies Rings",
  "Gents Rings",
  "Earrings",
  "Baby tops",
  "Pendant",
  "Pendant set",
  "Har set",
  "Bali",
  "Bangles",
  "Bracelet",
  "Kada",
  "Mangalsutra",
  "Nosepin",
  "Others",
];

// ------- IMAGE COMPRESS HELPER (~100 KB target) -------
async function compressImage(file, maxWidth = 900, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      const canvas = document.createElement("canvas");

      const ratio = img.width > maxWidth ? maxWidth / img.width : 1;
      const w = img.width * ratio;
      const h = img.height * ratio;

      canvas.width = w;
      canvas.height = h;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas context not available"));
        return;
      }

      ctx.drawImage(img, 0, 0, w, h);

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(new Error("Image compression failed"));
            return;
          }

          if (blob.size > 150 * 1024 && quality > 0.4) {
            compressImage(file, maxWidth, quality - 0.1)
              .then(resolve)
              .catch(reject);
          } else {
            resolve(blob);
          }
        },
        "image/jpeg",
        quality
      );
    };

    img.onerror = reject;

    const reader = new FileReader();
    reader.onload = (e) => {
      img.src = e.target && e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// --------------- ID HELPERS ----------------
function pad6(n) {
  return String(n).padStart(6, "0");
}

function getYear2() {
  const y = new Date().getFullYear();
  return String(y).slice(-2);
}

function loadItems() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveItems(items) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
}

function nextItemId(items) {
  const yy = getYear2();
  const yearItems = items.filter((x) => x.itemId?.startsWith(`AG-${yy}-`));
  const next = yearItems.length + 1;
  return `AG-${yy}-${pad6(next)}`;
}

// ---------- CLOUD HELPERS (Supabase) ----------
function normalizeImageUrls(r) {
  const arr = Array.isArray(r.image_urls) ? r.image_urls : [];
  if (arr.length > 0) return arr.filter(Boolean);
  if (r.image_url) return [r.image_url];
  return [];
}

function toCloudRow(localItem) {
  const imageUrls = Array.isArray(localItem.imageUrls) ? localItem.imageUrls : [];
  return {
    item_id: localItem.itemId,
    design_no: localItem.designNo,
    category: localItem.category || null,
    karat: localItem.karat,
    gross_wt: Number(localItem.grossWt || 0),
    less_wt: Number(localItem.lessWt || 0),
    net_wt: Number(localItem.netWt || 0),
    notes: localItem.notes || "",
    status: localItem.status,
    image_url: imageUrls[0] || null,
    image_urls: imageUrls,
    created_at: localItem.createdAt,
    updated_at: localItem.updatedAt,
  };
}

async function cloudUpsertItem(localItem) {
  const row = toCloudRow(localItem);
  const { error } = await supabase.from("items").upsert(row, { onConflict: "item_id" });
  if (error) throw error;
}

async function cloudUpdateStatus(itemId, status, updatedAtISO) {
  const { error } = await supabase
    .from("items")
    .update({ status, updated_at: updatedAtISO })
    .eq("item_id", itemId);
  if (error) throw error;
}

async function cloudUpdateItem(itemId, patch) {
  const { error } = await supabase.from("items").update(patch).eq("item_id", itemId);
  if (error) throw error;
}

async function cloudLogEvent({ itemId, action, actor, place }) {
  try {
    await supabase.from("events").insert({
      item_id: itemId,
      action,
      actor,
      place,
      created_at: new Date().toISOString(),
    });
  } catch {
    // ignore
  }
}

async function cloudPullLatestAndMerge() {
  const { data, error } = await supabase
    .from("items")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(800);

  if (error) throw error;

  const cloudItems = (data || []).map((r) => {
    const imageUrls = normalizeImageUrls(r);
    return {
      itemId: r.item_id,
      designNo: r.design_no,
      category: r.category ?? "",
      karat: r.karat,
      grossWt: String(r.gross_wt ?? ""),
      lessWt: String(r.less_wt ?? ""),
      netWt: String(r.net_wt ?? ""),
      notes: r.notes ?? "",
      status: r.status ?? "IN_STOCK",
      imageUrls,
      createdAt: r.created_at ?? new Date().toISOString(),
      updatedAt: r.updated_at ?? new Date().toISOString(),
    };
  });

  const byId = new Map();
  for (const x of loadItems()) byId.set(x.itemId, x);

  for (const c of cloudItems) {
    const existing = byId.get(c.itemId);
    if (!existing) {
      byId.set(c.itemId, c);
    } else {
      const a = new Date(existing.updatedAt || 0).getTime();
      const b = new Date(c.updatedAt || 0).getTime();
      if (b >= a) byId.set(c.itemId, c);
    }
  }

  return Array.from(byId.values()).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
  );
}

async function cloudDeleteItem(itemId) {
  const { error } = await supabase.from("items").delete().eq("item_id", itemId);
  if (error) throw error;
}

async function cloudDeleteAllItems() {
  const { error } = await supabase.from("items").delete().neq("item_id", "");
  if (error) throw error;
}

// ----------- TAG PREVIEW HELPER (single) -----------
function openTagPreview(item) {
  if (typeof window === "undefined") return;

  const url = new URL("/tag-preview", window.location.origin);
  url.searchParams.set("itemId", item.itemId);
  url.searchParams.set("designNo", item.designNo || "");
  url.searchParams.set("karat", item.karat || "22K");
  url.searchParams.set("grossWt", item.grossWt || "");
  url.searchParams.set("lessWt", item.lessWt || "0.000");
  url.searchParams.set("netWt", item.netWt || "");

  window.open(url.toString(), "_blank", "width=900,height=400");
}

// ✅ BULK TAG PRINT helper
function openBulkTags(ids) {
  if (typeof window === "undefined") return;
  const url = new URL("/tag-bulk", window.location.origin);
  url.searchParams.set("ids", ids.join(","));
  window.open(url.toString(), "_blank");
}

export default function AddPage() {
  useRequireLogin();
  const router = useRouter();

  const [items, setItems] = useState([]);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [qrOpen, setQrOpen] = useState(null);

  const [cloudMsg, setCloudMsg] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);

  const [form, setForm] = useState({
    designNo: "",
    category: CATEGORIES[0],
    karat: "22K",
    grossWt: "",
    lessWt: "",
    notes: "",
  });

  // multiple photos
  const [photoFiles, setPhotoFiles] = useState([]);
  const [photoPreviews, setPhotoPreviews] = useState([]);

  // image zoom modal
  const [imageOpenUrl, setImageOpenUrl] = useState(null);

  // Edit mode
  const [editingId, setEditingId] = useState(null);

  // Load more
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Scan / paste itemID quick filter
  const [scanId, setScanId] = useState("");

  // ✅ BULK selection
  const [selectedIds, setSelectedIds] = useState(new Set());

  useEffect(() => {
    let cancelled = false;

    async function init() {
      const local = loadItems();
      setItems(local);

      setCloudBusy(true);
      setCloudMsg("Syncing with cloud...");

      try {
        const merged = await cloudPullLatestAndMerge();
        if (!cancelled) {
          setItems(merged);
          setCloudMsg("Cloud sync done ✅");
        }
      } catch {
        if (!cancelled) {
          setCloudMsg("Cloud sync failed ⚠ – showing local data.");
        }
      } finally {
        if (!cancelled) {
          setCloudBusy(false);
          setTimeout(() => setCloudMsg(""), 2500);
        }
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    saveItems(items);
  }, [items]);

  const netWt = useMemo(() => {
    const g = parseFloat(form.grossWt);
    const l = parseFloat(form.lessWt);
    if (Number.isNaN(g)) return "";
    if (Number.isNaN(l)) return g.toFixed(3);
    return (g - l).toFixed(3);
  }, [form.grossWt, form.lessWt]);

  function update(key, value) {
    setForm((p) => ({ ...p, [key]: value }));
  }

  function resetPhotosUI() {
    setPhotoFiles([]);
    setPhotoPreviews((old) => {
      for (const u of old) {
        try {
          URL.revokeObjectURL(u);
        } catch {}
      }
      return [];
    });

    const inputEl = document.getElementById("itemPhotosInput");
    if (inputEl) inputEl.value = "";
  }

  function onPhotosChange(e) {
    const files = Array.from(e.target.files || []);
    setPhotoFiles(files);

    setPhotoPreviews((old) => {
      for (const u of old) {
        try {
          URL.revokeObjectURL(u);
        } catch {}
      }
      return files.map((f) => URL.createObjectURL(f));
    });
  }

  async function uploadPhotosForItem(itemId, files) {
    const urls = [];
    let idx = 0;

    for (const f of files) {
      const compressed = await compressImage(f);

      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const path = `items/${itemId}/${ts}_${rand}_${idx}.jpg`;

      const { error: uploadError } = await supabase.storage.from(ITEMS_BUCKET).upload(path, compressed, {
        upsert: false,
        contentType: "image/jpeg",
      });

      if (!uploadError) {
        const { data } = supabase.storage.from(ITEMS_BUCKET).getPublicUrl(path);
        const baseUrl = (data && data.publicUrl) || "";
        const url = baseUrl ? `${baseUrl}?v=${ts}` : "";
        if (url) urls.push(url);
      } else {
        console.error(uploadError);
      }

      idx++;
    }

    return urls;
  }

  function startEdit(item) {
    setEditingId(item.itemId);
    setForm({
      designNo: item.designNo || "",
      category: item.category || CATEGORIES[0],
      karat: item.karat || "22K",
      grossWt: item.grossWt || "",
      lessWt: item.lessWt || "",
      notes: item.notes || "",
    });
    resetPhotosUI();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm({
      designNo: "",
      category: CATEGORIES[0],
      karat: form.karat || "22K",
      grossWt: "",
      lessWt: "",
      notes: "",
    });
    resetPhotosUI();
  }

  async function onSave(e) {
    e.preventDefault();
    const now = new Date().toISOString();

    // ✅ edit
    if (editingId) {
      const itemId = editingId;

      const patchLocal = {
        designNo: form.designNo.trim(),
        category: form.category,
        karat: form.karat,
        grossWt: form.grossWt.trim(),
        lessWt: form.lessWt.trim() || "0",
        netWt,
        notes: form.notes.trim(),
        updatedAt: now,
      };

      setItems((prev) => prev.map((x) => (x.itemId === itemId ? { ...x, ...patchLocal } : x)));

      setCloudBusy(true);
      setCloudMsg(`Updating ${itemId}...`);
      try {
        let newUrls = [];
        if (photoFiles.length > 0) {
          setCloudMsg("Uploading new photos...");
          newUrls = await uploadPhotosForItem(itemId, photoFiles);
        }

        const current = items.find((x) => x.itemId === itemId);
        const existingUrls = Array.isArray(current?.imageUrls) ? current.imageUrls : [];
        const mergedUrls = [...existingUrls, ...newUrls].filter(Boolean);

        await cloudUpdateItem(itemId, {
          design_no: patchLocal.designNo,
          category: patchLocal.category,
          karat: patchLocal.karat,
          gross_wt: Number(patchLocal.grossWt || 0),
          less_wt: Number(patchLocal.lessWt || 0),
          net_wt: Number(patchLocal.netWt || 0),
          notes: patchLocal.notes,
          image_urls: mergedUrls,
          image_url: mergedUrls[0] || null,
          updated_at: now,
        });

        setItems((prev) =>
          prev.map((x) => (x.itemId === itemId ? { ...x, imageUrls: mergedUrls, updatedAt: now } : x))
        );

        await cloudLogEvent({ itemId, action: "EDIT", actor: "Factory", place: "Local" });

        setCloudMsg(`Updated ✅ (${itemId})`);
        cancelEdit();
      } catch (err) {
        console.error(err);
        setCloudMsg(`Update failed ⚠ (${itemId}) — check net/RLS`);
      } finally {
        setCloudBusy(false);
        setTimeout(() => setCloudMsg(""), 2500);
      }
      return;
    }

    // ✅ create
    const itemId = nextItemId(items);

    const payload = {
      itemId,
      designNo: form.designNo.trim(),
      category: form.category,
      karat: form.karat,
      grossWt: form.grossWt.trim(),
      lessWt: form.lessWt.trim() || "0",
      netWt,
      notes: form.notes.trim(),
      status: "IN_STOCK",
      imageUrls: [],
      createdAt: now,
      updatedAt: now,
    };

    setItems((prev) => [payload, ...prev]);

    setForm({
      designNo: "",
      category: form.category,
      karat: form.karat,
      grossWt: "",
      lessWt: "",
      notes: "",
    });

    resetPhotosUI();

    setCloudBusy(true);
    setCloudMsg("Saving to cloud...");
    try {
      await cloudUpsertItem(payload);
      await cloudLogEvent({ itemId, action: "CREATE", actor: "Factory", place: "Local" });

      if (photoFiles.length > 0) {
        setCloudMsg("Uploading photos...");
        const urls = await uploadPhotosForItem(itemId, photoFiles);

        if (urls.length > 0) {
          await cloudUpdateItem(itemId, {
            image_urls: urls,
            image_url: urls[0] || null,
            updated_at: new Date().toISOString(),
          });

          setItems((prev) => prev.map((x) => (x.itemId === itemId ? { ...x, imageUrls: urls } : x)));

          setCloudMsg(`Saved + photos uploaded ✅ (${itemId})`);
        } else {
          setCloudMsg(`Saved ✅ (${itemId}) (photos failed/skipped)`);
        }
      } else {
        setCloudMsg(`Cloud saved ✅ (${itemId})`);
      }
    } catch (err) {
      console.error(err);
      setCloudMsg(`Cloud failed/offline ⚠️ (${itemId}) — local saved`);
    } finally {
      setCloudBusy(false);
      setTimeout(() => setCloudMsg(""), 2500);
    }
  }

  async function setStatus(itemId, status) {
    const now = new Date().toISOString();

    setItems((prev) => prev.map((x) => (x.itemId === itemId ? { ...x, status, updatedAt: now } : x)));

    setCloudBusy(true);
    setCloudMsg("Syncing status to cloud...");
    try {
      await cloudUpdateStatus(itemId, status, now);
      await cloudLogEvent({
        itemId,
        action: status === "SOLD" ? "SOLD" : status === "RETURNED" ? "RETURN" : "IN",
        actor: "Factory",
        place: "Local",
      });
      setCloudMsg(`Status synced ✅ (${itemId})`);
    } catch {
      setCloudMsg(`Cloud sync failed ⚠️ (${itemId}) — local updated`);
    } finally {
      setCloudBusy(false);
      setTimeout(() => setCloudMsg(""), 2500);
    }
  }

  async function deleteItem(itemId) {
    const ok1 = confirm(`Delete item ${itemId} from stock?`);
    if (!ok1) return;
    const ok2 = confirm("Pakka? Ye cloud se bhi delete karega.");
    if (!ok2) return;

    setItems((prev) => prev.filter((x) => x.itemId !== itemId));

    setCloudBusy(true);
    setCloudMsg(`Deleting ${itemId} from cloud...`);

    try {
      await cloudDeleteItem(itemId);
      setCloudMsg(`Deleted ${itemId} (local + cloud)`);
      if (editingId === itemId) cancelEdit();

      // ✅ also remove from bulk selection
      setSelectedIds((prev) => {
        const n = new Set(prev);
        n.delete(itemId);
        return n;
      });
    } catch {
      setCloudMsg(`Local deleted; cloud delete failed ⚠ (${itemId}) – Supabase RLS / net check karo.`);
    } finally {
      setCloudBusy(false);
      setTimeout(() => setCloudMsg(""), 3000);
    }
  }

  async function deletePhotoUrl(itemId, urlToRemove) {
    const ok = confirm("Remove this photo from item?");
    if (!ok) return;

    const now = new Date().toISOString();

    const current = items.find((x) => x.itemId === itemId);
    const existing = Array.isArray(current?.imageUrls) ? current.imageUrls : [];
    const nextUrls = existing.filter((u) => u !== urlToRemove);

    setItems((prev) =>
      prev.map((x) => (x.itemId === itemId ? { ...x, imageUrls: nextUrls, updatedAt: now } : x))
    );

    setCloudBusy(true);
    setCloudMsg("Updating photos...");
    try {
      await cloudUpdateItem(itemId, {
        image_urls: nextUrls,
        image_url: nextUrls[0] || null,
        updated_at: now,
      });
      setCloudMsg("Photo removed ✅");
    } catch (err) {
      console.error(err);
      setCloudMsg("Photo remove failed ⚠");
    } finally {
      setCloudBusy(false);
      setTimeout(() => setCloudMsg(""), 2000);
    }
  }

  async function clearAll() {
    const a = confirm("Ye action sab items delete karega (LOCAL + CLOUD). Mostly testing ke liye. Continue?");
    if (!a) return;
    const b = confirm("Pakka 100% sure? Ye undo nahi hoga.");
    if (!b) return;

    setItems([]);
    localStorage.removeItem(STORAGE_KEY);

    setCloudBusy(true);
    setCloudMsg("Deleting ALL items from cloud...");

    try {
      await cloudDeleteAllItems();
      setCloudMsg("All items deleted from cloud ✅");
      cancelEdit();
      setSelectedIds(new Set());
    } catch {
      setCloudMsg("Local cleared. Cloud delete failed ⚠ – Supabase RLS / net check karo.");
    } finally {
      setCloudBusy(false);
      setTimeout(() => setCloudMsg(""), 3500);
    }
  }

  async function refreshFromCloud() {
    setCloudBusy(true);
    setCloudMsg("Refreshing from cloud...");
    try {
      const merged = await cloudPullLatestAndMerge();
      setItems(merged);
      setCloudMsg("Cloud refresh ✅");
    } catch {
      setCloudMsg("Cloud refresh failed ⚠️ (check net / RLS)");
    } finally {
      setCloudBusy(false);
      setTimeout(() => setCloudMsg(""), 2500);
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    return items.filter((x) => {
      const matchQuery =
        !q ||
        (x.itemId || "").toLowerCase().includes(q) ||
        String(x.designNo || "").toLowerCase().includes(q);

      const matchCat = categoryFilter === "ALL" || (x.category || "") === categoryFilter;
      return matchQuery && matchCat;
    });
  }, [items, query, categoryFilter]);

  const counts = useMemo(() => {
    const c = { IN_STOCK: 0, SOLD: 0, RETURNED: 0 };
    for (const x of items) c[x.status] = (c[x.status] || 0) + 1;
    return c;
  }, [items]);

  const visibleItems = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query, categoryFilter, items.length]);

  function onGoScan() {
    const id = scanId.trim();
    if (!id) return;
    setQuery(id);
    setScanId("");
  }

  // ✅ BULK helpers
  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function selectAllFiltered() {
    setSelectedIds(new Set(filtered.map((x) => x.itemId)));
  }

  function printSelected() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      alert("Koi item select nahi hai");
      return;
    }
    openBulkTags(ids);
  }

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-md px-4 py-8">
        {/* Add Piece Card */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-sm">
          <div className="mb-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm tracking-widest text-white/70">ANNVI GOLD</div>
                <h1 className="mt-1 text-2xl font-semibold">{editingId ? "Edit Piece" : "Add Piece"}</h1>
                <p className="mt-1 text-sm text-white/60">ItemID auto + offline local save + QR (+ Cloud)</p>

                {cloudMsg ? (
                  <div className="mt-2 text-xs text-white/60">
                    {cloudBusy ? "⏳ " : "✅ "}
                    {cloudMsg}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => doLogout(router)}
                  className="rounded-lg border border-white/20 bg-black/30 px-3 py-2 text-xs text-white/70 hover:border-white/40"
                >
                  Logout
                </button>

                <button
                  onClick={refreshFromCloud}
                  className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-xs text-white/70 hover:border-white/30"
                  type="button"
                >
                  Refresh Cloud
                </button>

                <button
                  onClick={clearAll}
                  className="rounded-lg border border-red-500/50 bg-black/30 px-3 py-2 text-xs text-red-200 hover:border-red-500/80"
                  type="button"
                >
                  Clear Data (ALL)
                </button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
              <div className="rounded-xl border border-white/10 bg-black/30 p-2">
                <div className="text-white/50">IN</div>
                <div className="text-lg font-semibold">{counts.IN_STOCK}</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/30 p-2">
                <div className="text-white/50">SOLD</div>
                <div className="text-lg font-semibold">{counts.SOLD}</div>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/30 p-2">
                <div className="text-white/50">RET</div>
                <div className="text-lg font-semibold">{counts.RETURNED}</div>
              </div>
            </div>
          </div>

          <form onSubmit={onSave} className="space-y-4">
            {!editingId ? (
              <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-white/70">Next ItemID</div>
                  <div className="font-semibold">{nextItemId(items)}</div>
                </div>
                <div className="mt-1 text-xs text-white/45">Format: AG-YY-000001</div>
              </div>
            ) : (
              <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm text-white/70">Editing ItemID</div>
                  <div className="font-semibold">{editingId}</div>
                </div>
                <div className="mt-2 flex gap-2">
                  <button
                    type="button"
                    onClick={cancelEdit}
                    className="rounded-lg border border-white/15 bg-black/30 px-3 py-1.5 text-xs text-white/70 hover:border-white/30"
                  >
                    Cancel Edit
                  </button>
                </div>
              </div>
            )}

            <div>
              <label className="text-sm text-white/70">Category</label>
              <select
                value={form.category}
                onChange={(e) => update("category", e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-sm text-white/70">Design No</label>
              <input
                value={form.designNo}
                onChange={(e) => update("designNo", e.target.value)}
                placeholder="e.g. 8123"
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
                required
              />
            </div>

            <div>
              <label className="text-sm text-white/70">Karat</label>
              <select
                value={form.karat}
                onChange={(e) => update("karat", e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
              >
                <option>22K</option>
                <option>20K</option>
                <option>18K</option>
                <option>14K</option>
                <option>9K</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-white/70">Gross Wt (g)</label>
                <input
                  value={form.grossWt}
                  onChange={(e) => update("grossWt", e.target.value)}
                  placeholder="e.g. 3.540"
                  inputMode="decimal"
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
                  required
                />
              </div>

              <div>
                <label className="text-sm text-white/70">Less Wt / Stone (g)</label>
                <input
                  value={form.lessWt}
                  onChange={(e) => update("lessWt", e.target.value)}
                  placeholder="e.g. 0.300"
                  inputMode="decimal"
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
                />
              </div>
            </div>

            <div className="rounded-xl border border-white/10 bg-black/30 p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm text-white/70">Net Weight (auto)</div>
                <div className="text-xl font-semibold">{netWt === "" ? "—" : `${netWt} g`}</div>
              </div>
              <div className="mt-1 text-xs text-white/50">Net = Gross − Less</div>
            </div>

            <div>
              <label className="text-sm text-white/70">Notes (optional)</label>
              <input
                value={form.notes}
                onChange={(e) => update("notes", e.target.value)}
                placeholder="optional"
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
              />
            </div>

            <div>
              <label className="text-sm text-white/70">Photos (optional, multiple) — add more in Edit also</label>
              <input
                id="itemPhotosInput"
                type="file"
                accept="image/*;capture=camera"
                multiple
                onChange={onPhotosChange}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs outline-none file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-1 file:text-xs file:font-semibold file:text-black hover:border-white/30"
              />

              {photoPreviews.length > 0 ? (
                <div className="mt-2 grid grid-cols-5 gap-2">
                  {photoPreviews.map((u, idx) => (
                    <div key={u} className="h-14 w-14 overflow-hidden rounded-lg border border-white/15 bg-black/40">
                      <img src={u} alt={`p${idx}`} className="h-full w-full object-cover" />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <button type="submit" className="w-full rounded-xl bg-white px-4 py-2 font-semibold text-black hover:bg-white/90">
              {editingId ? "Update Piece" : "Save Piece (offline)"}
            </button>
          </form>
        </div>

        {/* Saved Pieces */}
        <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Saved Pieces</h2>
            </div>

            {/* ✅ BULK BAR */}
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={printSelected}
                className="rounded-xl bg-white px-3 py-2 text-xs font-semibold text-black hover:bg-white/90"
              >
                Print Selected ({selectedIds.size})
              </button>
              <button
                type="button"
                onClick={selectAllFiltered}
                className="rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-xs font-semibold text-white/80 hover:border-white/30"
              >
                Select All (Filtered)
              </button>
              <button
                type="button"
                onClick={clearSelection}
                className="rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-xs font-semibold text-white/80 hover:border-white/30"
              >
                Clear
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search ItemID / Design"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
              />

              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
              >
                <option value="ALL">All Categories</option>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-[1fr_auto] gap-2">
              <input
                value={scanId}
                onChange={(e) => setScanId(e.target.value)}
                placeholder="Scan / Paste ItemID (AG-26-000123)"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
              />
              <button
                type="button"
                onClick={onGoScan}
                className="rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-white/90"
              >
                Go
              </button>
            </div>
          </div>

          <div className="mt-3 space-y-3">
            {visibleItems.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-white/60">No items yet.</div>
            ) : (
              visibleItems.map((x) => {
                const imageUrls = Array.isArray(x.imageUrls) ? x.imageUrls : [];
                const firstImg = imageUrls[0] || "";

                return (
                  <div key={x.itemId} className="rounded-2xl border border-white/10 bg-black/30 p-3">
                    <div className="flex items-start justify-between gap-3">
                      {/* LEFT SIDE */}
                      <div className="flex-1">
                        {/* ✅ checkbox */}
                        <label className="mb-2 inline-flex items-center gap-2 text-xs text-white/70">
                          <input
                            type="checkbox"
                            checked={selectedIds.has(x.itemId)}
                            onChange={() => toggleSelect(x.itemId)}
                          />
                          Select for bulk print
                        </label>

                        <div className="text-sm text-white/60">ItemID</div>
                        <div className="text-lg font-semibold">{x.itemId}</div>

                        <div className="mt-1 text-xs text-white/60">
                          Category: <span className="font-semibold text-white/80">{x.category || "—"}</span>
                        </div>

                        <div className="mt-1 text-sm text-white/70">
                          D:{x.designNo} | {x.karat} | N:{x.netWt}g
                        </div>

                        <div className="mt-1 text-xs text-white/45">
                          Status: <span className="font-semibold text-white/70">{x.status}</span>
                        </div>

                        <div className="mt-2 flex flex-wrap gap-2 text-xs">
                          <button
                            type="button"
                            onClick={() => setStatus(x.itemId, "SOLD")}
                            className="rounded-lg bg-white px-3 py-1.5 font-semibold text-black hover:bg-white/90"
                          >
                            SOLD
                          </button>
                          <button
                            type="button"
                            onClick={() => setStatus(x.itemId, "RETURNED")}
                            className="rounded-lg border border-white/20 bg-transparent px-3 py-1.5 font-semibold text-white/80 hover:border-white/40"
                          >
                            RETURN
                          </button>
                          <button
                            type="button"
                            onClick={() => setStatus(x.itemId, "IN_STOCK")}
                            className="rounded-lg border border-white/10 bg-black/40 px-3 py-1.5 text-white/70 hover:border-white/30"
                          >
                            IN
                          </button>

                          <button
                            type="button"
                            onClick={() => startEdit(x)}
                            className="ml-auto rounded-lg border border-white/15 bg-black/40 px-3 py-1.5 text-xs font-semibold text-white/80 hover:border-white/30"
                          >
                            EDIT
                          </button>
                        </div>

                        {imageUrls.length > 0 ? (
                          <div className="mt-3 grid grid-cols-5 gap-2">
                            {imageUrls.slice(0, 10).map((u) => (
                              <div key={u} className="relative">
                                <div
                                  className="h-14 w-14 cursor-pointer overflow-hidden rounded-lg border border-white/20 bg-black/40"
                                  onClick={() => setImageOpenUrl(u)}
                                >
                                  <img src={u} alt="Item" className="h-full w-full object-cover" />
                                </div>

                                <button
                                  type="button"
                                  onClick={() => deletePhotoUrl(x.itemId, u)}
                                  className="absolute -right-2 -top-2 rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white"
                                >
                                  ×
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>

                      {/* RIGHT SIDE */}
                      <div className="flex flex-col items-end gap-2">
                        {firstImg ? (
                          <div
                            className="h-14 w-14 cursor-pointer overflow-hidden rounded-lg border border-white/20 bg-black/40"
                            onClick={() => setImageOpenUrl(firstImg)}
                          >
                            <img src={firstImg} alt={x.itemId} className="h-full w-full object-cover" />
                          </div>
                        ) : null}

                        <div className="cursor-pointer rounded-lg bg-white p-2" onClick={() => setQrOpen(x.itemId)}>
                          <QRCode value={x.itemId} size={64} />
                        </div>

                        <div className="flex w-full flex-col gap-2">
                          <button
                            type="button"
                            onClick={() => openTagPreview(x)}
                            className="w-full rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-black hover:bg-white/90"
                          >
                            Print Tag
                          </button>

                          <button
                            type="button"
                            onClick={() => deleteItem(x.itemId)}
                            className="w-full rounded-lg border border-red-500/60 bg-transparent px-3 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-500/10"
                          >
                            DELETE
                          </button>
                        </div>
                      </div>
                    </div>

                    {x.notes ? <div className="mt-2 text-xs text-white/50">Note: {x.notes}</div> : null}
                  </div>
                );
              })
            )}
          </div>

          {filtered.length > visibleCount ? (
            <button
              type="button"
              onClick={() => setVisibleCount((p) => p + PAGE_SIZE)}
              className="mt-4 w-full rounded-xl border border-white/15 bg-black/40 px-4 py-2 text-sm font-semibold text-white/80 hover:border-white/30"
            >
              Load More
            </button>
          ) : null}

          <div className="mt-3 text-xs text-white/40">
            Showing {Math.min(visibleCount, filtered.length)} of {filtered.length} items. Data saved offline in this browser
            + cloud synced.
          </div>
        </div>
      </div>

      {/* QR Modal */}
      {qrOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={() => setQrOpen(null)}>
          <div
            className="w-full max-w-sm rounded-2xl border border-white/10 bg-black p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="text-sm text-white/70">ANNVI GOLD</div>
              <button
                className="rounded-lg border border-white/15 px-3 py-1 text-xs text-white/70 hover:border-white/30"
                onClick={() => setQrOpen(null)}
                type="button"
              >
                Close
              </button>
            </div>

            <div className="mt-3 flex items-center justify-center rounded-xl bg-white p-4">
              <QRCode value={qrOpen} size={220} />
            </div>

            <div className="mt-3 text-center">
              <div className="text-lg font-semibold">{qrOpen}</div>
              <div className="mt-1 text-xs text-white/50">Scan this to fetch item by ItemID</div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Image Modal */}
      {imageOpenUrl ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setImageOpenUrl(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-white/10 bg-black p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <div className="text-sm text-white/70">Item Photo</div>
              <button
                className="rounded-lg border border-white/15 px-3 py-1 text-xs text-white/70 hover:border-white/30"
                onClick={() => setImageOpenUrl(null)}
                type="button"
              >
                Close
              </button>
            </div>

            <div className="mt-3 flex items-center justify-center rounded-xl bg-black">
              <img src={imageOpenUrl} alt="Item" className="max-h-[70vh] w-auto object-contain" />
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
