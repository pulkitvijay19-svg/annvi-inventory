"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { supabase } from "@/lib/supabaseClient";
import { useRequireLogin, doLogout } from "@/lib/useRequireLogin";
import { useRouter } from "next/navigation";

const STORAGE_KEY = "annvi_items_v1";

function loadLocalItems() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveLocalItems(items) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {}
}

// Supabase row → same shape as local items
function cloudRowToItem(row) {
  return {
    itemId: row.item_id,
    designNo: row.design_no,
    karat: row.karat,
    grossWt: String(row.gross_wt ?? ""),
    lessWt: String(row.less_wt ?? ""),
    netWt: String(row.net_wt ?? ""),
    notes: row.notes ?? "",
    status: row.status ?? "IN_STOCK",
    imageUrl: row.image_url ?? "",
    createdAt: row.created_at ?? new Date().toISOString(),
    updatedAt: row.updated_at ?? new Date().toISOString(),
  };
}

async function cloudFindItem(itemId) {
  const { data, error } = await supabase
    .from("items")
    .select("*")
    .eq("item_id", itemId)
    .maybeSingle();

  if (error || !data) return null;
  return cloudRowToItem(data);
}

async function cloudUpdateStatus(itemId, status, updatedAtISO) {
  const { error } = await supabase
    .from("items")
    .update({ status, updated_at: updatedAtISO })
    .eq("item_id", itemId);
  if (error) throw error;
}

// optional events log – ignore errors
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

// same fetch logic as Find Item, but reusable
async function refetchItemAnySource(id) {
  let found = null;

  try {
    const cloudItem = await cloudFindItem(id);
    if (cloudItem) found = cloudItem;
  } catch {
    // ignore
  }

  if (!found) {
    const allLocal = loadLocalItems();
    const localItem = allLocal.find((x) => x.itemId === id);
    if (localItem) found = localItem;
  }

  return found;
}

function format3(v) {
  const x = Number(v);
  if (!Number.isFinite(x)) return "0.000";
  return x.toFixed(3);
}

