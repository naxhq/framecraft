"use client";

import { useEffect } from "react";

import EditorShell from "@/components/editor/EditorShell";
import { installServiceWorker } from "@/lib/serviceWorker";

/**
 * `/` is the whole product (01: "Land on `/`"). Every interactive part lives
 * under `EditorShell`, which is a client component because the editor is one
 * big piece of shared state; this page is a client component too, for the two
 * things that can only be said once the app is actually running in a browser.
 *
 * `data-fc-ready` on the document element is the signal the first-run status
 * line in `layout.tsx` waits for: React has mounted and the editor is live.
 * It is an attribute rather than a store field on purpose, because the script
 * that reads it runs before any bundle does.
 *
 * `installServiceWorker` is a no-op outside a production build (see
 * `lib/serviceWorker.ts`), so `next dev` keeps its Fast Refresh.
 */
export default function Home() {
  useEffect(() => {
    document.documentElement.dataset.fcReady = "1";
    installServiceWorker();
  }, []);
  return <EditorShell />;
}
