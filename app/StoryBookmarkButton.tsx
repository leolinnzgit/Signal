import type { FollowedArticle } from "./NewsDashboard";

export default function StoryBookmarkButton({ article, busy, onToggle }: {
  article: Pick<FollowedArticle, "title" | "isBookmarked">;
  busy: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="bookmark-button"
      onClick={onToggle}
      disabled={busy}
      aria-pressed={article.isBookmarked === true}
      aria-label={`Bookmark ${article.title}`}
      title={article.isBookmarked ? "Remove bookmark" : "Bookmark story"}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M6 4h12v16l-6-4-6 4V4Z" /></svg>
      Bookmark
    </button>
  );
}
