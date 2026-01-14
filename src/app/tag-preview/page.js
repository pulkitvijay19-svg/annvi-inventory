"use client";

import { useEffect, useState, Suspense } from "react";
import QRCode from "react-qr-code";
import { useSearchParams } from "next/navigation";

// Next ko bolo: is page ko hamesha dynamic treat karo
// (static prerender / export ki koshish mat karo)
export const dynamic = "force-dynamic";

function TagPreviewInner() {
  const searchParams = useSearchParams();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // page mount hone ke baad hi print dialog khole
  useEffect(() => {
    if (mounted) {
      window.print();
    }
  }, [mounted]);

  const itemId = searchParams.get("itemId") || "";
  const designNo = searchParams.get("designNo") || "";
  const karat = searchParams.get("karat") || "";
  const grossWt = searchParams.get("grossWt") || "";
  const lessWt = searchParams.get("lessWt") || "";
  const netWt = searchParams.get("netWt") || "";

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
      `}</style>

      <div
        style={{
          width: "100mm",
          height: "12mm",
          background: "#ffffff",
          display: "flex",
          padding: "0.5mm 1mm",
          fontFamily: "Arial, sans-serif",
          color: "#000",
          boxSizing: "border-box",
        }}
      >
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
            {/* QR (11.5mm approx, thoda margin with padding) */}
            <div
              style={{
                width: "12mm",
                height: "11mm",
                padding: "0.3mm",
                boxSizing: "border-box",
              }}
            >
              <QRCode
                value={itemId || "ANNVI GOLD"}
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
                {karat}
              </span>
              <span
                style={{
                  fontSize: "6pt",
                  fontWeight: "bold",
                  marginTop: "0.1mm",
                }}
              >
                D.No: {designNo}
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
              {itemId}
            </span>
            <span
              style={{
                fontSize: "7pt",
                fontWeight: "bold",
                lineHeight: "1.0",
              }}
            >
              G.Wt: {grossWt} g
            </span>
            <span
              style={{
                fontSize: "7pt",
                fontWeight: "bold",
                lineHeight: "1.0",
              }}
            >
              L.Wt: {lessWt} g
            </span>
            <span
              style={{
                fontSize: "7pt",
                fontWeight: "bold",
                lineHeight: "1.0",
              }}
            >
              N.Wt: {netWt} g
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

export default function TagPreviewPage() {
  // useSearchParams hook ko Suspense ke ander rakhna mandatory hai
  return (
    <Suspense fallback={null}>
      <TagPreviewInner />
    </Suspense>
  );
}
