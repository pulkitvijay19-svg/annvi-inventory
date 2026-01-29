"use client";

import { useEffect, useMemo, useState } from "react";
import QRCode from "react-qr-code";
import { supabase } from "@/lib/supabaseClient";
import { useRequireLogin, doLogout } from "@/lib/useRequireLogin";
import { useRouter } from "next/navigation";

const STORAGE_KEY = "annvi_items_v1";
const ITEMS_BUCKET = "item-images";
const PAGE_SIZE = 30;

// ✅ Category list (as provided)
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

// ✅ FIX: nextItemId now uses MAX+1 (not length+1)
function nextItemId(items) {
  const yy = getYear2();
  const prefix = `AG-${yy}-`;
  let max = 0;

  for (const x of items) {
    const id = x?.itemId || "";
    if (!id.startsWith(prefix)) continue;
    const num = parseInt(id.slice(prefix.length), 10);
    if (!Number.isNaN(num)) max = Math.max(max, num);
  }

  return `${prefix}${pad6(max + 1)}`;
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
    image_url: imageUrls[0] || null, // backward compatibility
    image_urls: imageUrls, // new
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

// pull from cloud and merge into local
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

  // ✅ FIX: stable sort (no shuffle)
  return Array.from(byId.values()).sort((a, b) => {
    const ta = new Date(a.updatedAt || 0).getTime();
    const tb = new Date(b.updatedAt || 0).getTime();
    if (tb !== ta) return tb - ta;
    return String(b.itemId).localeCompare(String(a.itemId));
  });
}

// delete one item from cloud
async function cloudDeleteItem(itemId) {
  const { error } = await supabase.from("items").delete().eq("item_id", itemId);
  if (error) throw error;
}

// delete ALL items from cloud (testing / reset)
async function cloudDeleteAllItems() {
  const { error } = await supabase.from("items").delete().neq("item_id", "");
  if (error) throw error;
}

// ----------- TAG PREVIEW HELPER (NO BRIDGE) -----------
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

// ----------- DATE HELPERS -----------
function formatDT(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}
function isoDateOnly(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return "";
  }
}

