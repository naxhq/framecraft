"use client";

import { useEffect } from "react";

import { useEditorStore } from "@/store/editor";

/**
 * Light / dark toggle. The first-run default is the OS preference and the
 * choice is persisted in localStorage; the pre-paint script in app/layout.tsx
 * applies it before React hydrates, so there is no flash.
 */
export function ThemeToggle() {
  const theme = useEditorStore((state) => state.theme);
  const toggleTheme = useEditorStore((state) => state.toggleTheme);
  const initTheme = useEditorStore((state) => state.initTheme);

  useEffect(() => {
    initTheme();
  }, [initTheme]);

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
      data-testid="theme-toggle"
      className="rounded-md border border-neutral-300 px-2 py-1 text-xs hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
    >
      {theme === "dark" ? "Light" : "Dark"}
    </button>
  );
}

export default ThemeToggle;
