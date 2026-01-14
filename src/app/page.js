export default function Home() {
  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto max-w-md px-4 py-10">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
          <div className="text-sm tracking-widest text-white/70">ANNVI GOLD</div>
          <h1 className="mt-2 text-3xl font-semibold">Inventory</h1>
          <p className="mt-2 text-sm text-white/60">
            Choose what you want to do
          </p>

          <div className="mt-6 grid gap-3">
            <a
              href="/add"
              className="w-full rounded-xl bg-white px-4 py-3 text-center font-semibold text-black hover:bg-white/90"
            >
              ➕ Add Piece (Upload)
            </a>

            <a
              href="/scan"
              className="w-full rounded-xl border border-white/15 bg-black/30 px-4 py-3 text-center font-semibold text-white/80 hover:border-white/30"
            >
              📷 Scan / Lookup (Sell / Return)
            </a>
          </div>

          <div className="mt-6 text-xs text-white/40">
            Factory: Add Piece • Bhopal: Scan/Status update
          </div>
        </div>
      </div>
    </main>
  );
}
