"use client";

import Link from "next/link";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto flex max-w-md flex-col gap-6 px-4 py-10">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-sm">
          <div className="text-sm tracking-widest text-white/70">
            ANNVI GOLD
          </div>
          <h1 className="mt-1 text-3xl font-semibold">Inventory</h1>
          <p className="mt-2 text-sm text-white/60">
            Choose what you want to do
          </p>

          <div className="mt-6 space-y-3">
            {/* ADD PIECE */}
            <Link
              href="/add"
              className="block rounded-2xl bg-white px-4 py-4 text-center text-base font-semibold text-black hover:bg-white/90"
            >
              + Add Piece (Upload)
            </Link>

            {/* SCAN / LOOKUP */}
            <Link
              href="/scan"
              className="block rounded-2xl border border-white/15 bg-black/40 px-4 py-4 text-center text-base font-semibold text-white hover:border-white/35"
            >
              📷 Scan / Lookup (Sell / Return)
            </Link>

            {/* ORDERS – NEW BUTTON */}
            <Link
              href="/orders"
              className="block rounded-2xl border border-purple-400/60 bg-black/40 px-4 py-4 text-center text-base font-semibold text-purple-100 hover:border-purple-300"
            >
              🧾 Orders (Add / Status)
            </Link>
          </div>

          <div className="mt-4 text-xs text-white/40">
            Factory: Add Piece • Bhopal: Scan/Status update • Orders: Party wise
            order entry
          </div>
        </div>
      </div>
    </main>
  );
}
