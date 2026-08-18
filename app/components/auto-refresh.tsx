"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { millisecondsUntilNextHourlyRefresh } from "../lib/refresh";

export function AutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, millisecondsUntilNextHourlyRefresh());
    return () => window.clearTimeout(timer);
  }, [router]);

  return null;
}
