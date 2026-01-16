"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { useRequireLogin, doLogout } from "@/lib/useRequireLogin";
import { useRouter } from "next/navigation";

// ---------- IMAGE COMPRESS (~100 KB each) ----------
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
            // thoda aur compress
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
function todayYYYYMMDD() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export default function OrdersPage() {
  useRequireLogin();
  const router = useRouter();

  const [form, setForm] = useState({
    partyName: "",
    orderDate: todayYYYYMMDD(),
    deliveryDate: "",
    karat: "22K",
    productType: "",
    designText: "",
    weightRequired: "",
    status: "RECEIVED",
  });

  const [files, setFiles] = useState([]);
  const [previews, setPreviews] = useState([]);

  const [orders, setOrders] = useState([]);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const [bigImage, setBigImage] = useState(null);

  // -------- LOAD ORDERS ONCE ----------
  useEffect(() => {
    loadOrders();
  }, []);

  async function loadOrders() {
    setBusy(true);
    setMsg("Loading orders from cloud...");

    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);

    if (error) {
      console.error(error);
      setMsg("Failed to load orders ⚠ – Supabase error.");
    } else {
      setOrders(data || []);
      setMsg("");
    }

    setBusy(false);
  }

  // -------- FORM HANDLERS ----------
  function updateField(key, value) {
    setForm((p) => ({ ...p, [key]: value }));
  }

  function onFilesChange(e) {
    const list = Array.from(e.target.files || []);
    setFiles(list);

    // previews
    const urls = list.map((f) => URL.createObjectURL(f));
    // old revoke
    setPreviews((old) => {
      old.forEach((u) => URL.revokeObjectURL(u));
      return urls;
    });
  }

  // -------- SUBMIT ORDER ----------
  async function onSubmit(e) {
    e.preventDefault();

    if (!form.partyName.trim()) {
      setMsg("Party name required.");
      return;
    }
    if (!form.deliveryDate) {
      setMsg("Delivery date required.");
      return;
    }
    if (!form.productType.trim()) {
      setMsg("Product type required.");
      return;
    }
    if (!form.designText.trim()) {
      setMsg("Design details required.");
      return;
    }
    if (!form.weightRequired.trim()) {
      setMsg("Weight required is mandatory.");
      return;
    }

    setBusy(true);
    setMsg("Saving order...");

    const now = new Date().toISOString();

    // 1) Insert order WITHOUT images first
    const { data, error } = await supabase
      .from("orders")
      .insert({
        party_name: form.partyName.trim(),
        order_date: form.orderDate, // string yyyy-mm-dd
        delivery_date: form.deliveryDate,
        karat: form.karat,
        product_type: form.productType.trim(),
        design_text: form.designText.trim(),
        weight_required: Number(form.weightRequired) || 0,
        status: form.status,
        image_urls: [], // fill after upload
        created_at: now,
        updated_at: now,
      })
      .select("*")
      .single();

    if (error || !data) {
      console.error(error);
      setMsg("Order save failed ⚠ – Supabase insert error (table / RLS check karo).");
      setBusy(false);
      return;
    }

    let savedOrder = data;
    const orderId = data.id;

    // 2) Agar images hai to upload karo
    let imageUrls = [];

    if (files.length > 0) {
      setMsg("Uploading order photos...");

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          const compressed = await compressImage(file);
          const path = `orders/${orderId}/photo-${i + 1}.jpg`;

          const { error: upErr } = await supabase.storage
            .from("item-images") // same bucket we already use
            .upload(path, compressed, {
              upsert: true,
              contentType: "image/jpeg",
            });

          if (upErr) {
            console.error(upErr);
            continue;
          }

          const { data: urlData } = supabase.storage
            .from("item-images")
            .getPublicUrl(path);

          if (urlData && urlData.publicUrl) {
            imageUrls.push(urlData.publicUrl);
          }
        } catch (err) {
          console.error(err);
        }
      }

      if (imageUrls.length > 0) {
        const { data: updated, error: updErr } = await supabase
          .from("orders")
          .update({
            image_urls: imageUrls,
            updated_at: new Date().toISOString(),
          })
          .eq("id", orderId)
          .select("*")
          .single();

        if (!updErr && updated) {
          savedOrder = updated;
        }
      }
    }

    // 3) Local state update
    setOrders((prev) => [savedOrder, ...prev]);
    setMsg("Order saved ✅");

    // form reset
    setForm({
      partyName: "",
      orderDate: todayYYYYMMDD(),
      deliveryDate: "",
      karat: form.karat, // last used
      productType: "",
      designText: "",
      weightRequired: "",
      status: "RECEIVED",
    });
    setFiles([]);
    setPreviews((old) => {
      old.forEach((u) => URL.revokeObjectURL(u));
      return [];
    });

    setBusy(false);
  }

  // -------- UPDATE STATUS FOR EXISTING ORDER ----------
  async function updateOrderStatus(orderId, newStatus) {
    setBusy(true);
    setMsg(`Updating status to ${newStatus}...`);

    const { data, error } = await supabase
      .from("orders")
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq("id", orderId)
      .select("*")
      .single();

    if (error || !data) {
      console.error(error);
      setMsg("Status update failed ⚠ – Supabase / RLS check karo.");
      setBusy(false);
      return;
    }

    setOrders((prev) =>
      prev.map((o) => (o.id === orderId ? data : o))
    );
    setMsg("Status updated ✅");
    setBusy(false);
  }

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
        {/* HEADER + LOGOUT */}
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-sm tracking-widest text-white/70">
              ANNVI GOLD
            </div>
            <h1 className="mt-1 text-2xl font-semibold">Orders</h1>
            <p className="mt-1 text-sm text-white/60">
              Party wise orders with photos + live status.
            </p>
          </div>

          <button
            type="button"
            onClick={() => doLogout(router)}
            className="rounded-lg border border-white/20 bg-black/30 px-3 py-2 text-xs text-white/70 hover:border-white/40"
          >
            Logout
          </button>
        </div>

        {/* MESSAGE */}
        {msg ? (
          <div className="rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm text-white/80">
            {msg}
          </div>
        ) : null}

        {/* ORDER FORM */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-sm">
          <h2 className="text-lg font-semibold">New Order</h2>
          <p className="mt-1 text-xs text-white/60">
            Fill details + upload reference photos (optional).
          </p>

          <form onSubmit={onSubmit} className="mt-4 space-y-4">
            <div>
              <label className="text-sm text-white/70">Party Name</label>
              <input
                value={form.partyName}
                onChange={(e) => updateField("partyName", e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
                placeholder="e.g. M.M. Jewellers"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-white/70">Order Date</label>
                <input
                  type="date"
                  value={form.orderDate}
                  onChange={(e) => updateField("orderDate", e.target.value)}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
                />
              </div>
              <div>
                <label className="text-sm text-white/70">Delivery Date</label>
                <input
                  type="date"
                  value={form.deliveryDate}
                  onChange={(e) =>
                    updateField("deliveryDate", e.target.value)
                  }
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-white/70">Karat</label>
                <select
                  value={form.karat}
                  onChange={(e) => updateField("karat", e.target.value)}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
                >
                  <option>22K</option>
                  <option>20K</option>
                  <option>18K</option>
                  <option>14K</option>
                  <option>9K</option>
                  <option>Mixed</option>
                </select>
              </div>

              <div>
                <label className="text-sm text-white/70">
                  Weight Required (g)
                </label>
                <input
                  value={form.weightRequired}
                  onChange={(e) =>
                    updateField("weightRequired", e.target.value)
                  }
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
                  placeholder="e.g. 120"
                />
              </div>
            </div>

            <div>
              <label className="text-sm text-white/70">Product Type</label>
              <input
                value={form.productType}
                onChange={(e) => updateField("productType", e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
                placeholder="e.g. Kada, Choker, Pendant Set"
              />
            </div>

            <div>
              <label className="text-sm text-white/70">
                Design No. / Details
              </label>
              <textarea
                value={form.designText}
                onChange={(e) => updateField("designText", e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
                rows={3}
                placeholder="Free text – multiple design nos, notes, special instructions..."
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-sm text-white/70">Order Status</label>
                <select
                  value={form.status}
                  onChange={(e) => updateField("status", e.target.value)}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/30"
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
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={onFilesChange}
                  className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-xs outline-none file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-1 file:text-xs file:font-semibold file:text-black hover:border-white/30"
                />
                {previews.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {previews.map((src, i) => (
                      <div
                        key={i}
                        className="h-12 w-12 overflow-hidden rounded-lg border border-white/15 bg-black/40"
                      >
                        <img
                          src={src}
                          alt={`preview-${i}`}
                          className="h-full w-full object-cover"
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-white/90 disabled:opacity-60"
            >
              Save Order
            </button>
          </form>
        </div>

        {/* ORDER LIST */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Orders List</h2>
          <p className="mt-1 text-xs text-white/60">
            Latest orders (max 200). Change status and save.
          </p>

          <div className="mt-4 space-y-3">
            {orders.length === 0 ? (
              <div className="rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-white/60">
                No orders yet.
              </div>
            ) : (
              orders.map((o) => (
                <div
                  key={o.id}
                  className="rounded-xl border border-white/10 bg-black/30 p-3"
                >
                  <div className="flex gap-3">
                    <div className="flex-1 space-y-1 text-sm">
                      <div className="text-xs text-white/50">
                        Party / Order ID
                      </div>
                      <div className="font-semibold">
                        {o.party_name || "-"}{" "}
                        <span className="text-xs text-white/40">
                          ({o.id.slice(0, 8)}…)
                        </span>
                      </div>
                      <div className="text-xs text-white/60">
                        Order: {o.order_date || "-"} • Delivery:{" "}
                        {o.delivery_date || "-"}
                      </div>
                      <div className="text-xs text-white/60">
                        {o.karat} • {o.product_type} • wt:{" "}
                        {o.weight_required ?? 0} g
                      </div>
                      <div className="text-xs text-white/60">
                        {o.design_text}
                      </div>

                      <div className="mt-2 flex items-center gap-2">
                        <span className="text-xs text-white/60">
                          Status:
                        </span>
                        <select
                          value={o.status || "RECEIVED"}
                          onChange={(e) =>
                            updateOrderStatus(o.id, e.target.value)
                          }
                          className="rounded-lg border border-white/15 bg-black/40 px-2 py-1 text-xs outline-none focus:border-white/30"
                          disabled={busy}
                        >
                          <option value="RECEIVED">Received</option>
                          <option value="IN_PROCESS">In Process</option>
                          <option value="DELIVERED">Delivered</option>
                        </select>
                      </div>
                    </div>

                    {/* images small thumbnails */}
                    {Array.isArray(o.image_urls) && o.image_urls.length > 0 ? (
                      <div className="flex flex-col items-end gap-2">
                        <div className="flex flex-wrap justify-end gap-2">
                          {o.image_urls.slice(0, 3).map((url, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => setBigImage(url)}
                              className="h-12 w-12 overflow-hidden rounded-lg border border-white/20 bg-black/40"
                            >
                              <img
                                src={url}
                                alt={`img-${i}`}
                                className="h-full w-full object-cover"
                              />
                            </button>
                          ))}
                        </div>
                        {o.image_urls.length > 3 ? (
                          <div className="text-[10px] text-white/50">
                            +{o.image_urls.length - 3} more
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* BIG IMAGE MODAL */}
      {bigImage ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setBigImage(null)}
        >
          <div
            className="max-h-full max-w-full overflow-hidden rounded-2xl border border-white/15 bg-black"
            onClick={(e) => e.stopPropagation()}
          >
            <img src={bigImage} alt="order" className="h-full w-full object-contain" />
          </div>
        </div>
      ) : null}
    </main>
  );
}
