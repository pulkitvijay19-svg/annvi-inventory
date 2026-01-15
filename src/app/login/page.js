"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const EXPECTED_PIN = process.env.NEXT_PUBLIC_INVENTORY_PIN || "";

export default function LoginPage() {
  const router = useRouter();
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  // Already logged in? Direct /add
  useEffect(() => {
    if (typeof window === "undefined") return;
    const loggedIn = window.localStorage.getItem("annvi_logged_in") === "1";
    if (loggedIn) router.replace("/add");
  }, [router]);

  function handleSubmit(e) {
    e.preventDefault();
    setError("");

    if (!EXPECTED_PIN) {
      setError("PIN is not configured. Contact admin.");
      return;
    }

    if (pin.trim() === EXPECTED_PIN) {
      if (typeof window !== "undefined") {
        window.localStorage.setItem("annvi_logged_in", "1");
      }
      router.replace("/add");
    } else {
      setError("Galat PIN hai. Dobara try karo.");
    }
  }

  return (
    <main className="min-h-screen bg-black text-white flex items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-white/5 p-6 shadow-lg">
        <div className="mb-4 text-center">
          <div className="text-xs tracking-[0.28em] text-white/60">
            ANNVI GOLD
          </div>
          <h1 className="mt-2 text-2xl font-semibold">Inventory Login</h1>
          <p className="mt-1 text-xs text-white/60">
            Factory use only – enter access PIN.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="text-sm text-white/70">Access PIN</label>
            <input
              type="password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="mt-1 w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/40"
              placeholder="••••••"
              autoFocus
            />
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/60 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}

          <button
            type="submit"
            className="w-full rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-white/90"
          >
            Unlock Inventory
          </button>
        </form>

        <p className="mt-4 text-[10px] text-center text-white/40">
          TIP: PIN change karna ho to Vercel &amp; .env.local dono jagah update
          karo.
        </p>
      </div>
    </main>
  );
}