export default function ScanPage() {
  useRequireLogin();
  const router = useRouter();
  const [searchId, setSearchId] = useState("");
  const [message, setMessage] = useState("");
  const [item, setItem] = useState(null);
  const [busy, setBusy] = useState(false);

  const [actor, setActor] = useState("Chacha");
  const [place, setPlace] = useState("Bhopal");

  const [imageOpenUrl, setImageOpenUrl] = useState(null);

  const qrRef = useRef(null);
  const qrBoxId = "qr-reader";

  // --- FIND LOGIC (Cloud + Local fallback) ---
  async function handleFindItem(idOverride) {
    const id = (idOverride ?? searchId).trim();
    if (!id) {
      setMessage("Enter or scan ItemID.");
      return;
    }

    setBusy(true);
    setMessage("Searching cloud...");
    setItem(null);

    const found = await refetchItemAnySource(id);

    if (!found) {
      setMessage("Item not found (cloud + local).");
      setItem(null);
    } else {
      setItem(found);
      setMessage(`Loaded: ${found.status} (cloud/local)`);
    }

    setBusy(false);
  }

  // --- STATUS UPDATE (Cloud + Local sync, refetch after) ---
  async function updateStatus(newStatus) {
    const id = (item?.itemId || searchId.trim()).trim();
    if (!id) {
      setMessage("No item loaded.");
      return;
    }

    const now = new Date().toISOString();

    // update local store
    const localItems = loadLocalItems();
    const updatedLocal = localItems.map((x) =>
      x.itemId === id ? { ...x, status: newStatus, updatedAt: now } : x
    );
    saveLocalItems(updatedLocal);

    // optimistic UI
    if (item) {
      setItem({ ...item, status: newStatus, updatedAt: now });
    }

    setMessage("Updating status in cloud...");
    setBusy(true);

    try {
      await cloudUpdateStatus(id, newStatus, now);
      await cloudLogEvent({
        itemId: id,
        action:
          newStatus === "SOLD"
            ? "SOLD"
            : newStatus === "RETURNED"
            ? "RETURN"
            : "IN",
        actor,
        place,
      });

      // REFRESH from cloud/local to be 100% sure
      const fresh = await refetchItemAnySource(id);
      if (fresh) setItem(fresh);

      setMessage(`Status synced ✅ (${id} → ${newStatus})`);
    } catch {
      // cloud fail, local already updated
      const localItem =
        updatedLocal.find((x) => x.itemId === id) || item || null;
      if (localItem) setItem(localItem);
      setMessage(`Cloud sync failed ⚠ (${id}) – local updated only.`);
    } finally {
      setBusy(false);
    }
  }

  // --- CAMERA SCAN ---
  async function startScan() {
    setMessage("");

    // clean old scanner if any
    if (qrRef.current) {
      try {
        await qrRef.current.stop();
        await qrRef.current.clear();
      } catch {}
      qrRef.current = null;
    }

    const qr = new Html5Qrcode(qrBoxId);
    qrRef.current = qr;

    try {
      await qr.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          // ✅ pehla kaam: camera turant band
          if (qrRef.current) {
            try {
              await qrRef.current.stop();
              await qrRef.current.clear();
            } catch {}
            qrRef.current = null;
          }

          const clean = decodedText.trim();
          setSearchId(clean);
          setMessage(`Scanned: ${clean}`);

          // ab normal Find logic
          await handleFindItem(clean);
        }
      );
    } catch (e) {
      setMessage(
        "Camera start failed. Mobile pe https ya same Wi-Fi + permission check karo."
      );
      try {
        if (qrRef.current) {
          await qrRef.current.stop();
          await qrRef.current.clear();
        }
      } catch {}
      qrRef.current = null;
    }
  }

  useEffect(() => {
    return () => {
      if (qrRef.current) {
        qrRef.current.stop().catch(() => {});
        qrRef.current.clear().catch(() => {});
        qrRef.current = null;
      }
    };
  }, []);

  const statusLabel = useMemo(() => {
    return item?.status || "—";
  }, [item]);

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-md px-4 py-8">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-5 shadow-sm">
          <div className="mb-4">
            <div className="text-sm tracking-widest text-white/70">
              ANNVI GOLD
            </div>
            <h1 className="mt-1 text-2xl font-semibold">Scan / Lookup</h1>
            <p className="mt-1 text-sm text-white/60">
              Camera QR scan + manual search (Cloud + Local)
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 mb-4">
            <div>
              <label className="text-sm text-white/70">Actor (who)</label>
              <input
                value={actor}
                onChange={(e) => setActor(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
              />
            </div>
            <div>
              <label className="text-sm text-white/70">Place</label>
              <input
                value={place}
                onChange={(e) => setPlace(e.target.value)}
                className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
              />
            </div>
          </div>

          <div className="flex gap-3 mb-3">
            <button
              type="button"
              onClick={() => doLogout(router)}
              className="rounded-lg border border-white/20 bg-black/30 px-3 py-2 text-xs text-white/70 hover:border-white/40"
            >
              Logout
            </button>

            <button
              onClick={startScan}
              disabled={busy}
              className="flex-1 rounded-xl bg-white px-4 py-2 font-semibold text-black hover:bg-white/90 disabled:opacity-60"
            >
              Start Camera Scan
            </button>
            <button
              onClick={() => handleFindItem()}
              disabled={busy}
              className="flex-1 rounded-xl border border-white/15 bg-black/30 px-4 py-2 font-semibold text-white/80 hover:border-white/30 disabled:opacity-60"
            >
              Find Item
            </button>
          </div>

          <div className="rounded-xl border border-white/10 bg-black/30 p-3 mb-3">
            <div className="text-sm text-white/60 mb-1">Camera Preview</div>
            <div
              id={qrBoxId}
              className="rounded-xl overflow-hidden border border-white/10 bg-black/40"
            />
            <div className="mt-2 text-xs text-white/40">
              Tip: Mobile pe first time permission popup aayega – Allow karna.
            </div>
          </div>

          <div className="mb-3">
            <label className="text-sm text-white/70">ItemID</label>
            <input
              value={searchId}
              onChange={(e) => setSearchId(e.target.value)}
              placeholder="e.g. AG-26-000003"
              className="mt-1 w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 outline-none focus:border-white/30"
            />
          </div>

          {message ? (
            <div className="mb-3 rounded-xl border border-white/10 bg-black/30 p-3 text-sm text-white/70">
              {message}
            </div>
          ) : null}

          <div className="rounded-2xl border border-white/10 bg-black/30 p-4">
            <div className="text-sm text-white/60">Item Details</div>

            {!item ? (
              <div className="mt-2 text-sm text-white/50">
                No item loaded. Scan or search by ItemID.
              </div>
            ) : (
              <>
                <div className="mt-2 flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="text-lg font-semibold">{item.itemId}</div>
                    <div className="mt-1 text-sm text-white/70">
                      Design: {item.designNo}
                    </div>
                    <div className="mt-1 text-sm text-white/60">
                      {item.karat} | Gross {format3(item.grossWt)} | Less{" "}
                      {format3(item.lessWt)} | Net {format3(item.netWt)}
                    </div>

                    <div className="mt-2 text-sm">
                      Status:{" "}
                      <span className="font-semibold text-white/80">
                        {statusLabel}
                      </span>
                    </div>
                  </div>

                  {item.imageUrl ? (
                    <div
                      className="h-16 w-16 cursor-pointer overflow-hidden rounded-lg border border-white/20 bg-black/40"
                      title="Tap to enlarge"
                      onClick={() => setImageOpenUrl(item.imageUrl)}
                    >
                      <img
                        src={item.imageUrl}
                        alt={item.itemId}
                        className="h-full w-full object-cover"
                      />
                    </div>
                  ) : null}
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2">
                  <button
                    onClick={() => updateStatus("SOLD")}
                    disabled={busy}
                    className="rounded-xl bg-white px-3 py-2 text-sm font-semibold text-black hover:bg-white/90 disabled:opacity-60"
                  >
                    SOLD
                  </button>
                  <button
                    onClick={() => updateStatus("RETURNED")}
                    disabled={busy}
                    className="rounded-xl border border-white/20 bg-transparent px-3 py-2 text-sm font-semibold text-white/80 hover:border-white/40 disabled:opacity-60"
                  >
                    RETURN
                  </button>
                  <button
                    onClick={() => updateStatus("IN_STOCK")}
                    disabled={busy}
                    className="rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm text-white/70 hover:border-white/30 disabled:opacity-60"
                  >
                    IN
                  </button>
                </div>

                <div className="mt-3 text-xs text-white/45">
                  Note: Cloud + local dono update hote hain.
                </div>
              </>
            )}
          </div>

          <div className="mt-4 text-center text-xs text-white/35">
            URL: /scan
          </div>
        </div>
      </div>

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
