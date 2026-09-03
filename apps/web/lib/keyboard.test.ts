/**
 * The keyboard dispatcher.
 *
 * The load-bearing test is the second block: `city_label`, the engraving texts
 * and the underside template are free text, and B and R are ordinary letters.
 * A shortcut that fires while someone types "Berlin" would start a build in the
 * middle of a word.
 */

import { describe, expect, it } from "vitest";

import { SHORTCUTS, isTypingTarget, shortcutFor } from "./keyboard";

const input = (type: string) => ({ tagName: "INPUT", type });

describe("shortcutFor", () => {
  it("maps the four action keys", () => {
    expect(shortcutFor({ key: "g" })).toBe("generate");
    expect(shortcutFor({ key: "b" })).toBe("export");
    expect(shortcutFor({ key: "r" })).toBe("reset");
    expect(shortcutFor({ key: "?" })).toBe("help");
    expect(shortcutFor({ key: "Escape" })).toBe("dismiss");
  });

  it("accepts the capitals a caps-lock user sends", () => {
    expect(shortcutFor({ key: "G" })).toBe("generate");
    expect(shortcutFor({ key: "B" })).toBe("export");
  });

  it("opens the sheet on Shift+/ as well as on ?", () => {
    expect(shortcutFor({ key: "/", shiftKey: true })).toBe("help");
    // ...but a bare slash is left alone, in case a browser binds it to search.
    expect(shortcutFor({ key: "/" })).toBeNull();
  });

  it("ignores modifier chords, so Ctrl+R still reloads", () => {
    expect(shortcutFor({ key: "r", ctrlKey: true })).toBeNull();
    expect(shortcutFor({ key: "r", metaKey: true })).toBeNull();
    expect(shortcutFor({ key: "b", altKey: true })).toBeNull();
    expect(shortcutFor({ key: "g", shiftKey: true })).toBeNull();
  });

  it("ignores every other key", () => {
    for (const key of ["a", "z", "1", "Enter", "Tab", " ", "F5"]) {
      expect(shortcutFor({ key }), key).toBeNull();
    }
  });

  it("does nothing while the user is typing", () => {
    for (const type of ["text", "number", "color", "email", "search"]) {
      expect(shortcutFor({ key: "b", target: input(type) }), type).toBeNull();
    }
    expect(shortcutFor({ key: "g", target: { tagName: "TEXTAREA" } })).toBeNull();
    expect(shortcutFor({ key: "r", target: { tagName: "SELECT" } })).toBeNull();
    expect(
      shortcutFor({ key: "b", target: { tagName: "DIV", isContentEditable: true } }),
    ).toBeNull();
    // Even the help key: a "?" typed into a city label is a "?".
    expect(shortcutFor({ key: "?", target: input("text") })).toBeNull();
  });

  it("maps Ctrl+Z to undo and Ctrl+Shift+Z to redo", () => {
    expect(shortcutFor({ key: "z", ctrlKey: true })).toBe("undo");
    expect(shortcutFor({ key: "Z", ctrlKey: true })).toBe("undo");
    expect(shortcutFor({ key: "z", ctrlKey: true, shiftKey: true })).toBe("redo");
  });

  it("maps Cmd+Z (metaKey) to undo/redo the same way, for Mac", () => {
    expect(shortcutFor({ key: "z", metaKey: true })).toBe("undo");
    expect(shortcutFor({ key: "z", metaKey: true, shiftKey: true })).toBe("redo");
  });

  it("refuses Ctrl+Z with Alt held, which is not the accelerator on any platform", () => {
    expect(shortcutFor({ key: "z", ctrlKey: true, altKey: true })).toBeNull();
  });

  it("does not hijack a text field's own native undo", () => {
    expect(shortcutFor({ key: "z", ctrlKey: true, target: input("text") })).toBeNull();
    expect(
      shortcutFor({ key: "z", ctrlKey: true, shiftKey: true, target: input("text") }),
    ).toBeNull();
  });

  it("still works with a slider focused, because arrows are its keys", () => {
    // A range input is not a typing target: G/B/R must work from it, and the
    // arrow keys it does answer to are not shortcuts.
    expect(shortcutFor({ key: "g", target: input("range") })).toBe("generate");
    expect(shortcutFor({ key: "ArrowRight", target: input("range") })).toBeNull();
    expect(shortcutFor({ key: "b", target: input("checkbox") })).toBe("export");
    expect(shortcutFor({ key: "b", target: { tagName: "BUTTON" } })).toBe("export");
  });
});

describe("isTypingTarget", () => {
  it("is false for nothing at all", () => {
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(undefined)).toBe(false);
  });

  it("treats a typeless input as text, the way the DOM does", () => {
    expect(isTypingTarget({ tagName: "INPUT" })).toBe(true);
  });

  it("is false for the non-text inputs", () => {
    for (const type of ["range", "checkbox", "radio", "button", "submit"]) {
      expect(isTypingTarget(input(type)), type).toBe(false);
    }
  });
});

describe("the shortcut sheet's own list", () => {
  it("documents every action the dispatcher can produce", () => {
    const documented = new Set(
      SHORTCUTS.map((shortcut) => shortcut.action).filter(
        (action): action is NonNullable<typeof action> => action !== null,
      ),
    );
    expect([...documented].sort()).toEqual(
      ["export", "dismiss", "generate", "help", "redo", "reset", "undo"].sort(),
    );
  });

  it("marks display-only rows as such instead of borrowing an action", () => {
    // Tab and the arrow keys are handled by the browser and by native range
    // inputs; the sheet must mention them, and this module must not claim to
    // dispatch them.
    const displayOnly = SHORTCUTS.filter((shortcut) => shortcut.action === null);
    expect(displayOnly.length).toBeGreaterThan(0);
    for (const row of displayOnly) {
      expect(shortcutFor({ key: row.keys })).toBeNull();
    }
  });

  it("gives every row a key and a description", () => {
    for (const shortcut of SHORTCUTS) {
      expect(shortcut.keys.length).toBeGreaterThan(0);
      expect(shortcut.description.length).toBeGreaterThan(0);
    }
  });

  it("tells the reader that Escape also cancels a run in flight", () => {
    // Escape is ONE action with two meanings, resolved by `EditorShell`: it
    // closes the outermost overlay when there is one and cancels the run when
    // there is not. The sheet is the only place a user finds that out, so the
    // row has to say both.
    const escape = SHORTCUTS.find((shortcut) => shortcut.action === "dismiss");
    expect(escape).toBeDefined();
    expect(escape?.description.toLowerCase()).toContain("cancel");
    expect(escape?.description.toLowerCase()).toContain("close");
  });
});
