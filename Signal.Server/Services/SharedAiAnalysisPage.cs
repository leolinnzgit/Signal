using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using Signal.Server.Models;

namespace Signal.Server.Services;

public static partial class SharedAiAnalysisPage
{
    private const int MaxAudioSections = 75;
    private const int MaxAudioTotalChars = 75_000;
    private const int MaxAudioSectionChars = 1900;

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    [GeneratedRegex(@"\[S(\d+)\]", RegexOptions.Compiled)]
    private static partial Regex CitationTagRegex();

    [GeneratedRegex(@"\s+", RegexOptions.Compiled)]
    private static partial Regex MultiSpaceRegex();

    [GeneratedRegex(@"\r?\n\s*\r?\n", RegexOptions.Compiled)]
    private static partial Regex ParagraphSplitRegex();

    public sealed record ReadableSections(
        string Title,
        IReadOnlyList<string> AnalysisParagraphs,
        IReadOnlyList<string> KeyDrivers,
        IReadOnlyList<string> Perspectives,
        IReadOnlyList<string> WatchNext,
        IReadOnlyList<string> AudioParagraphs,
        int AnalysisSectionCount,
        int DriverSectionCount,
        int PerspectiveSectionCount,
        int WatchNextSectionCount);

    public static bool IsValidShareId(string? id)
        => id is { Length: 48 } && id.All(char.IsAsciiHexDigitLower);

    public static ReadableSections BuildReadableSections(SharedAiAnalysis item)
    {
        var title = NormalizeAudioTitle(item.Headline, item.Topic);
        var paragraphs = SplitParagraphs(item.Analysis);
        var drivers = DeserializeStringList(item.KeyDriversJson);
        var perspectives = DeserializeStringList(item.PerspectivesJson);
        var watchNext = DeserializeStringList(item.WatchNextJson);

        var audioParagraphs = new List<string>();
        var totalChars = title.Length;

        int AddItems(IReadOnlyList<string> items, string? spokenPrefix = null)
        {
            var added = 0;
            foreach (var raw in items)
            {
                if (audioParagraphs.Count >= MaxAudioSections) break;
                var spoken = CleanForSpeech(raw);
                if (string.IsNullOrWhiteSpace(spoken)) break;
                var full = string.IsNullOrEmpty(spokenPrefix) ? spoken : $"{spokenPrefix}: {spoken}";
                if (full.Length > 3500) full = full[..3500];
                if (totalChars + full.Length > MaxAudioTotalChars) break;
                audioParagraphs.Add(full);
                totalChars += full.Length;
                added++;
            }
            return added;
        }

        var analysisCount = AddItems(paragraphs);
        var driverCount = AddItems(drivers, "Key driver");
        var perspectiveCount = AddItems(perspectives, "Perspective");
        var watchCount = AddItems(watchNext, "Watch next");

        if (audioParagraphs.Count == 0)
        {
            var fallback = CleanForSpeech(item.Topic);
            if (string.IsNullOrWhiteSpace(fallback)) fallback = "Shared AI analysis.";
            audioParagraphs.Add(fallback);
        }

        return new ReadableSections(
            Title: title,
            AnalysisParagraphs: paragraphs,
            KeyDrivers: drivers,
            Perspectives: perspectives,
            WatchNext: watchNext,
            AudioParagraphs: audioParagraphs,
            AnalysisSectionCount: analysisCount,
            DriverSectionCount: driverCount,
            PerspectiveSectionCount: perspectiveCount,
            WatchNextSectionCount: watchCount);
    }

    public static SharedNewsArticle ToSharedAudioArticle(SharedAiAnalysis item)
    {
        var sections = BuildReadableSections(item);
        return new SharedNewsArticle
        {
            Id = item.Id,
            Title = sections.Title,
            Source = string.IsNullOrWhiteSpace(item.Model) ? "Signal Bot" : $"Signal Bot · {item.Model}",
            Byline = string.IsNullOrWhiteSpace(item.Topic) ? "" : $"Topic: {item.Topic}",
            Language = string.IsNullOrWhiteSpace(item.Language) ? "en" : item.Language,
            ParagraphsJson = JsonSerializer.Serialize(sections.AudioParagraphs),
            OriginalUrl = $"https://signal.local/shared/analysis/{item.Id}",
            DiscussionUrl = "",
            CreatedAtUtc = item.CreatedAtUtc,
        };
    }

