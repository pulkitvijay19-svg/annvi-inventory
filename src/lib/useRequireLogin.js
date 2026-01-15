"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

const PIN_KEY = "annvi_inventory_access_pin";

// ---- helpers ----
export function isLoggedIn() {
  if (typeof window === "undefined") return false;
  return !!window.localStorage.getItem(PIN_KEY);
}

export function savePin(pin) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(PIN_KEY, pin);
}

export function clearPin() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(PIN_KEY);
}

// Logout helper – component se call karne ke liye
export function doLogout(router) {
  if (typeof window === "undefined") return;
  clearPin();
  router.replace("/login");
}

// Pages jahan login mandatory hai unpe yeh hook use karo
export function useRequireLogin() {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Login page par kabhi redirect mat karna
    if (pathname === "/login") return;

    const stored = window.localStorage.getItem(PIN_KEY);

    if (!stored) {
      // next = current page
      const next = pathname || "/add";
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [router, pathname]);
}
