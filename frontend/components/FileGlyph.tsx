import { JsonIcon, SheetIcon } from "./icons";

/** The coloured file-type icon used in lists and headers. */
export function FileGlyph({ format, size = 24 }: { format: string; size?: number }) {
  const Glyph = format === "json" ? JsonIcon : SheetIcon;
  return <Glyph width={size} height={size} className="shrink-0" />;
}
