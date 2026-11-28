// A text widget set the way its author chose (R500): size, alignment, body
// and heading colours, italic. Dashboards open with titles like a race name
// in large red italic over a white date, which the chat's markdown renderer
// (fixed sizes, underlined headings) cannot set. Only styled text widgets use
// this; an unstyled one keeps the standard look.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { hardBreaks } from "@/components/bi/biDrawHelpers";
import { hexColor, TEXT_BASE_PX, TEXT_HEADING_SCALE, type BiTextStyle } from "@/lib/biDashboards";
import { lastListNumber, numberedListIndent } from "@/lib/listIndent";
import { safeUrl } from "@/lib/safeUrl";
import { cn } from "@/lib/utils";

export function BiTextBlock({ text, style }: { text: string; style: BiTextStyle }) {
  const base = TEXT_BASE_PX[style.size ?? "md"] ?? 14;
  const color = hexColor(style.color);
  const heading = hexColor(style.headingColor) ?? color;
  const h = (scale: number) => ({
    fontSize: `${base * scale}px`,
    lineHeight: 1.15,
    color: heading,
  });
  return (
    <div
      className={cn("flex h-full flex-col justify-center", style.italic && "italic")}
      style={{ fontSize: `${base}px`, textAlign: style.align ?? "left", color }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={{
          h1: ({ children }) => (
            <h1 className="my-0.5 font-black tracking-tight" style={h(TEXT_HEADING_SCALE.h1)}>
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="my-0.5 font-extrabold tracking-tight" style={h(TEXT_HEADING_SCALE.h2)}>
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="my-0.5 font-bold" style={h(TEXT_HEADING_SCALE.h3)}>
              {children}
            </h3>
          ),
          p: ({ children }) => <p className="my-0.5 leading-snug">{children}</p>,
          strong: ({ children }) => <strong className="font-extrabold">{children}</strong>,
          ul: ({ children }) => <ul className="my-1 ml-5 list-disc space-y-0.5">{children}</ul>,
          // `start` is passed on, as in MarkdownMessage: dropping it renumbered
          // every list from 1, so "3. … 4. …" read "1. … 2. …". The indent
          // makes room for a number of two digits or more, as there.
          ol: ({ children, start }) => {
            const indent = numberedListIndent(lastListNumber(start, children));
            return (
              <ol
                start={start}
                className="my-1 ml-5 list-decimal space-y-0.5"
                style={indent ? { marginLeft: indent } : undefined}
              >
                {children}
              </ol>
            );
          },
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2"
            >
              {children}
            </a>
          ),
        }}
      >
        {hardBreaks(text)}
      </ReactMarkdown>
    </div>
  );
}
