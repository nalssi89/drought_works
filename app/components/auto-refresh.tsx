"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function AutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, 300_000);
    return () => window.clearInterval(timer);
  }, [router]);

  return null;
}
