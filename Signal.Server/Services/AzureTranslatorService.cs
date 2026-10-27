using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using Signal.Server.Models;

namespace Signal.Server.Services;

public sealed class AzureTranslatorOptions
{
    public const string SectionName = "AzureTranslator";
    public string Endpoint { get; set; } = "https://api.cognitive.microsofttranslator.com/";
    public string Key { get; set; } = "";
    public string Region { get; set; } = "";
    public bool Enabled => !string.IsNullOrWhiteSpace(Key);

    internal Uri Validate()
    {
        if (!Uri.TryCreate(Endpoint, UriKind.Absolute, out var uri) || uri.Scheme != "https"
            || !uri.IsDefaultPort || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0
            || uri.AbsolutePath != "/" || !(uri.Host is "api.cognitive.microsofttranslator.com"
                or "api-nam.cognitive.microsofttranslator.com" or "api-eur.cognitive.microsofttranslator.com"
                or "api-apc.cognitive.microsofttranslator.com"
                || uri.Host.EndsWith(".cognitiveservices.azure.com", StringComparison.OrdinalIgnoreCase))
            || Key.Length is < 20 or > 256 || Key.Any(char.IsWhiteSpace) || Key.Any(char.IsControl)
            || Region.Length > 64 || Region.Any(character => !char.IsAsciiLetterOrDigit(character) && character != '-'))
            throw new ArticleTranslationException("Azure translation needs a valid Translator endpoint, key and region.");
        return uri;
    }
}

public sealed class ArticleTranslationException(string message) : Exception(message);
public sealed record ArticleTranslationResult(bool Available, string Reason, string Title, string[] Paragraphs, string Language);