// -------------------------------------------------------
export default function AddPage() {
  useRequireLogin();
  const router = useRouter();

  const [items, setItems] = useState([]);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("ALL");
  const [qrOpen, setQrOpen] = useState(null);

  const [cloudMsg, setCloudMsg] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);

  // ✅ double save guard
  const [savingLocal, setSavingLocal] = useState(false);

  // ✅ Date filters (createdAt)
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [form, setForm] = useState({
    designNo: "",
    category: CATEGORIES[0],
    karat: "22K",
    grossWt: "",
    lessWt: "",
    notes: "",
  });

  // ✅ multiple photos
  const [photoFiles, setPhotoFiles] = useState([]);
  const [photoPreviews, setPhotoPreviews] = useState([]);

  // image zoom modal
  const [imageOpenUrl, setImageOpenUrl] = useState(null);

  // ✅ Edit mode
  const [editingId, setEditingId] = useState(null);

  // ✅ Load more
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // ✅ Scan / paste itemID quick filter
  const [scanId, setScanId] = useState("");

  // Initial load: local first, then cloud sync
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

      const { error: uploadError } = await supabase.storage
        .from(ITEMS_BUCKET)
        .upload(path, compressed, {
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

    if (savingLocal || cloudBusy) return; // ✅ guard
    setSavingLocal(true);

    const now = new Date().toISOString();

    try {
      // ✅ If editing -> update existing item
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

        setItems((prev) =>
          prev.map((x) => (x.itemId === itemId ? { ...x, ...patchLocal } : x))
        );

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
            prev.map((x) =>
              x.itemId === itemId ? { ...x, imageUrls: mergedUrls, updatedAt: now } : x
            )
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

      // ✅ New create
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

      // IMPORTANT: copy files BEFORE reset UI (otherwise upload breaks)
      const filesToUpload = [...photoFiles];

      // LOCAL (dedupe by itemId)
      setItems((prev) => [payload, ...prev.filter((x) => x.itemId !== itemId)]);

      setForm({
        designNo: "",
        category: form.category,
        karat: form.karat,
        grossWt: "",
        lessWt: "",
        notes: "",
      });

      // ✅ clear photos UI properly (after copying files)
      resetPhotosUI();

      // CLOUD
      setCloudBusy(true);
      setCloudMsg("Saving to cloud...");
      try {
        await cloudUpsertItem(payload);
        await cloudLogEvent({
          itemId,
          action: "CREATE",
          actor: "Factory",
          place: "Local",
        });

        // Upload photos (multiple)
        if (filesToUpload.length > 0) {
          setCloudMsg("Uploading photos...");
          const urls = await uploadPhotosForItem(itemId, filesToUpload);

          if (urls.length > 0) {
            await cloudUpdateItem(itemId, {
              image_urls: urls,
              image_url: urls[0] || null,
              updated_at: new Date().toISOString(),
            });

            setItems((prev) =>
              prev.map((x) => (x.itemId === itemId ? { ...x, imageUrls: urls } : x))
            );

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
    } finally {
      setSavingLocal(false);
    }
  }

  // status change from Add page
  async function setStatus(itemId, status) {
    const now = new Date().toISOString();

    setItems((prev) =>
      prev.map((x) => (x.itemId === itemId ? { ...x, status, updatedAt: now } : x))
    );

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

  // delete single item (local + cloud)
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
    } catch {
      setCloudMsg(
        `Local deleted; cloud delete failed ⚠ (${itemId}) – Supabase RLS / net check karo.`
      );
    } finally {
      setCloudBusy(false);
      setTimeout(() => setCloudMsg(""), 3000);
    }
  }

  // delete one photo url from item (DB only; storage file stays)
  async function deletePhotoUrl(itemId, urlToRemove) {
    const ok = confirm("Remove this photo from item?");
    if (!ok) return;

    const now = new Date().toISOString();

    const current = items.find((x) => x.itemId === itemId);
    const existing = Array.isArray(current?.imageUrls) ? current.imageUrls : [];
    const nextUrls = existing.filter((u) => u !== urlToRemove);

    setItems((prev) =>
      prev.map((x) =>
        x.itemId === itemId ? { ...x, imageUrls: nextUrls, updatedAt: now } : x
      )
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
    const a = confirm(
      "Ye action sab items delete karega (LOCAL + CLOUD). Mostly testing ke liye. Continue?"
    );
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

  // ✅ filters (query + category + date range)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    const from = dateFrom ? new Date(dateFrom + "T00:00:00").getTime() : null;
    const to = dateTo ? new Date(dateTo + "T23:59:59").getTime() : null;

    return items.filter((x) => {
      const matchQuery =
        !q ||
        (x.itemId || "").toLowerCase().includes(q) ||
        String(x.designNo || "").toLowerCase().includes(q);

      const matchCat = categoryFilter === "ALL" || (x.category || "") === categoryFilter;

      const t = new Date(x.createdAt || x.updatedAt || 0).getTime();
      const matchFrom = from === null || t >= from;
      const matchTo = to === null || t <= to;

      return matchQuery && matchCat && matchFrom && matchTo;
    });
  }, [items, query, categoryFilter, dateFrom, dateTo]);

  const counts = useMemo(() => {
    const c = { IN_STOCK: 0, SOLD: 0, RETURNED: 0 };
    for (const x of items) c[x.status] = (c[x.status] || 0) + 1;
    return c;
  }, [items]);

  const visibleItems = useMemo(() => {
    return filtered.slice(0, visibleCount);
  }, [filtered, visibleCount]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [query, categoryFilter, dateFrom, dateTo, items.length]);

  function onGoScan() {
    const id = scanId.trim();
    if (!id) return;
    setQuery(id);
    setScanId("");
  }

  return (
    <main className="min-h-screen bg-black text-white">
      {/* ✅ Responsive wrapper: laptop pe wide */}
      <div className="mx-auto w-full max-w-md px-4 py-8 md:max-w-3xl lg:max-w-6xl">
        {/* ✅ Desktop layout: 2 columns */}
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[420px_1fr] lg:items-start">
          {/* Add Piece Card */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-sm">
            <div className="mb-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm tracking-widest text-white/70">ANNVI GOLD</div>
                  <h1 className="mt-1 text-2xl font-semibold">
                    {editingId ? "Edit Piece" : "Add Piece"}
                  </h1>
                  <p className="mt-1 text-sm text-white/60">
                    ItemID auto + offline local save + QR (+ Cloud)
                  </p>

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
                  <div className="mt-1 text-xs text-white/50">
                    Today: <span className="font-semibold">{formatDT(new Date().toISOString())}</span>
                  </div>
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
                  <div className="text-xl font-semibold">
                    {netWt === "" ? "—" : `${netWt} g`}
                  </div>
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
                <label className="text-sm text-white/70">
                  Photos (optional, multiple) — add more in Edit also
                </label>
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
                      <div
                        key={u}
                        className="h-14 w-14 overflow-hidden rounded-lg border border-white/15 bg-black/40"
                        title="Selected"
                      >
                        <img src={u} alt={`p${idx}`} className="h-full w-full object-cover" />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              <button
                type="submit"
                disabled={savingLocal || cloudBusy}
                className="w-full rounded-xl bg-white px-4 py-2 font-semibold text-black hover:bg-white/90 disabled:opacity-60"
              >
                {editingId ? "Update Piece" : "Save Piece (offline)"}
              </button>
            </form>
          </div>

          {/* Saved Pieces */}
          <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">Saved Pieces</h2>
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

              {/* ✅ Date filters */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="mb-1 text-xs text-white/55">From Date</div>
                  <input
                    type="date"
                    value={dateFrom}
                    onChange={(e) => setDateFrom(e.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
                  />
                </div>
                <div>
                  <div className="mb-1 text-xs text-white/55">To Date</div>
                  <input
                    type="date"
                    value={dateTo}
                    onChange={(e) => setDateTo(e.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
                  />
                </div>
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
                <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-white/60">
                  No items yet.
                </div>
              ) : (
                visibleItems.map((x) => {
                  const imageUrls = Array.isArray(x.imageUrls) ? x.imageUrls : [];
                  const firstImg = imageUrls[0] || "";
                  const savedOn = x.createdAt || x.updatedAt;

                  return (
                    <div
                      key={x.itemId}
                      className="rounded-2xl border border-white/10 bg-black/30 p-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        {/* LEFT SIDE */}
                        <div className="flex-1">
                          <div className="text-sm text-white/60">ItemID</div>
                          <div className="text-lg font-semibold">{x.itemId}</div>

                          <div className="mt-1 text-xs text-white/60">
                            Category:{" "}
                            <span className="font-semibold text-white/80">
                              {x.category || "—"}
                            </span>
                          </div>

                          <div className="mt-1 text-xs text-white/55">
                            Saved On:{" "}
                            <span className="font-semibold text-white/75">
                              {formatDT(savedOn)}
                            </span>
                          </div>

                          <div className="mt-1 text-sm text-white/70">
                            D:{x.designNo} | {x.karat} | N:{x.netWt}g
                          </div>

                          <div className="mt-1 text-xs text-white/45">
                            Status:{" "}
                            <span className="font-semibold text-white/70">{x.status}</span>
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

                          {/* thumbnails + remove */}
                          {imageUrls.length > 0 ? (
                            <div className="mt-3 grid grid-cols-5 gap-2">
                              {imageUrls.slice(0, 10).map((u) => (
                                <div key={u} className="relative">
                                  <div
                                    className="h-14 w-14 cursor-pointer overflow-hidden rounded-lg border border-white/20 bg-black/40"
                                    title="Tap to enlarge"
                                    onClick={() => setImageOpenUrl(u)}
                                  >
                                    <img src={u} alt="Item" className="h-full w-full object-cover" />
                                  </div>

                                  <button
                                    type="button"
                                    onClick={() => deletePhotoUrl(x.itemId, u)}
                                    className="absolute -right-2 -top-2 rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white"
                                    title="Remove photo"
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
                              title="Tap to enlarge"
                              onClick={() => setImageOpenUrl(firstImg)}
                            >
                              <img src={firstImg} alt={x.itemId} className="h-full w-full object-cover" />
                            </div>
                          ) : null}

                          <div
                            className="cursor-pointer rounded-lg bg-white p-2"
                            title="Tap to enlarge QR"
                            onClick={() => setQrOpen(x.itemId)}
                          >
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

                      {x.notes ? (
                        <div className="mt-2 text-xs text-white/50">Note: {x.notes}</div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>

            {/* Load More */}
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
              Showing {Math.min(visibleCount, filtered.length)} of {filtered.length} items.
              Data saved offline in this browser + cloud synced.
            </div>
          </div>
        </div>
      </div>

      {/* QR Modal */}
      {qrOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setQrOpen(null)}
        >
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
