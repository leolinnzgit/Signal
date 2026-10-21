import { normalizeArticleReadingText, type ArticleNarrationSection } from "./headline-audio";

export default function ArticleReadingText({ text, paragraphIndex, section }: {
  text: string;
  paragraphIndex: number;
  section: ArticleNarrationSection | null;
}) {
  const normalized = normalizeArticleReadingText(text);
  if (!section || section.paragraphIndex !== paragraphIndex) return <>{normalized}</>;
  return <>{normalized.slice(0, section.start)}<mark className="article-reading-highlight" aria-current="true">
    {normalized.slice(section.start, section.end)}
  </mark>{normalized.slice(section.end)}</>;
}
