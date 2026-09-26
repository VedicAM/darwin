/**
 * Research hits: papers and repositories.
 *
 * The card is generic — title, subtitle, identifier, badges, stats, summary —
 * and a *presenter* decides which of those a hit fills in. That is why one
 * component serves both kinds: adding a third kind (a dataset, a protocol) is a
 * presenter, not a card.
 */

import { useState } from "react";
import { BookOpen, ExternalLink, Rss, Star } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "cn";
import type { ResearchArtifact, ResearchItem } from "@/lib/artifacts/types";
import { ArtifactHeader, EmptyState, FieldLabel } from "./primitives";

function openExternal(url: string) {
  // The opener plugin is the only way out of the webview: a plain
  // target=_blank anchor is swallowed. `window.open` is the fallback for the
  // browser-only dev server, where the plugin is not there.
  openUrl(url).catch(() => window.open(url, "_blank", "noopener"));
}

function ItemCard({ item }: { item: ResearchItem }) {
  return (
    <li className="border-border rounded-lg border px-3.5 py-3 transition-colors hover:border-foreground/25">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-foreground text-[12.5px] leading-snug font-medium break-words">
            {item.url ? (
              <button
                type="button"
                onClick={() => openExternal(item.url as string)}
                className="text-left hover:underline"
              >
                {item.title}
              </button>
            ) : (
              item.title
            )}
          </h3>
          {item.subtitle ? (
            <p className="text-muted-foreground mt-0.5 text-[11.5px] leading-snug">{item.subtitle}</p>
          ) : null}
        </div>
        {item.url ? (
          <button
            type="button"
            onClick={() => openExternal(item.url as string)}
            aria-label={`Open ${item.title}`}
            className="text-muted-foreground hover:text-foreground -mt-0.5 shrink-0 rounded-sm p-1 transition-colors"
          >
            <ExternalLink aria-hidden className="size-3.5" />
          </button>
        ) : null}
      </div>

      {item.identifier || item.date || item.stats.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {item.identifier ? (
            <span className="text-muted-foreground/90 font-mono text-[10.5px] break-all">
              {item.identifier}
            </span>
          ) : null}
          {item.date ? (
            <span className="text-muted-foreground font-mono text-[10.5px] tabular-nums">{item.date}</span>
          ) : null}
          {item.stats.map((stat) => (
            <span key={stat.label} className="text-muted-foreground flex items-center gap-1 text-[10.5px]">
              {stat.label === "stars" ? <Star aria-hidden className="size-3" /> : null}
              <span className="font-mono tabular-nums">{stat.value}</span>
              {stat.label}
            </span>
          ))}
        </div>
      ) : null}

      {item.badges.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.badges.map((badge) => (
            <span
              key={badge}
              className="border-border text-muted-foreground rounded-4xl border px-1.5 py-px text-[10px] whitespace-nowrap"
            >
              {badge}
            </span>
          ))}
        </div>
      ) : null}

      {item.summary ? (
        <p className="text-muted-foreground mt-2 line-clamp-4 text-[11.5px] leading-relaxed">
          {item.summary}
        </p>
      ) : null}
    </li>
  );
}

export function ResearchView({ artifact }: { artifact: ResearchArtifact }) {
  const [expanded, setExpanded] = useState(false);
  const { kind, items, notes, query } = artifact;
  const Icon = kind === "paper" ? BookOpen : Rss;
  const visible = expanded ? items : items.slice(0, 12);

  return (
    <>
      <ArtifactHeader
        title={artifact.title}
        subtitle={
          <span className="flex items-center gap-2">
            <span>
              {items.length} {kind === "paper" ? (items.length === 1 ? "paper" : "papers") : "repositories"}
            </span>
            {query ? <span className="text-muted-foreground/80 truncate font-mono">“{query}”</span> : null}
          </span>
        }
        actions={
          <span className="text-muted-foreground flex items-center gap-1.5 text-[10.5px]">
            <Icon aria-hidden className="size-3.5" />
            {kind === "paper" ? "literature" : "code"}
          </span>
        }
      />

      {items.length === 0 ? (
        <EmptyState icon={Icon} title="No results">
          The search returned nothing for this query. Check the tool output in the activity log.
        </EmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {visible.map((item) => (
              <ItemCard key={item.id} item={item} />
            ))}
          </ul>
          {items.length > 12 ? (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className={cn(
                "text-muted-foreground hover:text-foreground mt-3 w-full rounded-md border border-border py-1.5",
                "text-[11.5px] transition-colors",
              )}
            >
              {expanded ? "Show fewer" : `Show all ${items.length}`}
            </button>
          ) : null}

          {notes && notes.length > 0 ? (
            <div className="mt-4">
              <FieldLabel className="mb-1.5">Notes</FieldLabel>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {notes.map((note) => (
                  <li key={note} className="text-muted-foreground text-[11px] leading-relaxed">
                    {note}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
