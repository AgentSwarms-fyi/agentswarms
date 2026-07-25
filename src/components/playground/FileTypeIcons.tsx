// Brand-colored file-type glyphs — recognizable, open-source stand-ins for
// PowerPoint / Excel / Word (our own artwork in each format's familiar accent
// colour, not the vendor logos), so the document buttons read at a glance.
import type { SVGProps } from "react";

function DocGlyph({
  color,
  letter,
  ...props
}: SVGProps<SVGSVGElement> & { color: string; letter: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" {...props}>
      {/* Sheet body with a folded top-right corner. */}
      <path
        d="M6.5 2H14l5 5v13.5A1.5 1.5 0 0 1 17.5 22h-11A1.5 1.5 0 0 1 5 20.5v-17A1.5 1.5 0 0 1 6.5 2Z"
        fill={color}
      />
      <path d="M14 2l5 5h-4a1 1 0 0 1-1-1V2Z" fill="#ffffff" fillOpacity="0.35" />
      {/* Format initial. */}
      <text
        x="12"
        y="17.5"
        textAnchor="middle"
        fontSize="9.5"
        fontWeight="700"
        fontFamily="Arial, Helvetica, sans-serif"
        fill="#ffffff"
      >
        {letter}
      </text>
    </svg>
  );
}

export function WordIcon(props: SVGProps<SVGSVGElement>) {
  return <DocGlyph color="#2B579A" letter="W" {...props} />;
}

export function ExcelIcon(props: SVGProps<SVGSVGElement>) {
  return <DocGlyph color="#217346" letter="X" {...props} />;
}

export function PptIcon(props: SVGProps<SVGSVGElement>) {
  return <DocGlyph color="#C43E1C" letter="P" {...props} />;
}
