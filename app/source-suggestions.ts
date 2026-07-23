export type NewsSourceSuggestion = {
  name: string;
  description: string;
  feed: string;
  topicTerms: string[];
  publisherAliases: string[];
  fallbackRank: number;
};

const SOURCE_SUGGESTIONS: NewsSourceSuggestion[] = [
  {
    name: "RNZ New Zealand",
    description: "New Zealand reporting and local headlines",
    feed: "https://www.rnz.co.nz/rss/national.xml",
    topicTerms: ["new zealand", "aotearoa", "auckland", "wellington", "christchurch", "maori", "māori"],
    publisherAliases: ["rnz", "radio new zealand"],
    fallbackRank: 0,
  },
  {
    name: "BBC World",
    description: "Broad international reporting",
    feed: "https://feeds.bbci.co.uk/news/world/rss.xml",
    topicTerms: ["world", "international", "europe", "asia", "africa", "middle east", "united kingdom"],
    publisherAliases: ["bbc", "bbc news"],
    fallbackRank: 1,
  },
  {
    name: "The Guardian World",
    description: "Global news and analysis",
    feed: "https://www.theguardian.com/world/rss",
    topicTerms: ["world", "international", "geopolitics", "war", "diplomacy", "human rights"],
    publisherAliases: ["guardian", "the guardian"],
    fallbackRank: 2,
  },
  {
    name: "Ars Technica",
    description: "Technology, science and digital policy",
    feed: "https://feeds.arstechnica.com/arstechnica/index",
    topicTerms: ["technology", "artificial intelligence", "ai", "software", "cybersecurity", "science", "space", "gaming"],
    publisherAliases: ["ars technica", "ars"],
    fallbackRank: 3,
  },
  {
    name: "RNZ Media & Technology",
    description: "New Zealand technology and media coverage",
    feed: "https://www.rnz.co.nz/rss/media-technology.xml",
    topicTerms: ["technology", "artificial intelligence", "ai", "software", "cybersecurity", "internet", "media", "social media", "robotics"],
    publisherAliases: ["rnz", "radio new zealand"],
    fallbackRank: 4,
  },
  {
    name: "The Guardian Technology",
    description: "Technology companies, products and policy",
    feed: "https://www.theguardian.com/technology/rss",
    topicTerms: ["technology", "artificial intelligence", "ai", "software", "cybersecurity", "internet", "apple", "google", "microsoft", "tesla"],
    publisherAliases: ["guardian", "the guardian"],
    fallbackRank: 5,
  },
  {
    name: "RNZ Environment",
    description: "Climate, conservation and the natural world",
    feed: "https://www.rnz.co.nz/rss/environment.xml",
    topicTerms: ["climate", "environment", "conservation", "renewable energy", "pollution", "weather", "biodiversity"],
    publisherAliases: ["rnz", "radio new zealand"],
    fallbackRank: 6,
  },
  {
    name: "The Guardian Environment",
    description: "Global climate and environmental reporting",
    feed: "https://www.theguardian.com/environment/rss",
    topicTerms: ["climate", "environment", "conservation", "renewable energy", "pollution", "weather", "biodiversity"],
    publisherAliases: ["guardian", "the guardian"],
    fallbackRank: 7,
  },
  {
    name: "RNZ Business",
    description: "New Zealand business and economy",
    feed: "https://www.rnz.co.nz/rss/business.xml",
    topicTerms: ["business", "economy", "finance", "markets", "company", "companies", "banking", "investment", "housing"],
    publisherAliases: ["rnz", "radio new zealand"],
    fallbackRank: 8,
  },
  {
    name: "The Guardian Business",
    description: "International business and financial news",
    feed: "https://www.theguardian.com/business/rss",
    topicTerms: ["business", "economy", "finance", "markets", "company", "companies", "banking", "investment"],
    publisherAliases: ["guardian", "the guardian"],
    fallbackRank: 9,
  },
  {
    name: "RNZ Politics",
    description: "New Zealand government and public policy",
    feed: "https://www.rnz.co.nz/rss/political.xml",
    topicTerms: ["politics", "government", "parliament", "election", "policy", "minister", "national party", "labour party", "greens"],
    publisherAliases: ["rnz", "radio new zealand"],
    fallbackRank: 10,
  },
  {
    name: "NASA News",
    description: "Space missions, astronomy and research",
    feed: "https://www.nasa.gov/news-release/feed/",
    topicTerms: ["space", "nasa", "astronomy", "moon", "mars", "planet", "rocket", "satellite", "universe"],
    publisherAliases: ["nasa"],
    fallbackRank: 11,
  },
  {
    name: "The Guardian Science",
    description: "Research, discoveries and health science",
    feed: "https://www.theguardian.com/science/rss",
    topicTerms: ["science", "research", "health", "medicine", "biology", "physics", "chemistry", "space"],
    publisherAliases: ["guardian", "the guardian"],
    fallbackRank: 12,
  },
  {
    name: "RNZ Sport",
    description: "New Zealand and international sport",
    feed: "https://www.rnz.co.nz/rss/sport.xml",
    topicTerms: ["sport", "rugby", "cricket", "football", "soccer", "tennis", "olympics", "all blacks"],
    publisherAliases: ["rnz", "radio new zealand"],
    fallbackRank: 13,
  },
  {
    name: "The Guardian Sport",
    description: "International sport and analysis",
    feed: "https://www.theguardian.com/sport/rss",
    topicTerms: ["sport", "rugby", "cricket", "football", "soccer", "tennis", "olympics", "formula 1"],
    publisherAliases: ["guardian", "the guardian"],
    fallbackRank: 14,
  },
];

