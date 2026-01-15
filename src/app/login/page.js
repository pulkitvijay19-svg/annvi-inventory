import { Suspense } from "react";
import LoginClient from "./LoginClient";

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="min-h-screen flex items-center justify-center bg-black text-white">
          <div className="text-sm text-white/60">Loading login...</div>
        </main>
      }
    >
      <LoginClient />
    </Suspense>
  );
}
