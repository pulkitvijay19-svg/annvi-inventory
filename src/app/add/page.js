"use client";

import { useEffect, useMemo, useState } from "react";
import QRCode from "react-qr-code";
import { supabase } from "@/lib/supabaseClient";
import { useRequireLogin, doLogout } from "@/lib/useRequireLogin";
import { useRouter } from "next/navigation";

const STORAGE_KEY = "annvi_items_v1";

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

function toCloudRow(localItem) {
  return {
    item_id: localItem.itemId,
    design_no: localItem.designNo,
    karat: localItem.karat,
    gross_wt: Number(localItem.grossWt || 0),
    less_wt: Number(localItem.lessWt || 0),
    net_wt: Number(localItem.netWt || 0),
    notes: localItem.notes || "",
    status: localItem.status,
    image_url: localItem.imageUrl || null,
    created_at: localItem.createdAt,
    updated_at: localItem.updatedAt,
  };
}

async function cloudUpsertItem(localItem) {
  const row = toCloudRow(localItem);
  const { error } = await supabase
    .from("items")
    .upsert(row, { onConflict: "item_id" });
  if (error) throw error;
}

async function cloudUpdateStatus(itemId, status, updatedAtISO) {
  const { error } = await supabase
    .from("items")
    .update({ status, updated_at: updatedAtISO })
    .eq("item_id", itemId);
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
    .limit(500);

  if (error) throw error;

  const cloudItems = (data || []).map((r) => ({
    itemId: r.item_id,
    designNo: r.design_no,
    karat: r.karat,
    grossWt: String(r.gross_wt ?? ""),
    lessWt: String(r.less_wt ?? ""),
    netWt: String(r.net_wt ?? ""),
    notes: r.notes ?? "",
    status: r.status ?? "IN_STOCK",
    imageUrl: r.image_url ?? "",
    createdAt: r.created_at ?? new Date().toISOString(),
    updatedAt: r.updated_at ?? new Date().toISOString(),
  }));

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

// delete one item from cloud
async function cloudDeleteItem(itemId) {
  const { error } = await supabase
    .from("items")
    .delete()
    .eq("item_id", itemId);
  if (error) throw error;
}

// delete ALL items from cloud (testing / reset)
async function cloudDeleteAllItems() {
  const { error } = await supabase
    .from("items")
    .delete()
    .neq("item_id", "");
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

// -------------------------------------------------------

export default function AddPage() {
  useRequireLogin(); // login guard
  const router = useRouter();
  const [items, setItems] = useState([]);
  const [query, setQuery] = useState("");
  const [qrOpen, setQrOpen] = useState(null);

  const [cloudMsg, setCloudMsg] = useState("");
  const [cloudBusy, setCloudBusy] = useState(false);

  const [form, setForm] = useState({
    designNo: "",
    karat: "22K",
    grossWt: "",
    lessWt: "",
    notes: "",
  });

  const [photoFile, setPhotoFile] = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);

  // image zoom modal
  const [imageOpenUrl, setImageOpenUrl] = useState(null);

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

  function onPhotoChange(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) {
      setPhotoFile(null);
      setPhotoPreview((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
      return;
    }

    setPhotoFile(file);
    const url = URL.createObjectURL(file);
    setPhotoPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return url;
    });
  }

  async function onSave(e) {
    e.preventDefault();

    const itemId = nextItemId(items);
    const now = new Date().toISOString();

    const payload = {
      itemId,
      designNo: form.designNo.trim(),
      karat: form.karat,
      grossWt: form.grossWt.trim(),
      lessWt: form.lessWt.trim() || "0",
      netWt,
      notes: form.notes.trim(),
      status: "IN_STOCK",
      imageUrl: "",
      createdAt: now,
      updatedAt: now,
    };

    // LOCAL
    setItems((prev) => [payload, ...prev]);

    setForm({
      designNo: "",
      karat: form.karat,
      grossWt: "",
      lessWt: "",
      notes: "",
    });
    setPhotoFile(null);
    setPhotoPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });

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

      if (photoFile) {
        setCloudMsg("Uploading photo...");

        const compressed = await compressImage(photoFile);
        const path = `items/${itemId}.jpg`;

        const { error: uploadError } = await supabase.storage
          .from("item-images")
          .upload(path, compressed, {
            upsert: true,
            contentType: "image/jpeg",
          });

        if (uploadError) {
          console.error(uploadError);
          setCloudMsg("Photo upload failed ⚠ — item saved without image");
        } else {
          const { data } = supabase.storage
            .from("item-images")
            .getPublicUrl(path);

          const imageUrl = (data && data.publicUrl) || "";

          await supabase
            .from("items")
            .update({
              image_url: imageUrl,
              updated_at: new Date().toISOString(),
            })
            .eq("item_id", itemId);

          setItems((prev) =>
            prev.map((x) => (x.itemId === itemId ? { ...x, imageUrl } : x))
          );

          setCloudMsg(`Saved + photo uploaded ✅ (${itemId})`);
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

  // status change from Add page
  async function setStatus(itemId, status) {
    const now = new Date().toISOString();

    setItems((prev) =>
      prev.map((x) =>
        x.itemId === itemId ? { ...x, status, updatedAt: now } : x
      )
    );

    setCloudBusy(true);
    setCloudMsg("Syncing status to cloud...");
    try {
      await cloudUpdateStatus(itemId, status, now);
      await cloudLogEvent({
        itemId,
        action:
          status === "SOLD" ? "SOLD" : status === "RETURNED" ? "RETURN" : "IN",
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
    } catch {
      setCloudMsg(
        `Local deleted; cloud delete failed ⚠ (${itemId}) – Supabase RLS / net check karo.`
      );
    } finally {
      setCloudBusy(false);
      setTimeout(() => setCloudMsg(""), 3000);
    }
  }

  // Clear Data = local + cloud wipe (testing)
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
    } catch {
      setCloudMsg(
        "Local cleared. Cloud delete failed ⚠ – Supabase RLS / net check karo."
      );
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
    if (!q) return items;
    return items.filter(
      (x) =>
        x.itemId.toLowerCase().includes(q) ||
        String(x.designNo).toLowerCase().includes(q)
    );
  }, [items, query]);

  const counts = useMemo(() => {
    const c = { IN_STOCK: 0, SOLD: 0, RETURNED: 0 };
    for (const x of items) c[x.status] = (c[x.status] || 0) + 1;
    return c;
  }, [items]);

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-md px-4 py-8">
        {/* Add Piece Card */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-sm">
          <div className="mb-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm tracking-widest text-white/70">
                  ANNVI GOLD
                </div>
                <h1 className="mt-1 text-2xl font-semibold">Add Piece</h1>
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
            <div className="rounded-xl border border-white/10 bg-black/30 p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm text-white/70">Next ItemID</div>
                <div className="font-semibold">{nextItemId(items)}</div>
              </div>
              <div className="mt-1 text-xs text-white/45">
                Format: AG-YY-000001
              </div>
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
                <label className="text-sm text-white/70">
                  Less Wt / Stone (g)
                </label>
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
              <div className="mt-1 text-xs text-white/50">
                Net = Gross − Less
              </div>
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
              <label className="text-sm text-white/70">Photo (optional)</label>
              <input
                type="file"
                accept="image/*;capture=camera"
                onChange={onPhotoChange}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs outline-none file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-1 file:text-xs file:font-semibold file:text-black hover:border-white/30"
              />
              {photoPreview ? (
                <div className="mt-2 flex items-center gap-3">
                  <div className="h-16 w-16 overflow-hidden rounded-lg border border-white/15 bg-black/40">
                    <img
                      src={photoPreview}
                      alt="Preview"
                      className="h-full w-full object-cover"
                    />
                  </div>
                  <div className="text-xs text-white/50">
                    Camera / gallery se aayi image compress hogi (approx ~100
                    KB).
                  </div>
                </div>
              ) : null}
            </div>

            <button
              type="submit"
              className="w-full rounded-xl bg-white px-4 py-2 font-semibold text-black hover:bg-white/90"
            >
              Save Piece (offline)
            </button>
          </form>
        </div>

        {/* Saved Pieces */}
        <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Saved Pieces</h2>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search ItemID / Design"
              className="w-48 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
            />
          </div>

          <div className="mt-3 space-y-3">
            {filtered.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-white/60">
                No items yet.
              </div>
            ) : (
              filtered.map((x) => (
                <div
                  key={x.itemId}
                  className="rounded-xl border border-white/10 bg-black/30 p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    {/* LEFT SIDE: details + status buttons */}
                    <div className="flex-1">
                      <div className="text-sm text-white/60">ItemID</div>
                      <div className="text-lg font-semibold">{x.itemId}</div>
                      <div className="mt-1 text-sm text-white/70">
                        D:{x.designNo} | {x.karat} | N:{x.netWt}g
                      </div>
                      <div className="mt-1 text-xs text-white/45">
                        Status:{" "}
                        <span className="font-semibold text-white/70">
                          {x.status}
                        </span>
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
                      </div>
                    </div>

                    {/* RIGHT SIDE: image (if any) + QR + Print / Delete */}
                    <div className="flex flex-col items-end gap-2">
                      {x.imageUrl ? (
                        <div
                          className="h-14 w-14 cursor-pointer overflow-hidden rounded-lg border border-white/20 bg-black/40"
                          title="Tap to enlarge"
                          onClick={() => setImageOpenUrl(x.imageUrl)}
                        >
                          <img
                            src={x.imageUrl}
                            alt={x.itemId}
                            className="h-full w-full object-cover"
                          />
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
                    <div className="mt-2 text-xs text-white/50">
                      Note: {x.notes}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>

          <div className="mt-3 text-xs text-white/40">
            Showing max 30 items on screen. Data saved offline in this browser +
            cloud synced.
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
              <div className="mt-1 text-xs text-white/50">
                Scan this to fetch item by ItemID
              </div>
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
              <img
                src={imageOpenUrl}
                alt="Item"
                className="max-h-[70vh] w-auto object-contain"
              />
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