    public static string Render(SharedAiAnalysis item, string homePath)
    {
        var encode = HtmlEncoder.Default;
        var baseHref = string.IsNullOrWhiteSpace(homePath) ? "/" : homePath.TrimEnd('/') + "/";
        var sections = BuildReadableSections(item);
        var citations = DeserializeCitations(item.CitationsJson);
        var citationIndices = citations.Select(c => c.Index).ToHashSet();
        var market = DeserializeMarketQuote(item.MarketQuoteJson);

        var langAttr = encode.Encode(string.IsNullOrWhiteSpace(item.Language) ? "en" : item.Language);
        var pageTitle = encode.Encode(string.IsNullOrWhiteSpace(item.Headline)
            ? $"{item.Topic} — Signal AI Analysis"
            : item.Headline);
        var topicText = encode.Encode(string.IsNullOrWhiteSpace(item.Topic) ? "Topic Analysis" : item.Topic);
        var modelText = encode.Encode(string.IsNullOrWhiteSpace(item.Model) ? "Signal Bot" : item.Model);
        var sentiment = NormalizeSentiment(item.Sentiment);
        var sentimentLabel = CultureInfo.InvariantCulture.TextInfo.ToTitleCase(sentiment);
        var createdDisplay = item.CreatedAtUtc == default
            ? ""
            : item.CreatedAtUtc.ToString("dd MMM yyyy · HH:mm 'UTC'", CultureInfo.InvariantCulture);

        var sb = new StringBuilder(16384);
        sb.Append("""
<!doctype html>
<html lang="
""").Append(langAttr).Append("""
">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light dark">
<title>
""").Append(pageTitle).Append("""
 — Signal</title>
<style>
  :root{--bg:#f8fafc;--card:#ffffff;--ink:#0f172a;--muted:#475569;--line:#cbd5e1;--accent:#0369a1;--pill:#e2e8f0;--pill-ink:#0f172a;--highlight:rgba(250,204,21,.30);--highlight-border:#eab308;--quote-bg:#f1f5f9;}
  @media(prefers-color-scheme:dark){
    :root{--bg:#090d14;--card:#0f1622;--ink:#e2e8f0;--muted:#94a3b8;--line:#1e293b;--accent:#38bdf8;--pill:#1e293b;--pill-ink:#e2e8f0;--highlight:rgba(250,204,21,.22);--highlight-border:#facc15;--quote-bg:#131c2b;}
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:780px;margin:0 auto;padding:24px 16px 56px}
  .topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:18px;font-size:13px;color:var(--muted)}
  .brand{display:inline-flex;align-items:center;gap:8px;color:var(--ink);text-decoration:none;font-weight:700;letter-spacing:.01em}
  .brand-mark{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:7px;background:var(--accent);color:#fff;font-size:13px}
  .top-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .btn{appearance:none;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:999px;padding:6px 13px;font:600 13px/1.2 inherit;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
  .btn:hover{border-color:var(--accent)}
  .btn-primary{background:var(--accent);border-color:var(--accent);color:#fff}
  .btn[hidden]{display:none}
  .btn:disabled{opacity:.65;cursor:wait}
  .card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:28px 26px;box-shadow:0 8px 24px rgba(2,6,23,.06)}
  .meta-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px}
  .pill{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;background:var(--pill);color:var(--pill-ink);font-size:12px;font-weight:600}
  .sent-bullish{background:rgba(22,163,74,.16);color:#15803d}
  .sent-bearish{background:rgba(220,38,38,.16);color:#b91c1c}
  .sent-mixed{background:rgba(217,119,6,.16);color:#b45309}
  .sent-urgent{background:rgba(147,51,234,.16);color:#7e22ce}
  @media(prefers-color-scheme:dark){
    .sent-bullish{color:#4ade80}
    .sent-bearish{color:#f87171}
    .sent-mixed{color:#fbbf24}
    .sent-urgent{color:#c084fc}
  }
  h1{margin:0 0 12px;font:700 clamp(24px,3.6vw,34px)/1.22 Georgia,'Times New Roman',serif;letter-spacing:-.01em}
  .prompt-box{margin:0 0 16px;padding:10px 14px;border-left:3px solid var(--accent);background:var(--quote-bg);border-radius:0 10px 10px 0;font-size:14px;color:var(--muted)}
  .market-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 18px;padding:10px 14px;border:1px solid var(--line);border-radius:12px;background:var(--quote-bg);font-size:13.5px}
  .audio-bar{margin:0 0 22px;padding:14px 16px;border:1px solid var(--line);border-radius:14px;background:var(--quote-bg);display:grid;gap:10px}
  .audio-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .audio-controls select{border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:999px;padding:6px 12px;font:500 13px/1.2 inherit;max-width:100%}
  .audio-status{margin:0;font-size:12.5px;color:var(--muted)}
  #story-audio{width:100%;height:38px}
  .prose{font:18px/1.72 Georgia,'Times New Roman',serif}
  .prose p{margin:0 0 16px;padding:3px 6px;border-radius:6px}
  .cite{color:var(--accent);text-decoration:none;font:700 12px/1 system-ui,sans-serif;padding:0 2px}
  .cite:hover{text-decoration:underline}
  .section-block{margin-top:26px;padding-top:20px;border-top:1px solid var(--line)}
  .section-block h2{margin:0 0 12px;font:700 14px/1.3 system-ui,sans-serif;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  .bullet-list{margin:0;padding-left:20px;display:grid;gap:8px;font-size:15.5px}
  .bullet-list li{padding:3px 6px;border-radius:6px}
  .audio-current{background:var(--highlight);box-shadow:inset 3px 0 0 var(--highlight-border)}
  .sources{display:grid;gap:10px}
  .source-item{border:1px solid var(--line);border-radius:12px;padding:12px 14px;background:var(--quote-bg)}
  .source-item a{color:var(--accent);font-weight:600;text-decoration:none}
  .source-item a:hover{text-decoration:underline}
  .source-meta{font-size:12.5px;color:var(--muted);margin-top:3px}
  .source-summary{font-size:13.5px;color:var(--ink);margin:6px 0 0;opacity:.92}
  .coverage{margin-top:22px;font-size:12.5px;color:var(--muted)}
  @media(max-width:600px){.card{padding:20px 16px}.prose{font-size:16.5px}}
  @media print{.topbar,.audio-bar{display:none!important}.card{border:none;box-shadow:none;padding:0}}
</style>
</head>
<body>
<main class="wrap">
  <div class="topbar">
    <a class="brand" href="
""").Append(encode.Encode(baseHref)).Append("""
"><span class="brand-mark">S</span><span>Signal · Shared AI Analysis</span></a>
    <div class="top-actions">
      <button type="button" class="btn" id="copy-analysis-link">📋 Copy link</button>
      <button type="button" class="btn" id="share-analysis-btn">↗ Share</button>
    </div>
  </div>
  <article class="card" dir="auto">
    <div class="meta-row">
      <span class="pill">
""").Append(topicText).Append("""
</span>
      <span class="pill">Model: 
""").Append(modelText).Append("""
</span>
      <span class="pill sent-
""").Append(sentiment).Append("""
">
""").Append(encode.Encode(sentimentLabel)).Append("""
</span>
""");
        if (!string.IsNullOrWhiteSpace(createdDisplay))
        {
            sb.Append("      <span class=\"pill\">").Append(encode.Encode(createdDisplay)).Append("</span>\n");
        }
        sb.Append("""
    </div>
    <h1 data-audio-section="0">
""").Append(encode.Encode(sections.Title)).Append("""
</h1>
""");

        if (!string.IsNullOrWhiteSpace(item.UserPrompt))
        {
            sb.Append("    <div class=\"prompt-box\"><strong>Asked:</strong> ")
              .Append(encode.Encode(item.UserPrompt.Trim()))
              .Append("</div>\n");
        }

        if (market is not null && !string.IsNullOrWhiteSpace(market.Symbol))
        {
            var sign = market.Change >= 0 ? "+" : "";
            sb.Append("    <div class=\"market-bar\">")
              .Append("<strong>").Append(encode.Encode(market.Symbol)).Append("</strong>")
              .Append("<span>").Append(encode.Encode(market.Name)).Append("</span>")
              .Append("<span>").Append(encode.Encode(market.Currency)).Append(' ')
              .Append(market.Price.ToString("0.00", CultureInfo.InvariantCulture)).Append("</span>")
              .Append("<span>(").Append(sign).Append(market.Change.ToString("0.00", CultureInfo.InvariantCulture))
              .Append(" / ").Append(sign).Append(market.PercentChange.ToString("0.00", CultureInfo.InvariantCulture))
              .Append("%)</span>")
              .Append("</div>\n");
        }

        var audioEndpoint = $"{baseHref}shared/analysis/{item.Id}/audio";
        var scriptSrc = $"{baseHref}shared-analysis-audio.js?v=1";
        sb.Append("""
    <section class="audio-bar" aria-label="Read aloud controls">
      <div class="audio-controls">
        <button type="button" class="btn btn-primary" id="listen-button">Play Azure audio</button>
        <button type="button" class="btn" id="browser-read-button" aria-pressed="false">Read in browser</button>
        <select id="story-voice" aria-label="Narration voice" disabled>
          <option value="">Loading voices…</option>
        </select>
      </div>
      <audio id="story-audio" controls preload="none" hidden data-src="
""").Append(encode.Encode(audioEndpoint)).Append("""
"></audio>
      <p id="audio-status" class="audio-status">Choose Play Azure audio or Read in browser to listen to this analysis.</p>
    </section>
    <div class="prose">
""");

        var nextSection = 1;
        if (sections.AnalysisParagraphs.Count == 0
            && sections.KeyDrivers.Count == 0
            && sections.Perspectives.Count == 0
            && sections.WatchNext.Count == 0
            && sections.AudioParagraphs.Count > 0)
        {
            sb.Append("      <p data-audio-section=\"1\">")
              .Append(encode.Encode(sections.AudioParagraphs[0]))
              .Append("</p>\n");
            nextSection = 2;
        }
        for (var i = 0; i < sections.AnalysisParagraphs.Count; i++)
        {
            var p = sections.AnalysisParagraphs[i];
            if (i < sections.AnalysisSectionCount)
            {
                sb.Append("      <p data-audio-section=\"").Append(nextSection++).Append("\">");
            }
            else
            {
                sb.Append("      <p>");
            }
            AppendWithCitations(sb, p, citationIndices, encode);
            sb.Append("</p>\n");
        }
        sb.Append("    </div>\n");

        void AppendBulletSection(string heading, IReadOnlyList<string> items, int highlightedCount)
        {
            if (items.Count == 0) return;
            sb.Append("    <section class=\"section-block\">\n      <h2>")
              .Append(encode.Encode(heading))
              .Append("</h2>\n      <ul class=\"bullet-list\">\n");
            for (var i = 0; i < items.Count; i++)
            {
                if (i < highlightedCount)
                {
                    sb.Append("        <li data-audio-section=\"").Append(nextSection++).Append("\">");
                }
                else
                {
                    sb.Append("        <li>");
                }
                AppendWithCitations(sb, items[i], citationIndices, encode);
                sb.Append("</li>\n");
            }
            sb.Append("      </ul>\n    </section>\n");
        }

        AppendBulletSection("Key Drivers", sections.KeyDrivers, sections.DriverSectionCount);
        AppendBulletSection("Perspectives & Risks", sections.Perspectives, sections.PerspectiveSectionCount);
        AppendBulletSection("What to Watch Next", sections.WatchNext, sections.WatchNextSectionCount);

        if (citations.Count > 0)
        {
            sb.Append("    <section class=\"section-block\" id=\"sources\">\n      <h2>Grounded Sources</h2>\n      <div class=\"sources\">\n");
            foreach (var cite in citations)
            {
                var safeHref = ToSafeHttpUrl(cite.Url);
                sb.Append("        <div class=\"source-item\" id=\"source-S").Append(cite.Index).Append("\">\n          <div>");
                sb.Append("<strong>[S").Append(cite.Index).Append("]</strong> ");
                if (safeHref is not null)
                {
                    sb.Append("<a href=\"").Append(encode.Encode(safeHref))
                      .Append("\" target=\"_blank\" rel=\"noopener noreferrer\">")
                      .Append(encode.Encode(string.IsNullOrWhiteSpace(cite.Title) ? safeHref : cite.Title))
                      .Append(" ↗</a>");
                }
                else
                {
                    sb.Append("<span>")
                      .Append(encode.Encode(string.IsNullOrWhiteSpace(cite.Title) ? cite.Source : cite.Title))
                      .Append("</span>");
                }
                sb.Append("</div>\n");
                if (!string.IsNullOrWhiteSpace(cite.Source) || !string.IsNullOrWhiteSpace(cite.PublishedAt))
                {
                    sb.Append("          <div class=\"source-meta\">")
                      .Append(encode.Encode(cite.Source));
                    if (!string.IsNullOrWhiteSpace(cite.Source) && !string.IsNullOrWhiteSpace(cite.PublishedAt))
                    {
                        sb.Append(" · ");
                    }
                    sb.Append(encode.Encode(cite.PublishedAt))
                      .Append("</div>\n");
                }
                if (!string.IsNullOrWhiteSpace(cite.Summary))
                {
                    sb.Append("          <p class=\"source-summary\">")
                      .Append(encode.Encode(cite.Summary))
                      .Append("</p>\n");
                }
                sb.Append("        </div>\n");
            }
            sb.Append("      </div>\n    </section>\n");
        }

        if (!string.IsNullOrWhiteSpace(item.CoverageNote))
        {
            sb.Append("    <p class=\"coverage\">").Append(encode.Encode(item.CoverageNote)).Append("</p>\n");
        }

        sb.Append("""
  </article>
</main>
<script src="
""").Append(encode.Encode(scriptSrc)).Append("""
" defer></script>
</body>
</html>
""");
        return sb.ToString();
    }

