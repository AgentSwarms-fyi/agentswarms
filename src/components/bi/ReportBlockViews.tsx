// The report designer's preview of the R508 blocks: fields, pictures and
// barcodes. Sized in points from the same constants the PDF renderer uses, so
// the preview takes the room on the page that the printed block will.
import { barcodeShapes } from "@/lib/biBarcode";
import {
  BARCODE_TEXT_H,
  FIELD_ROW_H,
  fieldPairs,
  fieldsCaveat,
  type ReportBlock,
} from "@/lib/biReports";
import { cn } from "@/lib/utils";

const px = (pt: number, scale: number) => `${pt * scale}px`;
const justify = { left: "flex-start", center: "center", right: "flex-end" } as const;

export function ReportFieldsView({
  block,
  scale,
}: {
  block: Extract<ReportBlock, { kind: "fields" }>;
  scale: number;
}) {
  const pairs = fieldPairs(block);
  if (!pairs.length) {
    return (
      <div
        className="text-muted-foreground"
        style={{ fontSize: px(9, scale), height: px(20, scale) }}
      >
        [no row: {block.widget.title || "fields"}]
      </div>
    );
  }
  const per = block.perRow ?? 2;
  const caveat = fieldsCaveat(block);
  return (
    <div>
      {block.widget.title ? (
        <div className="font-semibold" style={{ fontSize: px(10.5, scale), height: px(16, scale) }}>
          {block.widget.title}
        </div>
      ) : null}
      <div className="grid" style={{ gridTemplateColumns: `repeat(${per}, minmax(0, 1fr))` }}>
        {pairs.map((p, i) => (
          <div
            key={i}
            className="flex min-w-0 items-baseline gap-1.5 pr-2"
            style={{ height: px(FIELD_ROW_H, scale), fontSize: px(9, scale) }}
          >
            <span className="shrink-0 text-black/55">{p.label}</span>
            <span className="truncate font-semibold">{p.value}</span>
          </div>
        ))}
      </div>
      {caveat ? (
        <div
          className="text-muted-foreground"
          style={{ fontSize: px(7.5, scale), height: px(12, scale) }}
        >
          {caveat}
        </div>
      ) : null}
    </div>
  );
}

export function ReportImageView({
  block,
  scale,
}: {
  block: Extract<ReportBlock, { kind: "image" }>;
  scale: number;
}) {
  return (
    <div
      className="flex"
      style={{ height: px(block.height, scale), justifyContent: justify[block.align ?? "left"] }}
    >
      {block.src ? (
        <img
          src={block.src}
          alt={block.alt ?? ""}
          className="h-full w-auto max-w-full object-contain"
          referrerPolicy="no-referrer"
        />
      ) : (
        <div
          className="flex h-full w-40 items-center justify-center border border-dashed border-black/20 text-muted-foreground"
          style={{ fontSize: px(9, scale) }}
        >
          No picture chosen
        </div>
      )}
    </div>
  );
}

export function ReportBarcodeView({
  block,
  value,
  scale,
  contentW,
}: {
  block: Extract<ReportBlock, { kind: "barcode" }>;
  /** The value with its tokens already filled. */
  value: string;
  scale: number;
  /** The page's content width in points. */
  contentW: number;
}) {
  const shapes = barcodeShapes(block.format, value, block.height, contentW);
  const showText = block.format === "code128" && block.showText !== false;
  if ("problem" in shapes) {
    return (
      <div
        className="flex items-center text-muted-foreground"
        style={{
          height: px(block.height + (showText ? BARCODE_TEXT_H : 0), scale),
          fontSize: px(9, scale),
        }}
      >
        [barcode: {shapes.problem}]
      </div>
    );
  }
  return (
    <div className="flex" style={{ justifyContent: justify[block.align ?? "left"] }}>
      <div className="flex flex-col items-center">
        <svg
          width={shapes.width * scale}
          height={shapes.height * scale}
          viewBox={`0 0 ${shapes.width} ${shapes.height}`}
          role="img"
          aria-label={`${block.format === "qr" ? "QR code" : "Barcode"}: ${value}`}
          className={cn("block")}
        >
          <rect width={shapes.width} height={shapes.height} fill="#ffffff" />
          {shapes.rects.map((r, i) => (
            <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill="#000000" />
          ))}
        </svg>
        {showText ? (
          <div
            className="font-mono"
            style={{ fontSize: px(8, scale), height: px(BARCODE_TEXT_H, scale) }}
          >
            {value}
          </div>
        ) : null}
      </div>
    </div>
  );
}
