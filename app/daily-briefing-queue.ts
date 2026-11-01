import { recordedArticleNarrationSections } from "./headline-audio.ts";
import type { DailyBriefingStory } from "./daily-briefing.ts";

export interface BriefingQueueStoryItem {
  url: string;
  title: string;
  source: string;
  imageUrl: string;
  parts: string[];
  partIndex: number;
}

export interface BriefingQueueSink {
  saved(): { items: ReadonlyArray<{ url: string }> };
  add(story: BriefingQueueStoryItem): unknown;
}

export type QueueBriefingStoriesResult = {
  added: number;
  alreadyQueued: number;
  totalQueued: number;
  firstStory: DailyBriefingStory | null;
};

/**
 * Resolves full reader paragraphs (with graceful summary fallback when offline or paywalled)
 * and pushes the Executive Briefing's lead stories into Signal's Listen Later queue.
 */
export async function queueBriefingLeadStories(
  stories: readonly DailyBriefingStory[],
  queueClient: BriefingQueueSink,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<QueueBriefingStoriesResult> {
  if (!stories || stories.length === 0) {
    return {
      added: 0,
      alreadyQueued: 0,
      totalQueued: queueClient.saved().items.length,
      firstStory: null,
    };
  }

  let added = 0;
  let alreadyQueued = 0;

  for (const story of stories) {
    if (!story?.url || !story.title) continue;
    const currentItems = queueClient.saved().items;
    if (currentItems.some((item) => item.url === story.url)) {
      alreadyQueued += 1;
      continue;
    }
    if (currentItems.length >= 10) {
      break;
    }

    let paragraphs: string[] | null = null;
    try {
      const response = await fetcher(
        `/api/article-reader?${new URLSearchParams({ url: story.url })}`,
        {
          credentials: "same-origin",
          cache: "no-store",
          signal,
        },
      );
      if (response.ok) {
        const payload = (await response.json()) as {
          available?: boolean;
          article?: { paragraphs?: string[] };
        };
        if (payload?.available && Array.isArray(payload.article?.paragraphs) && payload.article.paragraphs.length > 0) {
          paragraphs = payload.article.paragraphs;
        }
      }
    } catch {
      // Fall back to summary narration parts so offline or blocked stories still queue cleanly
    }

    const fallbackBody = (story.summary || "").trim();
    const resolvedParagraphs =
      paragraphs && paragraphs.length > 0
        ? paragraphs
        : fallbackBody
          ? [fallbackBody]
          : [`Lead story from ${story.source || "Signal"}.`];

    const parts = recordedArticleNarrationSections(story.title, resolvedParagraphs)
      .map((sec) => sec.text)
      .filter((t) => Boolean(t && t.trim()));

    if (parts.length === 0) continue;

    try {
      queueClient.add({
        url: story.url,
        title: story.title,
        source: story.source || "Signal",
        imageUrl: "",
        parts,
        partIndex: 0,
      });
      added += 1;
    } catch {
      // Respect queue validation / capacity bounds gracefully
      break;
    }
  }

  return {
    added,
    alreadyQueued,
    totalQueued: queueClient.saved().items.length,
    firstStory: stories[0] ?? null,
  };
}