    public static string RenderMissing(string homePath)
    {
        var encode = HtmlEncoder.Default;
        var baseHref = string.IsNullOrWhiteSpace(homePath) ? "/" : homePath.TrimEnd('/') + "/";
        return $$"""
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light dark">
<title>Shared Analysis Not Found — Signal</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;font:16px/1.6 system-ui,-apple-system,sans-serif;background:#090d14;color:#e2e8f0}
  main{max-width:460px;background:#0f1622;border:1px solid #1e293b;border-radius:16px;padding:28px;text-align:center}
  a{display:inline-block;margin-top:14px;color:#38bdf8;font-weight:600;text-decoration:none}
</style>
</head>
<body>
  <main>
    <h1>Shared analysis not found</h1>
    <p>This shared Signal AI analysis link is invalid or no longer available.</p>
    <a href="{{encode.Encode(baseHref)}}">Return to Signal</a>
  </main>
</body>
</html>
""";
    }

    private static string NormalizeAudioTitle(string? headline, string? topic)
    {
        var clean = CleanForSpeech(headline);
        if (string.IsNullOrWhiteSpace(clean)) clean = CleanForSpeech(topic);
        if (string.IsNullOrWhiteSpace(clean)) clean = "Shared Signal AI Analysis";
        return clean.Length <= MaxAudioSectionChars ? clean : clean[..MaxAudioSectionChars];
    }