function normalize(value: string) {
  return value
    .toLocaleLowerCase("en-NZ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function containsTerm(text: string, term: string) {
  const normalizedTerm = normalize(term);
  return normalizedTerm.length > 0 && ` ${text} `.includes(` ${normalizedTerm} `);
}

function feedKey(feed: string) {
  const value = feed.trim().replace(/\/+$/, "").toLocaleLowerCase("en-NZ");
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^www\./, "");
    let pathname = url.pathname.replace(/\/+$/, "");

    // Guardian section feeds redirect to a regional edition (for example,
    // /technology/rss -> /uk/technology/rss). Treat those URLs as the same
    // feed so an added suggestion does not continue to show its add button.
    if (hostname === "theguardian.com") {
      pathname = pathname.replace(/^\/(?:uk|us|au|international)(?=\/)/, "");
    }

    return `${hostname}${pathname}${url.search}`;
  } catch {
    return value;
  }
}

function publisherKey(source: NewsSourceSuggestion) {
  return normalize(source.publisherAliases[0] ?? source.name);
}

export function suggestNewsSources(
  topics: string[],
  currentPublishers: string[],
  addedFeeds: string[],
  limit = 4,
) {
  const topicText = normalize(topics.join(" "));
  const publisherText = normalize(currentPublishers.join(" "));
  const added = new Set(addedFeeds.map(feedKey));
  const addedPublishers = new Set(
    SOURCE_SUGGESTIONS
      .filter((source) => added.has(feedKey(source.feed)))
      .map(publisherKey),
  );
  const suggestedPublishers = new Set<string>();

  return SOURCE_SUGGESTIONS
    .filter((source) => !added.has(feedKey(source.feed)) && !addedPublishers.has(publisherKey(source)))
    .map((source) => {
      const topicMatches = source.topicTerms.filter((term) => containsTerm(topicText, term)).length;
      const publisherMatch = source.publisherAliases.some((alias) => containsTerm(publisherText, alias));
      return {
        source,
        score: (topicMatches * 100) + (publisherMatch ? 20 : 0) - source.fallbackRank,
      };
    })
    .sort((left, right) => right.score - left.score || left.source.fallbackRank - right.source.fallbackRank)
    .filter(({ source }) => {
      const key = publisherKey(source);
      if (suggestedPublishers.has(key)) return false;
      suggestedPublishers.add(key);
      return true;
    })
    .slice(0, Math.max(0, limit))
    .map(({ source }) => source);
}
