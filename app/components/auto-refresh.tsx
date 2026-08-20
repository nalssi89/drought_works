"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { millisecondsUntilNextHourlyRefresh } from "../lib/refresh";

export function AutoRefresh({ enabled }: Readonly<{ enabled: boolean }>) {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) return undefined;
    let timer: number | undefined;
    let target = 0;

    const schedule = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      const delay = millisecondsUntilNextHourlyRefresh();
      target = Date.now() + delay;
      timer = window.setTimeout(() => {
        if (document.visibilityState === "visible") router.refresh();
        schedule();
      }, delay);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible" && Date.now() >= target) router.refresh();
      schedule();
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [enabled, router]);

  return null;
}
