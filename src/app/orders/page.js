"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRequireLogin, doLogout } from "@/lib/useRequireLogin";
import { useRouter } from "next/navigation";

// -------- IMAGE COMPRESSOR (same style as Add page) ----------
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

const ORDERS_BUCKET = "order-images";

// Row → JS object
function rowToOrder(r) {
  // image_urls is new column; photo_urls fallback in case purana data ho
  const imagesRaw = Array.isArray(r.image_urls)
    ? r.image_urls
    : Array.isArray(r.photo_urls)
    ? r.photo_urls
    : [];

  return {
    id: r.id,
    partyName: r.party_name || "",
    orderDate: r.order_date || "",
    deliveryDate: r.delivery_date || "",
    karat: r.karat || "22K",
    productType: r.product_type || "",
    designText: r.design_text || "",
    weightRequired: r.weight_required || "",
    status: r.status || "RECEIVED",
    photoUrls: imagesRaw,
    createdAt: r.created_at || "",
  };
}

// UI display only – nice looking ID
function formatOrderId(order) {
  if (!order?.id) return "";
  const yy =
    order.orderDate && !Number.isNaN(new Date(order.orderDate).getTime())
      ? String(new Date(order.orderDate).getFullYear()).slice(-2)
      : String(new Date().getFullYear()).slice(-2);

  const short = String(order.id).slice(0, 4).toUpperCase();
  return `ORD-${yy}-${short}`;
}

