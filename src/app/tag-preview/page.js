"use client";

import { useEffect, useState } from "react";
import QRCode from "react-qr-code";
import { useSearchParams } from "next/navigation";

export default function TagPreviewPage() {
  const searchParams = useSearchParams();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (mounted) window.print();
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
          // thoda kam padding, taaki content 12mm ke andar safe rahe
          padding: "0.25mm 0.6mm",
          fontFamily: "Arial, sans-serif",
          color: "#000",
          boxSizing: "border-box",
        }}
      >
        {/* Left + Right 50mm area */}
        <div
          style={{
            width: "50mm",
            height: "11.5mm", // 12mm se thoda kam, vertical centre ke liye
            display: "flex",
          }}
        >
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
                width: "11.5mm",
                height: "11.5mm",
                padding: "0.25mm", // teen side ~0.25mm margin
                boxSizing: "border-box",
              }}
            >
              <QRCode
                value={itemId || "ANNVI GOLD"}
                level="M"
                style={{ width: "100%", height: "100%" }}
              />
            </div>

            {/* Text Block */}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                paddingLeft: "0.5mm",
                justifyContent: "center",
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
              paddingTop: "0.2mm", // halkasa upar se offset
            }}
          >
            <span
              style={{
                fontSize: "7pt",
                fontWeight: "bold",
                lineHeight: "1.0",
                marginBottom: "0.1mm",
              }}
            >
              {itemId}
            </span>
            <span
              style={{ fontSize: "7pt", fontWeight: "bold", lineHeight: "1.0" }}
            >
              G.Wt: {grossWt} g
            </span>
            <span
              style={{ fontSize: "7pt", fontWeight: "bold", lineHeight: "1.0" }}
            >
              L.Wt: {lessWt} g
            </span>
            <span
              style={{ fontSize: "7pt", fontWeight: "bold", lineHeight: "1.0" }}
            >
              N.Wt: {netWt} g
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
