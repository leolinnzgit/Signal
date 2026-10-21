using System.Security.Cryptography;
using System.Text;

namespace Signal.Server.Services;

public interface IArticleAudioPrewarmer
{
    void Enqueue(string url, string title, string summary);
}

internal sealed class ArticleAudioPreparationJob(string url, string title, string summary)
{
    internal string Url { get; } = url;
    internal string Title { get; } = title;
    internal string Summary { get; } = summary;
    internal string Key { get; } = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(url + "\n" + title + "\n" + summary)));
    internal string[] Parts { get; set; } = [title];
    internal int Index { get; set; }
    internal bool Article { get; set; }
    internal bool Extracted { get; set; }
    internal int Failures { get; set; }
}

internal sealed class ArticleAudioPreparationQueue(int capacity = 128)
{
    private readonly object sync = new();
    private readonly Queue<ArticleAudioPreparationJob> headlines = new();
    private readonly LinkedList<ArticleAudioPreparationJob> articles = new();
    private readonly HashSet<string> pending = [];
    private readonly Dictionary<string, DateTime> completed = [];
    internal int Count { get { lock (sync) return headlines.Count + articles.Count; } }

    internal bool Enqueue(ArticleAudioPreparationJob job)
    {
        lock (sync)
        {
            if (pending.Contains(job.Key) || completed.GetValueOrDefault(job.Key) > DateTime.UtcNow.AddMinutes(-30)) return false;
            while (headlines.Count + articles.Count >= capacity)
            {
                var removed = articles.Count > 0 ? RemoveArticle(last: true) : headlines.Dequeue();
                pending.Remove(removed.Key);
            }
            pending.Add(job.Key);
            headlines.Enqueue(job);
            return true;
        }
    }
    internal ArticleAudioPreparationJob? Take()
    {
        lock (sync) return headlines.Count > 0 ? headlines.Dequeue() : articles.Count > 0 ? RemoveArticle(last: false) : null;
    }
    internal void Resume(ArticleAudioPreparationJob job)
    {
        lock (sync)
        {
            // Newly arriving headlines always go ahead of article paragraphs.
            while (headlines.Count + articles.Count >= capacity)
            {
                var removed = articles.Count > 0 ? RemoveArticle(last: true) : headlines.Dequeue();
                pending.Remove(removed.Key);
            }
            if (!job.Article) headlines.Enqueue(job);
            else if (job.Extracted) articles.AddFirst(job);
            else articles.AddLast(job);
        }
    }
    private ArticleAudioPreparationJob RemoveArticle(bool last)
    {
        var node = last ? articles.Last! : articles.First!;
        articles.Remove(node);
        return node.Value;
    }
    internal void Complete(ArticleAudioPreparationJob job)
    {
        lock (sync)
        {
            pending.Remove(job.Key);
            completed[job.Key] = DateTime.UtcNow;
            foreach (var key in completed.Where(pair => pair.Value < DateTime.UtcNow.AddMinutes(-30)).Select(pair => pair.Key).ToArray()) completed.Remove(key);
            while (completed.Count > capacity * 4) completed.Remove(completed.MinBy(pair => pair.Value).Key);
        }
    }
}
