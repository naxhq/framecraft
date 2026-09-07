"use client";

import { useEffect } from "react";

import { onProjectFileOpened, takePendingProjectFile, type OpenedProjectFile } from "@/lib/platform";
import { parseProject } from "@/lib/project";
import { useEditorStore } from "@/store/editor";

/**
 * Double-clicking a `.framecraft` file opens it in the desktop app.
 *
 * Renders nothing. It exists because the two halves of "open with" happen at
 * very different moments: the operating system hands the path to the process
 * as an argument (Windows and Linux) or as an open-documents event (macOS)
 * long before there is a WebView to show it in, and the second double-click of
 * a session arrives at a process that is already running. The Rust side parks
 * the first case and emits the second (`apps/desktop/src-tauri/src/lib.rs`);
 * this component collects both.
 *
 * Mounted from the root layout rather than from the editor so that it is alive
 * for the whole life of the window and cannot miss an event while a route is
 * mounting. In a browser tab every call here is a no-op, so the same bundle
 * ships to Pages unchanged.
 *
 * The file is validated by exactly the same `parseProject` the Load button
 * uses -- a file the OS handed us is no more trustworthy than one a user
 * picked -- and the outcome, whether a migration note or a refusal, goes to
 * the one notice channel the editor already shows for a restored design.
 */
export function DesktopProjectOpener() {
  useEffect(() => {
    let cancelled = false;

    const open = (file: OpenedProjectFile): void => {
      if (cancelled) return;
      const outcome = parseProject(file.text, file.filename);
      const store = useEditorStore.getState();
      if (!outcome.ok) {
        store.setShareNotice(`${file.filename}: ${outcome.reason}`);
        return;
      }
      store.applyProject(outcome.location, outcome.params, outcome.extras);
      // Null when the file was already current, which clears any previous
      // notice rather than leaving a stale one over a freshly opened project.
      store.setShareNotice(outcome.migrated);
    };

    // The launch case, taken exactly once so a WebView reload does not reopen
    // a file the user has moved on from.
    void takePendingProjectFile().then((file) => {
      if (file !== null) open(file);
    });

    const stop = onProjectFileOpened(open);
    return () => {
      cancelled = true;
      stop();
    };
  }, []);

  return null;
}

export default DesktopProjectOpener;