export default function OrdersPage() {
  useRequireLogin();
  const router = useRouter();

  const today = new Date().toISOString().slice(0, 10);

  const [form, setForm] = useState({
    partyName: "",
    orderDate: today,
    deliveryDate: today,
    karat: "22K",
    productType: "",
    designText: "",
    weightRequired: "",
    status: "RECEIVED",
  });

  const [photoFiles, setPhotoFiles] = useState([]);
  const [orders, setOrders] = useState([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  // ------- load latest orders --------
  async function loadOrders() {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      console.error(error);
      setMsg("Load failed ⚠ – Supabase error.");
      return;
    }

    setOrders((data || []).map(rowToOrder));
  }

  useEffect(() => {
    loadOrders();
  }, []);

  function updateForm(key, value) {
    setForm((p) => ({ ...p, [key]: value }));
  }

  function onPhotoChange(e) {
    const files = Array.from(e.target.files || []);
    setPhotoFiles(files);
  }

  // ---------- SAVE NEW ORDER -----------
  async function onSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setMsg("Saving order...");

    try {
      const baseRow = {
        party_name: form.partyName.trim(),
        order_date: form.orderDate,
        delivery_date: form.deliveryDate,
        karat: form.karat,
        product_type: form.productType.trim(),
        design_text: form.designText.trim(),
        weight_required: form.weightRequired.trim(),
        status: form.status,
        // jsonb column ke liye safe default – kabhi null nahi jayega
        image_urls: [],
      };

      // 1) insert order row (without photos)
      const { data, error } = await supabase
        .from("orders")
        .insert(baseRow)
        .select("*")
        .single();

      if (error || !data) {
        console.error(error);
        setMsg(
          "Order save failed ⚠ – Supabase insert error (table / RLS check karo)."
        );
        setSaving(false);
        return;
      }

      let order = rowToOrder(data);

      // 2) upload photos if any
      if (photoFiles.length > 0) {
        setMsg("Uploading photos...");
        const urls = [];

        let index = 0;
        for (const file of photoFiles) {
          const compressed = await compressImage(file);
          const fileName = `${index}.jpg`;
          const path = `orders/${order.id}/${fileName}`;

          const { error: upErr } = await supabase.storage
            .from(ORDERS_BUCKET)
            .upload(path, compressed, {
              upsert: true,
              contentType: "image/jpeg",
            });

          if (upErr) {
            console.error(upErr);
          } else {
            const { data: urlData } = supabase.storage
              .from(ORDERS_BUCKET)
              .getPublicUrl(path);
            if (urlData?.publicUrl) {
              urls.push(urlData.publicUrl);
            }
          }

          index++;
        }

        if (urls.length > 0) {
          const { data: updated, error: updErr } = await supabase
            .from("orders")
            .update({ image_urls: urls })
            .eq("id", order.id)
            .select("*")
            .single();

          if (!updErr && updated) {
            order = rowToOrder(updated);
          } else if (updErr) {
            console.error(updErr);
          }
        }
      }

      // update local list
      setOrders((prev) => [order, ...prev]);

      // reset form
      setForm((p) => ({
        ...p,
        partyName: "",
        productType: "",
        designText: "",
        weightRequired: "",
      }));
      setPhotoFiles([]);

      // file input clear
      const inputEl = document.getElementById("orderPhotosInput");
      if (inputEl && typeof inputEl === "object" && "value" in inputEl) {
        inputEl.value = "";
      }

      setMsg("Order saved ✅");
    } catch (err) {
      console.error(err);
      setMsg("Order save failed ⚠ – unexpected error.");
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(""), 2500);
    }
  }

  // ---------- UPDATE STATUS FROM LIST ----------
  async function updateOrderStatus(orderId, newStatus) {
    setSaving(true);
    setMsg("Updating order status...");

    try {
      const { data, error } = await supabase
        .from("orders")
        .update({ status: newStatus })
        .eq("id", orderId)
        .select("*")
        .single();

      if (error || !data) {
        console.error(error);
        setMsg("Status update failed ⚠");
      } else {
        const updated = rowToOrder(data);
        setOrders((prev) =>
          prev.map((o) => (o.id === orderId ? updated : o))
        );
        setMsg("Status updated ✅");
      }
    } catch (err) {
      console.error(err);
      setMsg("Status update failed ⚠");
    } finally {
      setSaving(false);
      setTimeout(() => setMsg(""), 2000);
    }
  }

  // ---------- DELETE ORDER ----------
  async function deleteOrder(rowId) {
    if (!confirm("Delete this order?")) return;

    // local state se hatao
    setOrders((prev) => prev.filter((o) => o.id !== rowId));

    try {
      const { error } = await supabase
        .from("orders")
        .delete()
        .eq("id", rowId);

      if (error) throw error;
      setMsg("Order deleted ✅");
    } catch (err) {
      console.error(err);
      setMsg("Order delete failed ⚠ – check Supabase.");
    }
  }

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-2xl px-4 py-8">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-sm">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <div className="text-sm tracking-widest text-white/70">
                ANNVI GOLD
              </div>
              <h1 className="mt-1 text-2xl font-semibold">Orders</h1>
              <p className="mt-1 text-sm text-white/60">
                Party wise orders with photos + live status.
              </p>
              {msg ? (
                <div className="mt-2 text-xs text-white/70">
                  {saving ? "⏳ " : "✅ "} {msg}
                </div>
              ) : null}
            </div>

            <button
              type="button"
              onClick={() => doLogout(router)}
              className="rounded-lg border border-white/20 bg-black/30 px-3 py-2 text-xs text-white/70 hover:border-white/40"
            >
              Logout
            </button>
          </div>

          {/* NEW ORDER FORM */}
          <form onSubmit={onSubmit} className="space-y-4">
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
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
                  required
                />
              </div>
              <div>
                <label className="text-sm text-white/70">Delivery Date</label>
                <input
                  type="date"
                  value={form.deliveryDate}
                  onChange={(e) => updateForm("deliveryDate", e.target.value)}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
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
                  Weight Required (text allowed)
                </label>
                <input
                  type="text"
                  value={form.weightRequired}
                  onChange={(e) =>
                    updateForm("weightRequired", e.target.value)
                  }
                  placeholder="e.g. 2.50 / 2.5–3g / 2.5+pendant"
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
                />
              </div>
            </div>

            <div>
              <label className="text-sm text-white/70">Product Type</label>
              <input
                value={form.productType}
                onChange={(e) => updateForm("productType", e.target.value)}
                placeholder="ring / bali / kada, etc."
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
              />
            </div>

            <div>
              <label className="text-sm text-white/70">
                Design No / Notes (text + special)
              </label>
              <textarea
                value={form.designText}
                onChange={(e) => updateForm("designText", e.target.value)}
                rows={2}
                placeholder="e.g. D1234, D1235 (top), D1236 (side)..."
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-white/70">Order Status</label>
                <select
                  value={form.status}
                  onChange={(e) => updateForm("status", e.target.value)}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
                >
                  <option value="RECEIVED">Received</option>
                  <option value="IN_PROCESS">In Process</option>
                  <option value="DELIVERED">Delivered</option>
                </select>
              </div>
              <div>
                <label className="text-sm text-white/70">
                  Photos (optional, multiple)
                </label>
                <input
                  id="orderPhotosInput"
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={onPhotoChange}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs outline-none file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-1 file:text-xs file:font-semibold file:text-black hover:border-white/30"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={saving}
              className="w-full rounded-xl bg-white px-4 py-2 font-semibold text-black hover:bg-white/90 disabled:opacity-60"
            >
              Save Order
            </button>
          </form>
        </div>

        {/* ORDERS LIST */}
        <div className="mt-6 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="mb-2 text-sm text-white/60">
            Orders List (max 200). Change status, delete, view photos.
          </div>

          {orders.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-white/60">
              No orders yet.
            </div>
          ) : (
            <div className="space-y-3">
              {orders.map((o) => (
                <div
                  key={o.id}
                  className="flex items-start justify-between gap-3 rounded-xl border border-white/10 bg-black/30 p-3"
                >
                  {/* LEFT: text */}
                  <div className="flex-1">
                    <div className="text-sm font-semibold">
                      {o.partyName || "(No party)"}{" "}
                      <span className="text-xs text-white/50">
                        ({formatOrderId(o)})
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-white/60">
                      Order: {o.orderDate || "—"} • Delivery:{" "}
                      {o.deliveryDate || "—"}
                    </div>
                    <div className="mt-1 text-xs text-white/60">
                      {o.karat} • Wt: {o.weightRequired || "—"}
                    </div>
                    {o.designText ? (
                      <div className="mt-1 text-xs text-white/50">
                        {o.designText}
                      </div>
                    ) : null}

                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-white/60">Status:</span>
                      <select
                        value={o.status}
                        onChange={(e) =>
                          updateOrderStatus(o.id, e.target.value)
                        }
                        className="rounded-lg border border-white/15 bg-black/40 px-3 py-1 text-xs text-white/80 outline-none focus:border-white/30"
                        disabled={saving}
                      >
                        <option value="RECEIVED">Received</option>
                        <option value="IN_PROCESS">In Process</option>
                        <option value="DELIVERED">Delivered</option>
                      </select>

                      <button
                        type="button"
                        onClick={() => deleteOrder(o.id)}
                        className="ml-auto rounded-lg border border-red-500/60 bg-transparent px-3 py-1 text-xs font-semibold text-red-300 hover:bg-red-500/10"
                      >
                        Delete Order
                      </button>
                    </div>
                  </div>

                  {/* RIGHT: first photo preview */}
                  <div className="flex flex-col items-end gap-2">
                    {o.photoUrls && o.photoUrls.length > 0 ? (
                      <div className="h-16 w-16 overflow-hidden rounded-lg border border-white/20 bg-black/40">
                        <img
                          src={o.photoUrls[0]}
                          alt="Order"
                          className="h-full w-full object-cover"
                        />
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