    private static string CleanForSpeech(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return "";
        var withoutTags = CitationTagRegex().Replace(text, " ");
        return MultiSpaceRegex().Replace(withoutTags, " ").Trim();
    }

    private static IReadOnlyList<string> SplitParagraphs(string? analysis)
    {
        if (string.IsNullOrWhiteSpace(analysis)) return [];
        var rawBlocks = ParagraphSplitRegex().Split(analysis.Trim())
            .Select(b => b.Trim())
            .Where(b => b.Length > 0)
            .ToArray();
        if (rawBlocks.Length > 1) return rawBlocks;

        return analysis.Replace("\r\n", "\n").Split('\n')
            .Select(line => line.Trim())
            .Where(line => line.Length > 0)
            .ToArray();
    }

    private static IReadOnlyList<string> DeserializeStringList(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            var items = JsonSerializer.Deserialize<string[]>(json, JsonOptions);
            return items?.Select(x => x?.Trim() ?? "").Where(x => x.Length > 0).ToArray() ?? [];
        }
        catch
        {
            return [];
        }
    }

    private static IReadOnlyList<SignalBotCitation> DeserializeCitations(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            return JsonSerializer.Deserialize<SignalBotCitation[]>(json, JsonOptions) ?? [];
        }
        catch
        {
            return [];
        }
    }

    private static SignalBotMarketSnapshot? DeserializeMarketQuote(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            return JsonSerializer.Deserialize<SignalBotMarketSnapshot>(json, JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    private static string NormalizeSentiment(string? sentiment)
        => (sentiment ?? "").Trim().ToLowerInvariant() switch
        {
            "bullish" => "bullish",
            "bearish" => "bearish",
            "mixed" => "mixed",
            "urgent" => "urgent",
            _ => "neutral",
        };

    private static string? ToSafeHttpUrl(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        if (!Uri.TryCreate(raw.Trim(), UriKind.Absolute, out var uri)) return null;
        if (!string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        return uri.AbsoluteUri;
    }

    private static void AppendWithCitations(
        StringBuilder sb,
        string text,
        HashSet<int> validIndices,
        HtmlEncoder encode)
    {
        var matches = CitationTagRegex().Matches(text);
        var pos = 0;
        foreach (Match match in matches)
        {
            if (match.Index > pos)
            {
                sb.Append(encode.Encode(text[pos..match.Index]));
            }
            if (int.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var idx)
                && validIndices.Contains(idx))
            {
                sb.Append("<sup><a class=\"cite\" href=\"#source-S")
                  .Append(idx)
                  .Append("\">[S")
                  .Append(idx)
                  .Append("]</a></sup>");
            }
            else
            {
                sb.Append(encode.Encode(match.Value));
            }
            pos = match.Index + match.Length;
        }
        if (pos < text.Length)
        {
            sb.Append(encode.Encode(text[pos..]));
        }
    }
}
