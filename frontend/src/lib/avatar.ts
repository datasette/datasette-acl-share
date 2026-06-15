// Avatar helpers for the share dialog.
//
// profiles returns an avatar image URL per actor, but it 404s when a person
// has no picture (and groups/public never have one). The dialog renders
// an <img> and falls back to a coloured initials chip on error / when no URL is
// available. These pure helpers compute the fallback so they're testable
// without a DOM.

import type { ActorKind } from "./types";
import { ICON_GLOBE, ICON_PEOPLE } from "./icons";

/**
 * Derive up-to-two-character initials from a display name (or, failing that,
 * an id). "Ada Lovelace" → "AL"; "alice" → "A"; "" → "?".
 */
export function initials(nameOrId: string | null | undefined): string {
  const source = (nameOrId ?? "").trim();
  if (!source) return "?";
  const words = source
    .split(/[\s._-]+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) {
    // Single token: first letter only (avatars look cleaner than two letters
    // of one word, which often read as gibberish e.g. "AL" for "alice").
    return (words[0]![0] ?? "?").toUpperCase();
  }
  const first = words[0]![0] ?? "";
  const last = words[words.length - 1]![0] ?? "";
  return (first + last).toUpperCase() || "?";
}

// A small, fixed palette. Chosen for legible white text and to read as
// distinct "person colours" rather than UI chrome.
const PALETTE = [
  "#1f6feb",
  "#8250df",
  "#bf3989",
  "#cf222e",
  "#bc4c00",
  "#9a6700",
  "#1a7f37",
  "#0969a6",
];

/**
 * Deterministically pick a background colour for an initials chip from a
 * stable key (the actor id), so the same person always gets the same colour.
 */
export function avatarColor(key: string | null | undefined): string {
  const s = key ?? "";
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % PALETTE.length;
  return PALETTE[idx]!;
}

/**
 * The icon badge overlaid on an avatar to disambiguate the principal kind,
 * as an inline-SVG string for `{@html}`. Users get no badge (the avatar /
 * initials are enough).
 */
export function kindBadge(kind: ActorKind): string | null {
  switch (kind) {
    case "group":
      return ICON_PEOPLE;
    case "public":
      return ICON_GLOBE;
    default:
      return null;
  }
}
