"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function useRequireLogin() {
  const router = useRouter();

  useEffect(() => {
    if (typeof window === "undefined") return;

    const loggedIn = window.localStorage.getItem("annvi_logged_in") === "1";

    if (!loggedIn) {
      router.replace("/login");
    }
  }, [router]);
}
