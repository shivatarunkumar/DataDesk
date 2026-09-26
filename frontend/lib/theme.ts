/** Shared between the server (which renders the theme) and the toggle (which sets it). */

export const THEME_COOKIE = "datadesk-theme";

export type Theme = "light" | "dark" | "system";

/** A year: this is a preference, not a session. */
const ONE_YEAR = 60 * 60 * 24 * 365;

/**
 * Store the choice where the *server* can read it, so the next page load renders the
 * right palette in its HTML instead of correcting it after paint. "system" removes the
 * cookie, which is what makes Auto keep following the device.
 */
export function rememberTheme(theme: Theme) {
  const base = `${THEME_COOKIE}=`;
  const attributes = "path=/; SameSite=Lax";
  document.cookie =
    theme === "system"
      ? `${base}; ${attributes}; max-age=0`
      : `${base}${theme}; ${attributes}; max-age=${ONE_YEAR}`;
}

/** Apply it now, so the click feels instant rather than waiting for a navigation. */
export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

/* ------------------------------------------------------------------ look
 * A look is a whole visual style (type, shape, depth, palette), independent of light or
 * dark. "og" is the original forest-and-cream look and needs nothing; any other look is
 * a set of rules in globals.css scoped to html[data-look="…"], so switching back to OG is
 * removing one attribute.
 */

export const LOOK_COOKIE = "datadesk-look";

export type Look = "og" | "aurora" | "glass";

export const LOOKS: { value: Look; label: string; hint: string; swatch: string[] }[] = [
  { value: "og", label: "OG", hint: "Forest green and cream, serif titles", swatch: ["#14543e", "#f2f1ea", "#6fa82f"] },
  {
    value: "aurora",
    label: "Aurora",
    hint: "Ink and indigo, glass and glow",
    swatch: ["#0c0d1f", "#6366f1", "#22d3ee"],
  },
  {
    value: "glass",
    label: "Glass",
    hint: "Floating glass panes over a living colour wallpaper",
    swatch: ["#0a84ff", "#ff6fb5", "#ffc44d"],
  },
];

export function isLook(value: string | undefined): value is Look {
  return LOOKS.some((look) => look.value === value);
}

export function rememberLook(look: Look) {
  const base = `${LOOK_COOKIE}=`;
  const attributes = "path=/; SameSite=Lax";
  document.cookie =
    look === "og" ? `${base}; ${attributes}; max-age=0` : `${base}${look}; ${attributes}; max-age=${ONE_YEAR}`;
}

export function applyLook(look: Look) {
  const root = document.documentElement;
  if (look === "og") root.removeAttribute("data-look");
  else root.setAttribute("data-look", look);
}
