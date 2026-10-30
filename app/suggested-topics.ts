import { findFollowedTopic, normalizeEntityTopic, type RecognizedEntity } from "./article-entities.ts";

export const ENTITY_HISTORY_STORAGE_KEY = "signal:read-entity-history";

export type StoredEntityRecord = {
  text: string;
  category: string;
  count: number;
  lastSeen: string;
  articles: string[];
};

export type SuggestedTopic = {
  text: string;
  category: string;
  count: number;
};

const ALLOWED_CATEGORIES = new Set(["person", "organization", "location", "product", "event", "skill"]);

export function loadStoredEntityHistory(storage: Storage = localStorage): StoredEntityRecord[] {
  try {
    const raw = storage.getItem(ENTITY_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveStoredEntityHistory(records: StoredEntityRecord[], storage: Storage = localStorage): void {
  try {
    storage.setItem(ENTITY_HISTORY_STORAGE_KEY, JSON.stringify(records.slice(0, 150)));
  } catch {
    // Gracefully handle storage quota or private browsing mode
  }
}

export function recordReadArticleEntities(
  articleUrl: string,
  entities: RecognizedEntity[],
  storage: Storage = localStorage,
): void {
  if (!articleUrl || !entities || entities.length === 0) return;

  const records = loadStoredEntityHistory(storage);
  const recordMap = new Map<string, StoredEntityRecord>(
    records.map((r) => [normalizeEntityTopic(r.text).toLowerCase(), r]),
  );

  const now = new Date().toISOString();

  for (const entity of entities) {
    const normalized = normalizeEntityTopic(entity.text);
    if (normalized.length < 2 || !ALLOWED_CATEGORIES.has(entity.category.toLowerCase())) continue;

    const key = normalized.toLowerCase();
    const existing = recordMap.get(key);

    if (existing) {
      if (!existing.articles.includes(articleUrl)) {
        existing.articles = [...existing.articles.slice(-20), articleUrl];
        existing.count += 1;
        existing.lastSeen = now;
      }
    } else {
      recordMap.set(key, {
        text: normalized,
        category: entity.category,
        count: 1,
        lastSeen: now,
        articles: [articleUrl],
      });
    }
  }

  const updated = Array.from(recordMap.values())
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, 150);

  saveStoredEntityHistory(updated, storage);
}

export function getSuggestedTopics(
  followedTopics: string[],
  limit = 6,
  storage: Storage = localStorage,
): SuggestedTopic[] {
  const records = loadStoredEntityHistory(storage);
  if (records.length === 0) return [];

  return records
    .filter((r) => !findFollowedTopic(followedTopics, r.text))
    .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))
    .slice(0, limit)
    .map((r) => ({
      text: r.text,
      category: r.category,
      count: r.count,
    }));
}
