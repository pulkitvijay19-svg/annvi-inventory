"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRequireLogin, doLogout } from "@/lib/useRequireLogin";
import { useRouter } from "next/navigation";

const ORDER_IMAGES_BUCKET = "item-images";

// ---------- IMAGE COMPRESS (~100 KB target) ----------
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

// ---------- HELPERS ----------

function todayISO() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function rowToOrder(row) {
  return {
    id: row.id,
    partyName: row.party_name,
    orderDate: row.order_date,
    deliveryDate: row.delivery_date,
    karat: row.karat,
    productType: row.product_type,
    designNo: row.design_no,
    weightRequired: String(row.weight_required ?? ""),
    status: row.status || "RECEIVED",
    photoUrls: row.photo_urls || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const STATUS_OPTIONS = [
  { value: "RECEIVED", label: "Received" },
  { value: "IN_PROCESS", label: "In Process" },
  { value: "DELIVERED", label: "Delivered" },
];

// -------------------------------------------------------

export default function OrdersPage() {
  useRequireLogin();
  const router = useRouter();

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const [form, setForm] = useState({
    partyName: "",
    orderDate: todayISO(),
    deliveryDate: "",
    karat: "22K",
    productType: "",
    designNo: "",
    weightRequired: "",
    status: "RECEIVED",
  });

  const [photoFiles, setPhotoFiles] = useState([]);
  const [photoPreviews, setPhotoPreviews] = useState([]);

  // ---------- LOAD ORDERS ----------

  useEffect(() => {
    async function load() {
      setLoading(true);
      setMsg("Loading orders...");
      try {
        const { data, error } = await supabase
          .from("orders")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(200);

        if (error) throw error;
        setOrders((data || []).map(rowToOrder));
        setMsg("");
      } catch (err) {
        console.error(err);
        setMsg("Failed to load orders. (Check Supabase / network)");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // ---------- FORM HANDLERS ----------

  function updateForm(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function onPhotosChange(e) {
    const files = e.target.files ? Array.from(e.target.files) : [];
    setPhotoPreviews((old) => {
      old.forEach((u) => URL.revokeObjectURL(u));
      return [];
    });

    setPhotoFiles(files);

    const previews = files.map((f) => URL.createObjectURL(f));
    setPhotoPreviews(previews);
  }

  async function handleAddOrder(e) {
    e.preventDefault();

    if (!form.partyName.trim()) {
      setMsg("Party Name required.");
      return;
    }

    setSaving(true);
    setMsg("Saving order...");

    try {
      // 1) upload photos (if any)
      const photoUrls = [];

      for (let i = 0; i < photoFiles.length; i++) {
        const file = photoFiles[i];
        try {
          const compressed = await compressImage(file);
          const safeName = file.name.replace(/\s+/g, "_");
          const path = `orders/${Date.now()}-${i}-${safeName}`;

          const { error: upErr } = await supabase.storage
            .from(ORDER_IMAGES_BUCKET)
            .upload(path, compressed, {
              upsert: true,
              contentType: "image/jpeg",
            });

          if (upErr) {
            console.error("Upload error", upErr);
            continue;
          }

          const { data } = supabase.storage
            .from(ORDER_IMAGES_BUCKET)
            .getPublicUrl(path);
          if (data?.publicUrl) {
            photoUrls.push(data.publicUrl);
          }
        } catch (err) {
          console.error("Image upload failed", err);
        }
      }

      // 2) insert order row
      const { data, error } = await supabase
        .from("orders")
        .insert({
          party_name: form.partyName.trim(),
          order_date: form.orderDate || todayISO(),
          delivery_date: form.deliveryDate || null,
          karat: form.karat,
          product_type: form.productType.trim(),
          design_no: form.designNo.trim(),
          weight_required: form.weightRequired
            ? Number(form.weightRequired)
            : null,
          status: form.status,
          photo_urls: photoUrls.length ? photoUrls : null,
        })
        .select()
        .single();

      if (error) throw error;

      const newOrder = rowToOrder(data);
      setOrders((prev) => [newOrder, ...prev]);

      // clear form
      setForm((prev) => ({
        ...prev,
        partyName: "",
        deliveryDate: "",
        productType: "",
        designNo: "",
        weightRequired: "",
        status: "RECEIVED",
      }));
      setPhotoFiles([]);
      setPhotoPreviews((old) => {
        old.forEach((u) => URL.revokeObjectURL(u));
        return [];
      });

      setMsg("Order saved ✅");
    } catch (err) {
      console.error(err);
      setMsg("Order save failed ⚠ – Supabase / net check karo.");
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(""), 2500);
    }
  }

  // ---------- UPDATE ORDER STATUS ----------

  async function updateOrderStatus(orderId, newStatus) {
    setSaving(true);
    setMsg("Updating order status...");

    try {
      const { data, error } = await supabase
        .from("orders")
        .update({
          status: newStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", orderId)
        .select()
        .single();

      if (error) throw error;

      const updated = rowToOrder(data);
      setOrders((prev) =>
        prev.map((o) => (o.id === orderId ? updated : o))
      );
      setMsg("Status updated ✅");
    } catch (err) {
      console.error(err);
      setMsg("Status update failed ⚠");
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(""), 2500);
    }
  }

  const totalOrders = useMemo(() => orders.length, [orders]);

  // ---------- UI ----------

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-md px-4 py-8">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-sm">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <div className="text-sm tracking-widest text-white/70">
                ANNVI GOLD
              </div>
              <h1 className="mt-1 text-2xl font-semibold">Orders</h1>
              <p className="mt-1 text-sm text-white/60">
                Add new orders + manage status
              </p>
              {msg ? (
                <div className="mt-2 text-xs text-white/70">
                  {saving || loading ? "⏳ " : "✅ "}
                  {msg}
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
              <div className="rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-xs text-white/70">
                Total: {totalOrders}
              </div>
            </div>
          </div>

          {/* -------- ORDER FORM (WINDOW 1) -------- */}
          <form onSubmit={handleAddOrder} className="space-y-4">
            <div>
              <label className="text-sm text-white/70">Party Name</label>
              <input
                value={form.partyName}
                onChange={(e) => updateForm("partyName", e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-white/70">Order Date</label>
                <input
                  type="date"
                  value={form.orderDate}
                  onChange={(e) => updateForm("orderDate", e.target.value)}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
                />
              </div>
              <div>
                <label className="text-sm text-white/70">Delivery Date</label>
                <input
                  type="date"
                  value={form.deliveryDate}
                  onChange={(e) => updateForm("deliveryDate", e.target.value)}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
                />
              </div>
            </div>

            <div>
              <label className="text-sm text-white/70">Karat</label>
              <select
                value={form.karat}
                onChange={(e) => updateForm("karat", e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
              >
                <option>22K</option>
                <option>20K</option>
                <option>18K</option>
                <option>14K</option>
                <option>9K</option>
              </select>
            </div>

            <div>
              <label className="text-sm text-white/70">
                Product Type (text / special char)
              </label>
              <input
                value={form.productType}
                onChange={(e) => updateForm("productType", e.target.value)}
                placeholder="e.g. Ring, Kada, 'Ladies Set' etc."
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
              />
            </div>

            <div>
              <label className="text-sm text-white/70">
                Design No. (text / number / special)
              </label>
              <input
                value={form.designNo}
                onChange={(e) => updateForm("designNo", e.target.value)}
                placeholder="e.g. D-1234 / 567 / 'Mix-01,02'"
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
              />
            </div>

            <div>
              <label className="text-sm text-white/70">Weight Required</label>
              <input
                value={form.weightRequired}
                onChange={(e) => updateForm("weightRequired", e.target.value)}
                placeholder="e.g. 50.000"
                inputMode="decimal"
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
              />
            </div>

            <div>
              <label className="text-sm text-white/70">
                Order Status
              </label>
              <select
                value={form.status}
                onChange={(e) => updateForm("status", e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-sm text-white/70">
                Choose Photos (optional, multiple)
              </label>
              <input
                type="file"
                accept="image/*"
                multiple
                onChange={onPhotosChange}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs outline-none file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-1 file:text-xs file:font-semibold file:text-black hover:border-white/30"
              />
              {photoPreviews.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {photoPreviews.map((src, idx) => (
                    <div
                      key={idx}
                      className="h-16 w-16 overflow-hidden rounded-lg border border-white/15 bg-black/40"
                    >
                      <img
                        src={src}
                        alt={`Preview ${idx + 1}`}
                        className="h-full w-full object-cover"
                      />
                    </div>
                  ))}
                  <div className="text-xs text-white/50">
                    Camera / gallery se aayi images compress hongi
                    (approx ~100 KB each).
                  </div>
                </div>
              ) : null}
            </div>

            <button
              type="submit"
              disabled={saving}
              className="w-full rounded-xl bg-white px-4 py-2 font-semibold text-black hover:bg-white/90 disabled:opacity-60"
            >
              Submit Order
            </button>
          </form>
        </div>

        {/* -------- ORDERS LIST (WINDOW 2) -------- */}
        <div className="mt-5 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="mb-3 text-lg font-semibold">All Orders</div>

          {orders.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-white/60">
              No orders yet.
            </div>
          ) : (
            <div className="space-y-3">
              {orders.map((o) => (
                <div
                  key={o.id}
                  className="rounded-xl border border-white/10 bg-black/30 p-3"
                >
                  <div className="flex justify-between gap-3">
                    <div className="flex-1">
                      <div className="text-sm text-white/60">
                        Party
                      </div>
                      <div className="text-lg font-semibold">
                        {o.partyName}
                      </div>
                      <div className="mt-1 text-xs text-white/60">
                        Order: {o.orderDate || "—"} | Delivery:{" "}
                        {o.deliveryDate || "—"}
                      </div>
                      <div className="mt-1 text-sm text-white/70">
                        {o.karat} | {o.productType}
                      </div>
                      <div className="mt-1 text-sm text-white/70">
                        Design: {o.designNo || "—"}
                      </div>
                      <div className="mt-1 text-sm text-white/70">
                        Weight Req: {o.weightRequired || "—"}
                      </div>

                      <div className="mt-2 flex items-center gap-2 text-sm">
                        <span className="text-white/60">Status:</span>
                        <select
                          value={o.status}
                          onChange={(e) =>
                            updateOrderStatus(o.id, e.target.value)
                          }
                          className="rounded-lg border border-white/20 bg-black/40 px-2 py-1 text-xs outline-none focus:border-white/40"
                        >
                          {STATUS_OPTIONS.map((s) => (
                            <option key={s.value} value={s.value}>
                              {s.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    {/* Photos */}
                    {o.photoUrls && o.photoUrls.length > 0 ? (
                      <div className="flex w-24 flex-col gap-2">
                        <div className="flex flex-wrap gap-1">
                          {o.photoUrls.slice(0, 3).map((url, idx) => (
                            <div
                              key={idx}
                              className="h-10 w-10 overflow-hidden rounded-md border border-white/20 bg-black/40"
                            >
                              <img
                                src={url}
                                alt={`Order ${idx + 1}`}
                                className="h-full w-full object-cover"
                              />
                            </div>
                          ))}
                        </div>
                        {o.photoUrls.length > 3 ? (
                          <div className="text-[10px] text-white/50">
                            +{o.photoUrls.length - 3} more
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
