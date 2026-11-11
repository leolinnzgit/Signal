export type NewsSourceSuggestion = {
  name: string;
  description: string;
  feed: string;
  topicTerms: string[];
  publisherAliases: string[];
  fallbackRank: number;
};

export const SOURCE_SUGGESTIONS: NewsSourceSuggestion[] = [
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
    feed: "https://www.theguardian.com/uk/technology/rss",
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
    feed: "https://www.theguardian.com/uk/environment/rss",
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
    feed: "https://www.theguardian.com/uk/business/rss",
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
    feed: "https://www.theguardian.com/uk/sport/rss",
    topicTerms: ["sport", "rugby", "cricket", "football", "soccer", "tennis", "olympics", "formula 1"],
    publisherAliases: ["guardian", "the guardian"],
    fallbackRank: 14,
  },
  {
    name: "MIT Technology Review",
    description: "AI breakthroughs, computing and tech policy",
    feed: "https://www.technologyreview.com/feed/",
    topicTerms: ["artificial intelligence", "ai", "robotics", "robot", "robots", "humanoid", "quantum", "quantum technology", "biotech", "computing", "computer science", "technology", "openai", "anthropic", "semiconductor"],
    publisherAliases: ["mit technology review", "technology review"],
    fallbackRank: 15,
  },
  {
    name: "IEEE Spectrum",
    description: "Engineering, robotics, chips and quantum systems",
    feed: "https://spectrum.ieee.org/feeds/feed.rss",
    topicTerms: ["robotics", "robot", "robots", "humanoid", "optimus", "semiconductor", "semiconductors", "chips", "nvidia", "tsmc", "quantum", "quantum technology", "artificial intelligence", "ai", "computing", "computer science"],
    publisherAliases: ["ieee spectrum", "ieee"],
    fallbackRank: 16,
  },
  {
    name: "OpenAI News",
    description: "Official OpenAI research and model releases",
    feed: "https://openai.com/news/rss.xml",
    topicTerms: ["openai", "chatgpt", "gpt", "artificial intelligence", "ai", "machine learning", "llm"],
    publisherAliases: ["openai"],
    fallbackRank: 17,
  },
  {
    name: "The Robot Report",
    description: "Humanoids, industrial robotics and automation",
    feed: "https://www.therobotreport.com/feed/",
    topicTerms: ["robot", "robots", "robotics", "humanoid", "optimus", "automation", "autonomous", "drone"],
    publisherAliases: ["the robot report", "robot report"],
    fallbackRank: 18,
  },
  {
    name: "Wccftech",
    description: "GPUs, semiconductors, NVIDIA, AMD and hardware",
    feed: "https://wccftech.com/feed/",
    topicTerms: ["nvidia", "nvda", "amd", "intel", "tsmc", "gpu", "semiconductor", "semiconductors", "apple", "hardware", "ai", "jensen huang", "輝達", "黃仁勳"],
    publisherAliases: ["wccftech"],
    fallbackRank: 19,
  },
  {
    name: "Wired",
    description: "Technology, cybersecurity, science and culture",
    feed: "https://www.wired.com/feed/rss",
    topicTerms: ["technology", "artificial intelligence", "ai", "cybersecurity", "security", "science", "space", "internet", "privacy", "google", "apple", "microsoft", "openai"],
    publisherAliases: ["wired"],
    fallbackRank: 20,
  },
  {
    name: "TechCrunch",
    description: "Startups, venture capital and AI companies",
    feed: "https://techcrunch.com/feed/",
    topicTerms: ["startups", "venture capital", "artificial intelligence", "ai", "openai", "anthropic", "robotics", "crypto", "google", "apple", "microsoft", "tesla", "technology"],
    publisherAliases: ["techcrunch"],
    fallbackRank: 21,
  },
  {
    name: "The Verge",
    description: "Consumer technology, software and platforms",
    feed: "https://www.theverge.com/rss/index.xml",
    topicTerms: ["technology", "apple", "google", "microsoft", "windows", "ai", "artificial intelligence", "tesla", "gaming", "gadgets", "science"],
    publisherAliases: ["the verge", "verge"],
    fallbackRank: 22,
  },
  {
    name: "404 Media",
    description: "Investigative reporting on privacy, AI and security",
    feed: "https://www.404media.co/rss/",
    topicTerms: ["cybersecurity", "security", "privacy", "hacking", "ai", "artificial intelligence", "surveillance", "internet"],
    publisherAliases: ["404 media"],
    fallbackRank: 23,
  },
  {
    name: "ZDNet",
    description: "Enterprise technology, Windows, cloud and AI tools",
    feed: "https://www.zdnet.com/rss/news/",
    topicTerms: ["windows", "microsoft", "ai", "artificial intelligence", "cybersecurity", "security", "cloud", "enterprise", "google", "apple"],
    publisherAliases: ["zdnet"],
    fallbackRank: 24,
  },
  {
    name: "MIT News AI",
    description: "Academic AI, robotics and computer science research",
    feed: "https://news.mit.edu/rss/topic/artificial-intelligence2",
    topicTerms: ["artificial intelligence", "ai", "machine learning", "robotics", "computer science", "research", "quantum"],
    publisherAliases: ["mit news", "mit"],
    fallbackRank: 25,
  },
  {
    name: "9to5Mac",
    description: "Apple hardware, macOS, iOS and silicon coverage",
    feed: "https://9to5mac.com/feed/",
    topicTerms: ["apple", "iphone", "mac", "ios", "macos", "ipad", "silicon"],
    publisherAliases: ["9to5mac"],
    fallbackRank: 26,
  },
  {
    name: "9to5Google",
    description: "Google, Android, Gemini, Gmail and Pixel news",
    feed: "https://9to5google.com/feed/",
    topicTerms: ["google", "android", "gmail", "google photos", "gemini", "pixel", "chrome", "youtube"],
    publisherAliases: ["9to5google"],
    fallbackRank: 27,
  },
  {
    name: "Electrek",
    description: "Electric vehicles, Tesla, batteries and solar",
    feed: "https://electrek.co/feed/",
    topicTerms: ["tesla", "electric vehicles", "ev", "solar", "renewable energy", "battery", "energy", "elon musk", "clean energy"],
    publisherAliases: ["electrek"],
    fallbackRank: 28,
  },
  {
    name: "CleanTechnica",
    description: "Solar power, renewables and grid transition",
    feed: "https://cleantechnica.com/feed/",
    topicTerms: ["solar", "renewable energy", "clean energy", "wind", "climate", "battery", "electric vehicles", "ev", "tesla", "energy"],
    publisherAliases: ["cleantechnica"],
    fallbackRank: 29,
  },
  {
    name: "Teslarati",
    description: "Tesla, SpaceX, Starlink and Elon Musk ventures",
    feed: "https://www.teslarati.com/feed/",
    topicTerms: ["tesla", "spacex", "starlink", "elon musk", "optimus", "grok", "xai", "electric vehicles", "rocket", "space"],
    publisherAliases: ["teslarati"],
    fallbackRank: 30,
  },
  {
    name: "Universe Today",
    description: "Spaceflight, astronomy and planetary exploration",
    feed: "https://www.universetoday.com/rss.xml",
    topicTerms: ["space", "astronomy", "nasa", "spacex", "starlink", "rocket", "moon", "mars", "universe", "satellite"],
    publisherAliases: ["universe today"],
    fallbackRank: 31,
  },
  {
    name: "The New York Times",
    description: "Major US and global reporting",
    feed: "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
    topicTerms: ["usa", "united states", "world", "politics", "economy", "breaking news", "ukraine", "china", "美國", "美國政府", "川普"],
    publisherAliases: ["new york times", "nytimes", "nyt"],
    fallbackRank: 32,
  },
  {
    name: "NPR News",
    description: "US public radio headlines, policy and culture",
    feed: "https://feeds.npr.org/1001/rss.xml",
    topicTerms: ["usa", "united states", "politics", "world", "science", "health", "economy", "美國"],
    publisherAliases: ["npr", "national public radio"],
    fallbackRank: 33,
  },
  {
    name: "PBS NewsHour",
    description: "US national news, policy and world affairs",
    feed: "https://www.pbs.org/newshour/feeds/rss/headlines",
    topicTerms: ["usa", "united states", "politics", "world", "economy", "policy", "ukraine", "breaking news"],
    publisherAliases: ["pbs", "pbs newshour"],
    fallbackRank: 34,
  },
  {
    name: "Al Jazeera",
    description: "Global news, Middle East and international affairs",
    feed: "https://www.aljazeera.com/xml/rss/all.xml",
    topicTerms: ["world", "middle east", "geopolitics", "ukraine", "asia", "africa", "breaking news", "diplomacy"],
    publisherAliases: ["al jazeera", "aljazeera"],
    fallbackRank: 35,
  },
  {
    name: "Deutsche Welle",
    description: "European and global news from Germany",
    feed: "https://rss.dw.com/rdf/rss-en-all",
    topicTerms: ["europe", "germany", "world", "ukraine", "geopolitics", "climate", "economy", "eu"],
    publisherAliases: ["dw", "deutsche welle"],
    fallbackRank: 36,
  },
  {
    name: "France 24",
    description: "International breaking news from Europe",
    feed: "https://www.france24.com/en/rss",
    topicTerms: ["europe", "france", "world", "africa", "middle east", "ukraine", "geopolitics", "diplomacy"],
    publisherAliases: ["france 24", "france24"],
    fallbackRank: 37,
  },
  {
    name: "Euronews",
    description: "Pan-European news, EU policy and global events",
    feed: "https://www.euronews.com/rss?level=theme&name=news",
    topicTerms: ["europe", "eu", "ukraine", "world", "economy", "politics", "energy"],
    publisherAliases: ["euronews"],
    fallbackRank: 38,
  },
  {
    name: "Sky News World",
    description: "UK and global breaking headlines",
    feed: "https://feeds.skynews.com/feeds/rss/world.xml",
    topicTerms: ["world", "united kingdom", "uk", "breaking news", "ukraine", "europe", "middle east"],
    publisherAliases: ["sky news"],
    fallbackRank: 39,
  },
  {
    name: "CBC News",
    description: "Canadian national and international top stories",
    feed: "https://www.cbc.ca/cmlink/rss-topstories",
    topicTerms: ["canada", "north america", "world", "politics", "economy", "climate"],
    publisherAliases: ["cbc", "cbc news"],
    fallbackRank: 40,
  },
  {
    name: "NBC News",
    description: "US breaking news, politics and world coverage",
    feed: "https://feeds.nbcnews.com/nbcnews/public/news",
    topicTerms: ["usa", "united states", "breaking news", "politics", "world", "business"],
    publisherAliases: ["nbc", "nbc news"],
    fallbackRank: 41,
  },
  {
    name: "ABC News (US)",
    description: "US national reporting and live headlines",
    feed: "https://abcnews.com/abcnews/topstories",
    topicTerms: ["usa", "united states", "breaking news", "politics", "world", "weather"],
    publisherAliases: ["abc news us", "abc news"],
    fallbackRank: 42,
  },
  {
    name: "CBS News",
    description: "US breaking news, investigations and world reports",
    feed: "https://www.cbsnews.com/latest/rss/main",
    topicTerms: ["usa", "united states", "breaking news", "politics", "world", "health"],
    publisherAliases: ["cbs", "cbs news"],
    fallbackRank: 43,
  },
  {
    name: "Politico",
    description: "US politics, regulation and policy reporting",
    feed: "https://rss.politico.com/politics-news.xml",
    topicTerms: ["politics", "usa", "united states", "government", "congress", "election", "policy", "美國政府"],
    publisherAliases: ["politico"],
    fallbackRank: 44,
  },
  {
    name: "The Hill",
    description: "US Congress, administration and policy news",
    feed: "https://thehill.com/feed/?feed=partnerfeed-news-feed&format=rss",
    topicTerms: ["politics", "usa", "united states", "congress", "government", "policy", "美國政府"],
    publisherAliases: ["the hill"],
    fallbackRank: 45,
  },
  {
    name: "The Atlantic",
    description: "Long-form analysis on politics, tech and society",
    feed: "https://www.theatlantic.com/feed/all/",
    topicTerms: ["politics", "usa", "culture", "technology", "world", "policy"],
    publisherAliases: ["the atlantic", "atlantic"],
    fallbackRank: 46,
  },
  {
    name: "ProPublica",
    description: "Public-interest investigative journalism",
    feed: "https://www.propublica.org/feeds/propublica/main",
    topicTerms: ["investigation", "politics", "government", "environment", "health", "usa"],
    publisherAliases: ["propublica"],
    fallbackRank: 47,
  },
  {
    name: "Financial Times",
    description: "Global markets, banking, business and geopolitics",
    feed: "https://www.ft.com/rss/home/international",
    topicTerms: ["markets", "stock market", "finance", "economy", "business", "banking", "geopolitics", "investment", "berkshire hathaway", "warren buffett", "central bank"],
    publisherAliases: ["financial times", "ft"],
    fallbackRank: 48,
  },
  {
    name: "Wall Street Journal Markets",
    description: "Equities, central banks and global market moves",
    feed: "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain",
    topicTerms: ["stock market", "markets", "finance", "stocks", "investing", "investment", "nvda", "nvidia", "berkshire hathaway", "warren buffett", "economy", "fed"],
    publisherAliases: ["wall street journal", "wsj"],
    fallbackRank: 49,
  },
  {
    name: "Wall Street Journal Tech",
    description: "Big Tech, AI strategy and semiconductor business",
    feed: "https://feeds.content.dowjones.io/public/rss/RSSWSJD",
    topicTerms: ["technology", "artificial intelligence", "ai", "nvidia", "apple", "google", "microsoft", "openai", "tesla", "tsmc"],
    publisherAliases: ["wall street journal", "wsj"],
    fallbackRank: 50,
  },
  {
    name: "Wall Street Journal World",
    description: "Global diplomacy, trade and geopolitical risk",
    feed: "https://feeds.content.dowjones.io/public/rss/RSSWorldNews",
    topicTerms: ["world", "geopolitics", "economy", "business", "china", "taiwan", "usa", "ukraine", "trade"],
    publisherAliases: ["wall street journal", "wsj"],
    fallbackRank: 51,
  },
  {
    name: "CNBC Technology",
    description: "Tech stocks, AI leaders and Silicon Valley deals",
    feed: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19854910",
    topicTerms: ["nvidia", "nvda", "apple", "microsoft", "google", "tesla", "openai", "anthropic", "ai", "artificial intelligence", "tsmc", "amd", "stocks"],
    publisherAliases: ["cnbc"],
    fallbackRank: 52,
  },
  {
    name: "CNBC Top News",
    description: "US business, Wall Street and macro economy",
    feed: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114",
    topicTerms: ["stock market", "markets", "economy", "business", "finance", "usa", "breaking news", "fed", "inflation"],
    publisherAliases: ["cnbc"],
    fallbackRank: 53,
  },
  {
    name: "CNBC Finance",
    description: "Banking, earnings and Federal Reserve coverage",
    feed: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664",
    topicTerms: ["finance", "banking", "markets", "stock market", "berkshire hathaway", "warren buffett", "investing", "earnings"],
    publisherAliases: ["cnbc"],
    fallbackRank: 54,
  },
  {
    name: "MarketWatch",
    description: "Stock market updates, investing and personal finance",
    feed: "https://feeds.content.dowjones.io/public/rss/mw_topstories",
    topicTerms: ["stock market", "markets", "finance", "investing", "stocks", "berkshire hathaway", "warren buffett", "nvda", "crypto", "economy"],
    publisherAliases: ["marketwatch"],
    fallbackRank: 55,
  },
  {
    name: "The Economist",
    description: "Global economics, geopolitics and world affairs",
    feed: "https://www.economist.com/international/rss.xml",
    topicTerms: ["world", "geopolitics", "economics", "economy", "business", "finance", "china", "usa", "europe"],
    publisherAliases: ["the economist", "economist"],
    fallbackRank: 56,
  },
  {
    name: "Fortune",
    description: "Corporate leadership, markets and tech business",
    feed: "https://fortune.com/feed/fortune-feeds/?id=3230629",
    topicTerms: ["business", "fortune", "markets", "leadership", "ai", "finance", "technology"],
    publisherAliases: ["fortune"],
    fallbackRank: 57,
  },
  {
    name: "CoinDesk",
    description: "Cryptocurrency markets, Bitcoin and digital assets",
    feed: "https://www.coindesk.com/arc/outboundfeeds/rss",
    topicTerms: ["crypto", "cryptocurrency", "bitcoin", "ethereum", "binance", "crypto com", "blockchain", "x money"],
    publisherAliases: ["coindesk"],
    fallbackRank: 58,
  },
  {
    name: "NZ Herald",
    description: "Major New Zealand national and Auckland news",
    feed: "https://www.nzherald.co.nz/arc/outboundfeeds/rss/curated/78/?outputType=xml&_website=nzh",
    topicTerms: ["new zealand", "auckland", "waikato", "hamilton", "wellington", "christchurch", "breaking news", "weather warning", "metservice", "christopher luxon", "奧克蘭"],
    publisherAliases: ["nz herald", "new zealand herald"],
    fallbackRank: 59,
  },
  {
    name: "Stuff NZ",
    description: "New Zealand breaking news, regions and weather",
    feed: "https://www.stuff.co.nz/rss/",
    topicTerms: ["new zealand", "auckland", "wellington", "hamilton", "waikato", "christchurch", "weather warning", "metservice", "christopher luxon", "sport"],
    publisherAliases: ["stuff", "stuff nz"],
    fallbackRank: 60,
  },
  {
    name: "Newsroom NZ",
    description: "New Zealand investigative reporting and policy",
    feed: "https://newsroom.co.nz/feed/",
    topicTerms: ["new zealand", "aotearoa", "politics", "policy", "climate", "environment", "economy", "waikato", "auckland", "contact energy"],
    publisherAliases: ["newsroom", "newsroom nz"],
    fallbackRank: 61,
  },
  {
    name: "The Conversation NZ",
    description: "Expert analysis on New Zealand and world issues",
    feed: "https://theconversation.com/nz/articles.atom",
    topicTerms: ["new zealand", "aotearoa", "science", "climate", "economy", "politics", "health", "maori", "māori", "waikato university"],
    publisherAliases: ["the conversation", "conversation"],
    fallbackRank: 62,
  },
  {
    name: "The Conversation Global",
    description: "Research-backed global news and analysis",
    feed: "https://theconversation.com/global/articles.atom",
    topicTerms: ["science", "politics", "world", "climate", "economy", "health", "ai", "technology"],
    publisherAliases: ["the conversation", "conversation"],
    fallbackRank: 63,
  },
  {
    name: "ABC News Australia",
    description: "Australian public broadcaster and Pacific headlines",
    feed: "https://www.abc.net.au/news/feed/51120/rss.xml",
    topicTerms: ["australia", "brisbane", "sydney", "melbourne", "pacific", "world", "breaking news"],
    publisherAliases: ["abc australia", "abc news australia"],
    fallbackRank: 64,
  },
  {
    name: "Sydney Morning Herald",
    description: "Australian national, business and regional news",
    feed: "https://www.smh.com.au/rss/feed.xml",
    topicTerms: ["australia", "sydney", "brisbane", "business", "world", "politics"],
    publisherAliases: ["sydney morning herald", "smh"],
    fallbackRank: 65,
  },
  {
    name: "SBS News Australia",
    description: "Australian, Asia-Pacific and multicultural reporting",
    feed: "https://www.sbs.com.au/news/feed",
    topicTerms: ["australia", "brisbane", "world", "asia", "pacific"],
    publisherAliases: ["sbs", "sbs news"],
    fallbackRank: 66,
  },
  {
    name: "Nikkei Asia",
    description: "Asian business, TSMC, Japan and tech supply chains",
    feed: "https://asia.nikkei.com/rss/feed/nar",
    topicTerms: ["asia", "japan", "tokyo", "taiwan", "tsmc", "china", "semiconductor", "semiconductors", "economy", "business", "supply chain", "beijing", "taipei"],
    publisherAliases: ["nikkei asia", "nikkei"],
    fallbackRank: 67,
  },
  {
    name: "South China Morning Post",
    description: "Greater China, Asia geopolitics and technology",
    feed: "https://www.scmp.com/rss/91/feed/",
    topicTerms: ["china", "beijing", "hong kong", "taiwan", "asia", "geopolitics", "technology", "trade", "中國"],
    publisherAliases: ["scmp", "south china morning post"],
    fallbackRank: 68,
  },
  {
    name: "Channel NewsAsia",
    description: "Singapore and Asia-Pacific breaking news",
    feed: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml",
    topicTerms: ["asia", "singapore", "china", "taiwan", "japan", "world", "business"],
    publisherAliases: ["channel newsasia", "channelnewsasia"],
    fallbackRank: 69,
  },
  {
    name: "The Straits Times",
    description: "Southeast Asia and international headlines",
    feed: "https://www.straitstimes.com/news/world/rss.xml",
    topicTerms: ["asia", "singapore", "southeast asia", "world", "china", "geopolitics"],
    publisherAliases: ["straits times", "the straits times"],
    fallbackRank: 70,
  },
  {
    name: "Yonhap News",
    description: "South Korean news, semiconductors and East Asia",
    feed: "https://en.yna.co.kr/RSS/news.xml",
    topicTerms: ["korea", "south korea", "asia", "semiconductor", "semiconductors", "technology", "world"],
    publisherAliases: ["yonhap", "yonhap news"],
    fallbackRank: 71,
  },
  {
    name: "TechNews 科技新報",
    description: "Taiwan semiconductor, AI, energy and tech industry",
    feed: "https://technews.tw/feed/",
    topicTerms: ["taiwan", "tsmc", "nvidia", "amd", "ai", "semiconductor", "semiconductors", "solar", "renewable energy", "台灣", "臺灣", "台積電", "輝達", "黃仁勳", "人工智慧"],
    publisherAliases: ["technews", "科技新報"],
    fallbackRank: 72,
  },
  {
    name: "DigiTimes",
    description: "Asian electronics supply chain and chip foundries",
    feed: "https://www.digitimes.com/rss/daily.xml",
    topicTerms: ["tsmc", "taiwan", "semiconductor", "semiconductors", "nvidia", "amd", "apple", "supply chain", "chips", "ai"],
    publisherAliases: ["digitimes"],
    fallbackRank: 73,
  },
  {
    name: "Focus Taiwan (CNA)",
    description: "English Taiwan news from Central News Agency",
    feed: "https://feeds.feedburner.com/rsscna/engnews",
    topicTerms: ["taiwan", "taipei", "tsmc", "politics", "cross strait", "asia", "economy"],
    publisherAliases: ["focus taiwan", "cna taiwan", "central news agency"],
    fallbackRank: 74,
  },
  {
    name: "CNA Taiwan Technology",
    description: "Mandarin Taiwan tech, AI and semiconductor news",
    feed: "https://feeds.feedburner.com/rsscna/technology",
    topicTerms: ["taiwan", "tsmc", "ai", "nvidia", "台灣", "臺灣", "台積電", "輝達", "黃仁勳"],
    publisherAliases: ["focus taiwan", "cna taiwan", "central news agency"],
    fallbackRank: 75,
  },
  {
    name: "CNA Taiwan Finance",
    description: "Mandarin Taiwan financial markets and economy",
    feed: "https://feeds.feedburner.com/rsscna/finance",
    topicTerms: ["taiwan", "markets", "finance", "economy", "台灣", "臺灣", "台積電", "股市"],
    publisherAliases: ["focus taiwan", "cna taiwan", "central news agency"],
    fallbackRank: 76,
  },
  {
    name: "Taipei Times",
    description: "English Taiwan politics, business and regional news",
    feed: "https://www.taipeitimes.com/xml/index.rss",
    topicTerms: ["taiwan", "taipei", "tsmc", "asia", "politics", "business"],
    publisherAliases: ["taipei times"],
    fallbackRank: 77,
  },
  {
    name: "PTS News 公視新聞網",
    description: "Taiwan public television Mandarin news",
    feed: "https://news.pts.org.tw/xml/newsfeed.xml",
    topicTerms: ["taiwan", "taipei", "台灣", "臺灣", "台北", "臺北"],
    publisherAliases: ["pts", "pts news", "公視"],
    fallbackRank: 78,
  },
  {
    name: "Liberty Times 自由時報",
    description: "Taiwan Mandarin breaking news and politics",
    feed: "https://news.ltn.com.tw/rss/all.xml",
    topicTerms: ["taiwan", "taipei", "台灣", "臺灣", "台北", "中國", "美國", "黃仁勳", "輝達"],
    publisherAliases: ["liberty times", "ltn", "自由時報"],
    fallbackRank: 79,
  },
  {
    name: "Inside 硬塞",
    description: "Taiwan Mandarin AI, startup and tech trend coverage",
    feed: "https://www.inside.com.tw/feed/rss",
    topicTerms: ["taiwan", "ai", "artificial intelligence", "technology", "google", "openai", "台灣", "臺灣", "人工智慧", "輝達"],
    publisherAliases: ["inside", "硬塞"],
    fallbackRank: 80,
  },
  {
    name: "Bnext 數位時代",
    description: "Taiwan digital economy, AI tools and chip business",
    feed: "https://rss.bnextmedia.com.tw/feed/bnext/rss",
    topicTerms: ["taiwan", "ai", "tsmc", "nvidia", "business", "台灣", "臺灣", "台積電", "輝達", "人工智慧"],
    publisherAliases: ["bnext", "數位時代"],
    fallbackRank: 81,
  },
  {
    name: "Newtalk 新頭殼",
    description: "Taiwan Mandarin politics and current affairs",
    feed: "https://newtalk.tw/rss/all",
    topicTerms: ["taiwan", "taipei", "台灣", "臺灣", "台北", "中國", "美國"],
    publisherAliases: ["newtalk", "新頭殼"],
    fallbackRank: 82,
  },
  {
    name: "The Reporter 報導者",
    description: "Taiwan in-depth investigative journalism",
    feed: "https://public.twreporter.org/rss/twreporter-rss.xml",
    topicTerms: ["taiwan", "investigation", "台灣", "臺灣", "社會", "深度報導"],
    publisherAliases: ["the reporter", "twreporter", "報導者"],
    fallbackRank: 83,
  },
  {
    name: "RTHK Greater China",
    description: "Hong Kong public broadcaster Greater China news",
    feed: "https://rthk9.rthk.hk/rthk/news/rss/c_expressnews_greaterchina.xml",
    topicTerms: ["china", "hong kong", "taiwan", "beijing", "中國", "香港", "台灣"],
    publisherAliases: ["rthk", "rthk hk"],
    fallbackRank: 84,
  },
  {
    name: "Nature",
    description: "Scientific research, climate, biology and physics",
    feed: "https://www.nature.com/nature.rss",
    topicTerms: ["science", "research", "biology", "physics", "quantum", "climate", "health", "medicine", "ai"],
    publisherAliases: ["nature"],
    fallbackRank: 85,
  },
  {
    name: "Science (AAAS)",
    description: "Scientific discoveries, health and research policy",
    feed: "https://www.science.org/rss/news_current.xml",
    topicTerms: ["science", "research", "physics", "biology", "climate", "health", "space"],
    publisherAliases: ["science aaas", "science magazine"],
    fallbackRank: 86,
  },
  {
    name: "New Scientist",
    description: "Science, physics, quantum tech and health",
    feed: "https://www.newscientist.com/feed/",
    topicTerms: ["science", "physics", "quantum", "space", "ai", "health", "climate", "environment", "vegetarian"],
    publisherAliases: ["new scientist"],
    fallbackRank: 87,
  },
  {
    name: "Phys.org",
    description: "Physics, quantum computing, materials and energy",
    feed: "https://phys.org/rss-feed/",
    topicTerms: ["physics", "quantum", "quantum technology", "science", "solar", "battery", "space", "nanotechnology", "computer science"],
    publisherAliases: ["phys org", "phys.org"],
    fallbackRank: 88,
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

const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

function containsTerm(text: string, term: string) {
  const normalizedTerm = normalize(term);
  if (normalizedTerm.length === 0) return false;
  if (CJK_PATTERN.test(normalizedTerm)) {
    return text.includes(normalizedTerm);
  }
  return ` ${text} `.includes(` ${normalizedTerm} `);
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

    // Financial Times, The Reporter, and RTHK redirect between canonical hosts/paths.
    if (hostname === "ft.com" && pathname === "/rss/home/international") {
      pathname = "/rss/home";
    }
    if (hostname === "public.twreporter.org" && pathname === "/rss/twreporter-rss.xml") {
      return "twreporter.org/a/rss2.xml";
    }
    if (hostname === "rthk9.rthk.hk") {
      return `rthk.hk${pathname}${url.search}`;
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
