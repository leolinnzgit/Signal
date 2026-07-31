export type ArticleShareData = {
  title: string;
  text: string;
  url: string;
};

type ArticleShareTarget = {
  share?: (data: ArticleShareData) => Promise<void>;
  clipboard?: {
    writeText: (value: string) => Promise<void>;
  };
};

export type ArticleShareResult = "shared" | "copied" | "cancelled" | "failed";

export async function shareArticle(
  data: ArticleShareData,
  target: ArticleShareTarget = navigator,
): Promise<ArticleShareResult> {
  if (typeof target.share === "function") {
    try {
      await target.share(data);
      return "shared";
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        return "cancelled";
      }
    }
  }

  if (typeof target.clipboard?.writeText === "function") {
    try {
      await target.clipboard.writeText(data.url);
      return "copied";
    } catch {
      // The caller can show a useful error when clipboard access is unavailable.
    }
  }

  return "failed";
}