public sealed class AzureTranslatorService(
    IOptions<AzureTranslatorOptions> options, IHttpClientFactory clients, IMemoryCache cache)
{
    public const string HttpClientName = "AzureTranslator";
    internal static readonly string[] Languages = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "fr", "de", "es", "it", "pt", "ar", "hi"];
    private static readonly Regex NzPublisher = new(
        @"\b(?:RNZ|Radio New Zealand|Te Reo Irirangi o Aotearoa|Stuff|NZ Herald|New Zealand Herald|1News|One News|Newshub|Newsroom|The Spinoff|Otago Daily Times|BusinessDesk|Newstalk ZB|Waikato Times|NZ On Air)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Regex AuPublisher = new(
        @"\b(?:ABC News Australia|Sydney Morning Herald|The Age|Nine News|SBS News)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Regex CaPublisher = new(
        @"\b(?:CBC News|CTV News|Global News|The Globe and Mail)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Regex NzContext = new(
        @"\b(?:New Zealand|Aotearoa|NZD|Auckland|Wellington|Christchurch|Hamilton|Waikato|Tauranga|Dunedin|Queenstown|Rotorua|Napier|Hastings|Palmerston North|New Plymouth|Whangārei|Whangarei|Invercargill|Whanganui|Gisborne|Ngāruawāhia|Ngaruawahia|Te Kauwhata|Pōkeno|Pokeno|Tūākau|Tuakau|Te Huia|KiwiRail|Waka Kotahi|NZTA|Kāinga Ora|Kainga Ora|Reserve Bank of New Zealand|RBNZ|Fonterra|Pharmac|Beehive)\b|紐西蘭|新西兰|奧克蘭|奥克兰|威靈頓|惠灵顿|基督城|漢密爾頓|汉密尔顿|懷卡托|怀卡托",
        RegexOptions.IgnoreCase | RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Regex UsCurrencyOrCountry = new(
        @"(?:\b(?:US\$|U\.S\.\$|USD|U\.S\.|United States|American|Washington|Congress|White House|Wall Street|Federal Reserve|Pentagon)\b|美國|美国|美方|美聯儲|美联储|華盛頓|华盛顿|華爾街|华尔街|白宮|白宫)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Regex SingaporeContext = new(
        @"(?:\b(?:Singapore(?:an)?|S\$|SGD)\b|新加坡|獅城|狮城)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Regex BareDollarAmount = new(
        @"(?<![A-Za-z.])\$(?<amount>\d[\d,]*(?:\.\d+)?)(?<scale>(?i:bn|[mbk])\b)?(?![\s\u00A0]*(?:(?:USD|NZD|AUD|CAD|SGD|HKD|TWD|EUR|GBP|JPY|CNY|RMB|CHF|INR|FJ|FJD)\b|U\.?S\.?(?:\s+(?i:dollars?))?\b|(?i:(?:US|American|Australian|Canadian|Singapore(?:an)?|Hong\s+Kong|New\s+Zealand)\s+dollars?)\b))",
        RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Regex LeadingScaleWord = new(
        @"^\s*(?:million|billion|trillion|thousand)\b",
        RegexOptions.IgnoreCase | RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Regex NzMalformedCurrency = new(
        @"紐西蘭美元|新西蘭美元|紐西蘭美金|新西蘭美金|新西兰美元|纽西兰美元|新西兰美金|纽西兰美金",
        RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Regex NzSgMistranslatedCurrency = new(
        @"(?<=[\d零一二三四五六七八九十百千萬万億亿兆兩两半]\s*)(?:新幣|新币|新元)",
        RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Regex UsdChineseTerms = new(
        @"美元|美金|美圓|美圆",
        RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private static readonly Regex NzdChineseTerms = new(
        @"紐西蘭元|新西蘭元|新西兰元|紐元|纽元|紐幣|纽币",
        RegexOptions.Compiled, TimeSpan.FromSeconds(1));
    private readonly SemaphoreSlim gate = new(1, 1);
    public bool Enabled => options.Value.Enabled;

    public async Task<ArticleTranslationResult> TranslateAsync(
        string title, IReadOnlyList<string> paragraphs, string language, CancellationToken token,
        string articleUrl = "", string siteName = "", string byline = "")
    {
        if (!Languages.Contains(language, StringComparer.Ordinal)) throw new ArgumentException("Choose a supported translation language.");
        if (!Enabled) return new(false, "Azure Translator has not been configured yet.", "", [], language);
        var endpoint = options.Value.Validate();
        if (string.IsNullOrWhiteSpace(title) || title.Length > 1_000 || paragraphs.Count is < 1 or > 80
            || paragraphs.Any(string.IsNullOrWhiteSpace) || paragraphs.Sum(text => (long)text.Length) > 30_000)
            throw new ArgumentException("This article exceeds the supported translation size.");
        var sources = new[] { title }.Concat(paragraphs).ToArray();
        var currencyPrefix = language == "en" ? "" : DetectCurrencyPrefix(articleUrl, siteName, byline, sources);
        var texts = currencyPrefix.Length == 0
            ? sources
            : sources.Select(text => PrepareSourceText(text, currencyPrefix)).ToArray();
        var cacheKey = "azure-translation:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            endpoint + "\n" + language + "\n" + currencyPrefix + "\n" + JsonSerializer.Serialize(texts))));
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(45));
        var acquired = false;
        try
        {
            await gate.WaitAsync(deadline.Token);
            acquired = true;
            if (cache.TryGetValue(cacheKey, out ArticleTranslationResult? ready) && ready is not null) return ready;
            var path = endpoint.Host.EndsWith(".cognitiveservices.azure.com", StringComparison.OrdinalIgnoreCase)
                ? "translator/text/v3.0/translate" : "translate";
            using var request = new HttpRequestMessage(HttpMethod.Post,
                new Uri(endpoint, path + "?api-version=3.0&textType=plain&to=" + Uri.EscapeDataString(language)));
            request.Headers.Add("Ocp-Apim-Subscription-Key", options.Value.Key);
            if (!string.IsNullOrEmpty(options.Value.Region)) request.Headers.Add("Ocp-Apim-Subscription-Region", options.Value.Region);
            request.Content = JsonContent.Create(texts.Select(text => new { text }).ToArray());
            using var response = await clients.CreateClient(HttpClientName).SendAsync(request, HttpCompletionOption.ResponseHeadersRead, deadline.Token);
            if (!response.IsSuccessStatusCode) throw new ArticleTranslationException(response.StatusCode switch
            {
                HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => "Azure Translator could not authorize this request. Check the key, region and subscription quota.",
                HttpStatusCode.TooManyRequests => "Azure's translation request limit was reached. Please try again later.",
                _ => "Azure translation is temporarily unavailable. Please try again.",
            });
            await response.Content.LoadIntoBufferAsync(1_000_000, deadline.Token);
            using var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync(deadline.Token));
            if (body.RootElement.ValueKind != JsonValueKind.Array || body.RootElement.GetArrayLength() != texts.Length)
                throw new ArticleTranslationException("Azure returned an incomplete translation. Please try again.");
            var translated = body.RootElement.EnumerateArray().Select(item => item.GetProperty("translations").EnumerateArray()
                .Single(translation => translation.GetProperty("to").GetString() == language).GetProperty("text").GetString() ?? "")
                .Select((text, index) => NormalizeTranslatedCurrency(text, sources[index], language, currencyPrefix)).ToArray();
            if (translated.Any(string.IsNullOrWhiteSpace) || translated.Sum(text => (long)text.Length) > 150_000)
                throw new ArticleTranslationException("Azure returned an incomplete translation. Please try again.");
            var result = new ArticleTranslationResult(true, "", translated[0], translated[1..], language);
            cache.Set(cacheKey, result, TimeSpan.FromHours(24));
            return result;
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            throw new ArticleTranslationException("The translation took too long. Please try again.");
        }
        finally { if (acquired) gate.Release(); }
    }

    internal static (string Title, string[] Paragraphs) NormalizeSharedArticle(SharedNewsArticle article)
    {
        var paragraphs = JsonSerializer.Deserialize<string[]>(article.ParagraphsJson) ?? [];
        if (article.Language is not ("zh-Hant" or "zh-Hans")) return (article.Title, paragraphs);
        var url = article.OriginalUrl.Length > 0 ? article.OriginalUrl : article.DiscussionUrl;
        var currencyPrefix = DetectCurrencyPrefix(url, article.Source, article.Byline, [article.Title, .. paragraphs]);
        return currencyPrefix.Length == 0
            ? (article.Title, paragraphs)
            : (NormalizeTranslatedCurrency(article.Title, "", article.Language, currencyPrefix),
                paragraphs.Select(text => NormalizeTranslatedCurrency(text, "", article.Language, currencyPrefix)).ToArray());
    }

    internal static string DetectCurrencyPrefix(string url, string siteName, string byline, IReadOnlyList<string> texts)
    {
        var prefix = "";
        var path = "";
        if (Uri.TryCreate(url, UriKind.Absolute, out var uri))
        {
            var host = uri.DnsSafeHost.ToLowerInvariant();
            path = uri.AbsolutePath.ToLowerInvariant();
            if (host.EndsWith(".nz", StringComparison.Ordinal)) prefix = "NZ$";
            else if (host.EndsWith(".au", StringComparison.Ordinal)
                || (host.EndsWith("theguardian.com", StringComparison.Ordinal) && path.StartsWith("/au/", StringComparison.Ordinal))) prefix = "A$";
            else if (host.EndsWith(".ca", StringComparison.Ordinal)
                || host is "theglobeandmail.com" or "www.theglobeandmail.com" or "nationalpost.com" or "www.nationalpost.com" or "torontostar.com" or "www.torontostar.com") prefix = "CA$";
            else if (host.EndsWith(".sg", StringComparison.Ordinal)
                || host is "channelnewsasia.com" or "www.channelnewsasia.com" or "straitstimes.com" or "www.straitstimes.com" or "todayonline.com" or "www.todayonline.com") prefix = "S$";
            else if (host.EndsWith(".hk", StringComparison.Ordinal)
                || host is "scmp.com" or "www.scmp.com" or "hongkongfp.com" or "www.hongkongfp.com") prefix = "HK$";
        }
        if (prefix.Length == 0)
        {
            var publisher = $"{siteName} {byline}";
            if (NzPublisher.IsMatch(publisher)) prefix = "NZ$";
            else if (AuPublisher.IsMatch(publisher)) prefix = "A$";
            else if (CaPublisher.IsMatch(publisher)) prefix = "CA$";
        }
        var hasNzContext = texts.Any(NzContext.IsMatch);
        var hasUsContext = texts.Any(UsCurrencyOrCountry.IsMatch);
        if (prefix == "NZ$" && (path.Contains("/world/", StringComparison.Ordinal) || path.Contains("/international/", StringComparison.Ordinal))
            && !hasNzContext && hasUsContext)
            return "";
        return prefix.Length > 0 ? prefix : hasNzContext && !hasUsContext ? "NZ$" : "";
    }

    internal static string PrepareSourceText(string text, string currencyPrefix) =>
        string.IsNullOrEmpty(currencyPrefix) ? text : BareDollarAmount.Replace(text, match =>
        {
            var remainder = text.AsSpan(match.Index + match.Length);
            var scaleWord = LeadingScaleWord.Match(remainder.ToString());
            var afterAmount = (scaleWord.Success ? remainder[scaleWord.Length..] : remainder).TrimStart();
            if (afterAmount.StartsWith("(", StringComparison.Ordinal))
            {
                var close = afterAmount.IndexOf(')');
                var code = currencyPrefix == "NZ$" ? "NZD" : currencyPrefix;
                if (close > 0 && (afterAmount[..close].Contains(currencyPrefix, StringComparison.OrdinalIgnoreCase)
                    || afterAmount[..close].Contains(code, StringComparison.OrdinalIgnoreCase)))
                    return match.Value;
            }
            var scale = match.Groups["scale"].Value.ToLowerInvariant() switch
            {
                "m" => " million",
                "b" or "bn" => " billion",
                "k" => " thousand",
                _ => "",
            };
            return currencyPrefix + match.Groups["amount"].Value + scale;
        });

    internal static string NormalizeTranslatedCurrency(string translated, string sourceText, string language, string currencyPrefix)
    {
        if (string.IsNullOrEmpty(currencyPrefix) || language is not ("zh-Hant" or "zh-Hans")) return translated;
        if (currencyPrefix == "NZ$")
        {
            var unit = language == "zh-Hant" ? "紐西蘭元" : "新西兰元";
            var cleaned = NzMalformedCurrency.Replace(translated, unit);
            if (language == "zh-Hant") cleaned = cleaned.Replace("新西蘭元", unit, StringComparison.Ordinal).Replace("新西蘭幣", "紐幣", StringComparison.Ordinal);
            if (!SingaporeContext.IsMatch(sourceText) && !SingaporeContext.IsMatch(cleaned))
                cleaned = NzSgMistranslatedCurrency.Replace(cleaned, unit);
            if (!UsCurrencyOrCountry.IsMatch(sourceText) && !UsCurrencyOrCountry.IsMatch(cleaned)
                && !(UsdChineseTerms.IsMatch(cleaned) && NzdChineseTerms.IsMatch(cleaned)))
                cleaned = UsdChineseTerms.Replace(cleaned, unit);
            return cleaned;
        }
        var regionalUnit = currencyPrefix switch { "A$" => "澳元", "CA$" => "加元", "S$" => "新元", "HK$" => "港元", _ => "" };
        return regionalUnit.Length > 0 && !UsCurrencyOrCountry.IsMatch(sourceText) && !UsCurrencyOrCountry.IsMatch(translated)
            ? UsdChineseTerms.Replace(translated, regionalUnit)
            : translated;
    }
}
