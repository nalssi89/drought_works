"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { millisecondsUntilNextHourlyRefresh } from "../lib/refresh";

export function AutoRefresh() {
  const router = useRouter();

  useEffect(() => {
    let active = true;
    let timer: number | null = null;

    const refreshVisiblePage = () => {
      if (document.visibilityState === "visible") router.refresh();
    };

    const scheduleNextRefresh = () => {
      timer = window.setTimeout(() => {
        if (!active) return;
        refreshVisiblePage();
        scheduleNextRefresh();
      }, millisecondsUntilNextHourlyRefresh());
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") router.refresh();
    };

    scheduleNextRefresh();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [router]);

  return null;
}
