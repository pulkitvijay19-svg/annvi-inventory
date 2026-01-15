"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isLoggedIn, savePin } from "@/lib/useRequireLogin";

const ACCESS_PIN = process.env.NEXT_PUBLIC_INVENTORY_PIN || "2828"; // jo tumne Vercel env me dala hai

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/add";

  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  // Agar already logged in ho to direct next pe bhej do
  useEffect(() => {
    if (isLoggedIn()) {
      router.replace(next);
    }
  }, [router, next]);

  function handleSubmit(e) {
    e.preventDefault();
    if (pin === ACCESS_PIN) {
      savePin(pin);
      router.replace(next);
    } else {
      setError("Wrong PIN. Try again.");
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-black text-white">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-xs rounded-2xl border border-white/15 bg-white/5 p-5"
      >
        <div className="text-xs tracking-widest text-white/60">ANNVI GOLD</div>
        <h1 className="mt-1 text-xl font-semibold">Inventory Login</h1>
        <p className="mt-1 text-xs text-white/50">
          Factory use only — enter access PIN.
        </p>

        <label className="mt-4 block text-xs text-white/70">
          Access PIN
          <input
            type="password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            className="mt-1 w-full rounded-xl border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none focus:border-white/40"
          />
        </label>

        {error && (
          <div className="mt-2 text-xs text-red-300">
            {error}
          </div>
        )}

        <button
          type="submit"
          className="mt-4 w-full rounded-xl bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-white/90"
        >
          Unlock Inventory
        </button>
      </form>
    </main>
  );
}
