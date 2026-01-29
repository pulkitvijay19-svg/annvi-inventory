"use client";

import { useEffect, useMemo, useState, Suspense } from "react";
import QRCode from "react-qr-code";
import { useSearchParams } from "next/navigation";

export const dynamic = "force-dynamic";

const STORAGE_KEY = "annvi_items_v1";

function loadItemsLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function TagBulkInner() {
  const searchParams = useSearchParams();
  const [mounted, setMounted] = useState(false);

  const idsParam = searchParams.get("ids") || "";
  const ids = useMemo(
    () => idsParam.split(",").map((s) => s.trim()).filter(Boolean),
    [idsParam]
  );

  const [items, setItems] = useState([]);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted) return;

    const local = loadItemsLocal();
    const byId = new Map(local.map((x) => [x.itemId, x]));

    const ordered = ids.map((id) => {
      const it = byId.get(id);
      if (it) return it;

      // fallback minimal
      return {
        itemId: id,
        designNo: "",
        karat: "",
        grossWt: "",
        lessWt: "",
        netWt: "",
      };
    });

    setItems(ordered);

    // print after render
    setTimeout(() => window.print(), 350);
  }, [mounted, idsParam]);

  if (!mounted) return null;

  return (
    <>
      <style jsx global>{`
        @page {
          size: 100mm 12mm;
          margin: 0;
        }
        body {
          margin: 0;
          padding: 0;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        .label {
          width: 100mm;
          height: 12mm;
          background: #ffffff;
          display: flex;
          padding: 0.5mm 1mm;
          font-family: Arial, sans-serif;
          color: #000;
          box-sizing: border-box;
        }
        .page-break {
          page-break-after: always;
          break-after: page;
        }
        .page-break:last-child {
          page-break-after: auto;
          break-after: auto;
        }
      `}</style>

      {items.map((x) => (
        <div key={x.itemId} className="page-break">
          <div className="label">
            {/* Total 50mm printable area (25mm + 25mm) */}
            <div style={{ width: "50mm", height: "11mm", display: "flex" }}>
              {/* LEFT 25mm */}
              <div
                style={{
                  width: "25mm",
                  display: "flex",
                  flexDirection: "row",
                }}
              >
                {/* QR */}
                <div
                  style={{
                    width: "12mm",
                    height: "11mm",
                    padding: "0.3mm",
                    boxSizing: "border-box",
                  }}
                >
                  <QRCode
                    value={x.itemId || "ANNVI GOLD"}
                    level="M"
                    style={{ width: "100%", height: "100%" }}
                  />
                </div>

                {/* ANNVI GOLD + karat + D.No */}
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    paddingLeft: "0.5mm",
                  }}
                >
                  <span
                    style={{
                      fontSize: "7pt",
                      fontWeight: "bold",
                      lineHeight: "1.0",
                    }}
                  >
                    ANNVI
                  </span>
                  <span
                    style={{
                      fontSize: "7pt",
                      fontWeight: "bold",
                      lineHeight: "1.0",
                    }}
                  >
                    GOLD
                  </span>
                  <span
                    style={{
                      fontSize: "6pt",
                      fontWeight: "bold",
                      marginTop: "0.1mm",
                    }}
                  >
                    {x.karat || ""}
                  </span>
                  <span
                    style={{
                      fontSize: "6pt",
                      fontWeight: "bold",
                      marginTop: "0.1mm",
                    }}
                  >
                    D.No: {x.designNo || ""}
                  </span>
                </div>
              </div>

              {/* RIGHT 25mm */}
              <div
                style={{
                  width: "25mm",
                  display: "flex",
                  flexDirection: "column",
                  justifyContent: "flex-start",
                  paddingLeft: "1mm",
                  paddingTop: "0mm",
                }}
              >
                <span
                  style={{
                    fontSize: "7pt",
                    fontWeight: "bold",
                    marginBottom: "0.2mm",
                  }}
                >
                  {x.itemId}
                </span>
                <span
                  style={{
                    fontSize: "7pt",
                    fontWeight: "bold",
                    lineHeight: "1.0",
                  }}
                >
                  G.Wt: {x.grossWt || ""} g
                </span>
                <span
                  style={{
                    fontSize: "7pt",
                    fontWeight: "bold",
                    lineHeight: "1.0",
                  }}
                >
                  L.Wt: {x.lessWt || ""} g
                </span>
                <span
                  style={{
                    fontSize: "7pt",
                    fontWeight: "bold",
                    lineHeight: "1.0",
                  }}
                >
                  N.Wt: {x.netWt || ""} g
                </span>
              </div>
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

export default function TagBulkPage() {
  return (
    <Suspense fallback={null}>
      <TagBulkInner />
    </Suspense>
  );
}
