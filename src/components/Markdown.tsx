/**
 * A small, self-contained Markdown renderer for agent output.
 *
 * Deliberately not `react-markdown`: this app ships in a Tauri webview under a
 * strict CSP and streams text token by token, so a compact renderer that builds
 * a React tree (never `dangerouslySetInnerHTML`) and degrades gracefully on
 * *partial* markdown is a better fit than the micromark/remark tree. An unclosed
 * ``` fence while a reply is still streaming renders as a code block rather than
 * as stray backticks, which is what a reader expects to see mid-stream.
 *
 * Scope is what agent replies actually use: headings, paragraphs, bold, italic,
 * inline code, fenced code, ordered/unordered lists, blockquotes, links and
 * rules. Anything unrecognised falls through as text, never as an error.
 */

import { Fragment, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

/** Only these schemes become clickable links; anything else renders as text so
 *  a `javascript:` URL in model output can never be navigated to. */
function safeHref(url: string): string | null {
  return /^(https?:|mailto:)/i.test(url) ? url : null;
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      // The opener plugin is the only way out of the webview without navigating
      // it away; same pattern as ResearchView. Fall back to a new-window open.
      onClick={(e) => {
        e.preventDefault();
        openUrl(href).catch(() => window.open(href, "_blank", "noopener"));
      }}
      className="text-blue-600 underline decoration-blue-600/40 underline-offset-2 hover:decoration-blue-600 dark:text-blue-400 dark:decoration-blue-400/40"
    >
      {children}
    </a>
  );
}

// Matches the next inline construct: code span, bold, italic, or link. Bold
// alternatives precede italic so `**x**` is not mis-read as two italics.
const INLINE_RE =
  /(`+)([\s\S]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([\s\S]+?)\*|_([\s\S]+?)_|\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;

/** Parse inline markdown into React nodes. Recurses into emphasis and link text
 *  (bounded by `depth`) so `**bold with `code`**` works; code spans are literal. */
function renderInline(text: string, keyPrefix: string, depth = 0): ReactNode[] {
  if (depth > 6 || text === "") return text ? [text] : [];
  const out: ReactNode[] = [];
  let rest = text;
  let i = 0;
  while (rest.length > 0) {
    const m = INLINE_RE.exec(rest);
    if (!m) {
      out.push(rest);
      break;
    }
    if (m.index > 0) out.push(rest.slice(0, m.index));
    const key = `${keyPrefix}-${i++}`;
    if (m[2] !== undefined) {
      // code span
      out.push(
        <code
          key={key}
          className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em] break-words"
        >
          {m[2]}
        </code>,
      );
    } else if (m[3] !== undefined || m[4] !== undefined) {
      out.push(<strong key={key}>{renderInline(m[3] ?? m[4]!, key, depth + 1)}</strong>);
    } else if (m[5] !== undefined || m[6] !== undefined) {
      out.push(<em key={key}>{renderInline(m[5] ?? m[6]!, key, depth + 1)}</em>);
    } else if (m[8] !== undefined) {
      // link: m[7] text, m[8] href
      const href = safeHref(m[8]);
      const label = renderInline(m[7] ?? "", key, depth + 1);
      out.push(href ? <Link key={key} href={href}>{label}</Link> : <Fragment key={key}>{m[0]}</Fragment>);
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

/** Soft line breaks inside a paragraph become <br>, so the model's intended
 *  line structure survives without needing a blank line between every line. */
function withBreaks(text: string, keyPrefix: string): ReactNode[] {
  const lines = text.split("\n");
  return lines.flatMap((line, i) => {
    const nodes = renderInline(line, `${keyPrefix}-l${i}`);
    return i < lines.length - 1 ? [...nodes, <br key={`${keyPrefix}-br${i}`} />] : nodes;
  });
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-[17px] font-semibold mt-1",
  2: "text-[16px] font-semibold mt-1",
  3: "text-[15px] font-semibold",
  4: "text-[14px] font-semibold",
  5: "text-[13px] font-semibold",
  6: "text-[13px] font-medium text-muted-foreground",
};

interface ListItem {
  text: string;
}

/** Split the message into block-level elements. A line-oriented pass: it is not
 *  a full CommonMark parser, but it is predictable and never throws. */
function parseBlocks(src: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const nextKey = () => `b${key++}`;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block. An unterminated fence (still streaming) swallows the
    // rest of the text as code rather than leaking backticks into the prose.
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence when present
      blocks.push(
        <pre
          key={nextKey()}
          className="bg-muted my-1 max-w-full overflow-x-auto rounded-md px-3 py-2 font-mono text-[12px] leading-relaxed"
        >
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Blank line: paragraph separator.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={nextKey()} className="border-border my-2" />);
      i++;
      continue;
    }

    // Heading.
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${level}` as keyof React.JSX.IntrinsicElements;
      blocks.push(
        <Tag key={nextKey()} className={HEADING_CLASS[level]}>
          {renderInline(heading[2].replace(/\s+#+\s*$/, ""), nextKey())}
        </Tag>,
      );
      i++;
      continue;
    }

    // Blockquote: consecutive `>` lines.
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(
        <blockquote
          key={nextKey()}
          className="border-border text-muted-foreground border-l-2 pl-3"
        >
          {withBreaks(quoted.join("\n"), nextKey())}
        </blockquote>,
      );
      continue;
    }

    // Lists: a run of ordered or unordered items.
    const ordered = line.match(/^\s*\d+[.)]\s+/);
    const unordered = line.match(/^\s*[-*+]\s+/);
    if (ordered || unordered) {
      const isOrdered = Boolean(ordered);
      const items: ListItem[] = [];
      const marker = isOrdered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
      while (i < lines.length) {
        const m = lines[i].match(marker);
        if (!m) break;
        items.push({ text: m[1] });
        i++;
      }
      const listKey = nextKey();
      const children = items.map((it, idx) => (
        <li key={`${listKey}-i${idx}`}>{renderInline(it.text, `${listKey}-i${idx}`)}</li>
      ));
      blocks.push(
        isOrdered ? (
          <ol key={listKey} className="list-decimal space-y-0.5 pl-5">
            {children}
          </ol>
        ) : (
          <ul key={listKey} className="list-disc space-y-0.5 pl-5">
            {children}
          </ul>
        ),
      );
      continue;
    }

    // Paragraph: gather until a blank line or the start of another block.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s{0,3}#{1,6}\s+/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*([-*_])(\s*\1){2,}\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    const pKey = nextKey();
    blocks.push(
      <p key={pKey} className="leading-relaxed">
        {withBreaks(para.join("\n"), pKey)}
      </p>,
    );
  }

  return blocks;
}

/** Render agent markdown. `className` styles the block container. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return <div className={className}>{parseBlocks(text)}</div>;
}
