using System.Globalization;
using System.Net;
using System.Text.Json;

namespace Signal.Server.Services;

public sealed record CortexPublicNewsHit(
    string Id, string Title, string Publisher, string Url, DateTimeOffset PublishedAt, string Excerpt);

internal sealed record CortexIndexedArticle(
    string Id, string Title, string Publisher, string Url, DateTimeOffset PublishedAt, string Excerpt,
    string Fingerprint);

internal sealed record CortexIndexEntry(string Id, DateTimeOffset PublishedAt, string Fingerprint);

internal sealed class AzureCortexNewsIndex(
    HttpClient http, CortexNewsOptions settings)
{
    private const string ApiVersion = "2025-09-01";
    private const string VectorField = "embedding";
    private const int PageSize = 500;

    public async Task EnsureIndexAsync(CancellationToken token)
    {
        using var lookup = await SendAsync(HttpMethod.Get, $"indexes/{settings.IndexName}", settings.AdminKey, null, token);
        if (lookup.StatusCode != HttpStatusCode.NotFound)
        {
            lookup.EnsureSuccessStatusCode();
            return;
        }

        using var create = await SendAsync(HttpMethod.Post, "indexes", settings.AdminKey, new
        {
            name = settings.IndexName,
            fields = new object[]
            {
                ScalarField("id", key: true, filterable: true, sortable: true),
                ScalarField("title", searchable: true),
                ScalarField("publisher"),
                ScalarField("url"),
                ScalarField("publishedAt", "Edm.DateTimeOffset", filterable: true),
                ScalarField("excerpt", searchable: true),
                ScalarField("fingerprint"),
                new
                {
                    name = VectorField, type = "Collection(Edm.Single)", searchable = true,
                    retrievable = false, stored = false, dimensions = CortexNewsEmbeddings.Dimensions,
                    vectorSearchProfile = "news",
                },
            },
            vectorSearch = new
            {
                algorithms = new[] { new { name = "exact", kind = "exhaustiveKnn", exhaustiveKnnParameters = new { metric = "cosine" } } },
                profiles = new[] { new { name = "news", algorithm = "exact" } },
            },
        }, token);
        if (create.StatusCode != HttpStatusCode.Conflict)
            create.EnsureSuccessStatusCode();
    }

    public Task<CortexPublicNewsHit[]> SearchAsync(string query, float[] vector, DateTimeOffset cutoff, CancellationToken token) =>
        SearchAsync<CortexPublicNewsHit>(settings.QueryKey, new
        {
            search = EscapeSearchText(query),
            searchFields = "title,excerpt",
            select = "id,title,publisher,url,publishedAt,excerpt",
            filter = $"publishedAt ge {cutoff.UtcDateTime.ToString("O", CultureInfo.InvariantCulture)}",
            vectorQueries = new[] { new { kind = "vector", vector, fields = VectorField, k = 5 } },
            top = 5,
        }, token);

    public async Task<List<CortexIndexEntry>> ListAsync(CancellationToken token)
    {
        var entries = new List<CortexIndexEntry>();

        while (true)
        {
            var page = await SearchAsync<CortexIndexEntry>(settings.AdminKey, new
            {
                search = "*",
                select = "id,publishedAt,fingerprint",
                orderby = "id asc",
                skip = entries.Count,
                top = PageSize,
            }, token);
            entries.AddRange(page);
            if (page.Length < PageSize)
                return entries;
        }
    }

    public Task UpsertAsync(IEnumerable<(CortexIndexedArticle Article, float[] Vector)> articles, CancellationToken token) =>
        WriteAsync(articles.Select(item => new Dictionary<string, object>
        {
            ["@search.action"] = "upload",
            ["id"] = item.Article.Id,
            ["title"] = item.Article.Title,
            ["publisher"] = item.Article.Publisher,
            ["url"] = item.Article.Url,
            ["publishedAt"] = item.Article.PublishedAt,
            ["excerpt"] = item.Article.Excerpt,
            ["fingerprint"] = item.Article.Fingerprint,
            [VectorField] = item.Vector,
        }), token);

    public Task DeleteAsync(IEnumerable<string> ids, CancellationToken token) =>
        WriteAsync(ids.Select(id => new Dictionary<string, object> { ["@search.action"] = "delete", ["id"] = id }), token);

    private async Task WriteAsync(IEnumerable<Dictionary<string, object>> actions, CancellationToken token)
    {
        foreach (var batch in actions.Chunk(50))
        {
            using var response = await SendAsync(HttpMethod.Post, $"indexes/{settings.IndexName}/docs/index",
                settings.AdminKey, new { value = batch }, token);
            response.EnsureSuccessStatusCode();
            var results = await response.Content.ReadFromJsonAsync<SearchPage<IndexWriteResult>>(token);
            if (results?.Value is not { } values || values.Length != batch.Length || values.Any(result => !result.Status))
                throw new InvalidOperationException("Azure Search did not index every Cortex news document in the batch.");
        }
    }

    private async Task<T[]> SearchAsync<T>(string key, object body, CancellationToken token)
    {
        using var response = await SendAsync(HttpMethod.Post, $"indexes/{settings.IndexName}/docs/search", key, body, token);
        response.EnsureSuccessStatusCode();
        var page = await response.Content.ReadFromJsonAsync<SearchPage<T>>(token);
        return page?.Value ?? throw new JsonException("Azure Search returned an invalid result page.");
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string route, string key, object? body, CancellationToken token)
    {
        using var request = new HttpRequestMessage(method, new Uri(settings.EndpointUri!, $"{route}?api-version={ApiVersion}"));
        request.Headers.Add("api-key", key);
        if (body is not null) request.Content = JsonContent.Create(body);
        return await http.SendAsync(request, token);
    }

    private static object ScalarField(string name, string type = "Edm.String", bool key = false,
        bool searchable = false, bool filterable = false, bool sortable = false) =>
        new { name, type, key, searchable, filterable, sortable, facetable = false, retrievable = true };

    private static string EscapeSearchText(string query) =>
        string.Concat(query.Select(character => "+|\"()'\\-*".Contains(character) ? $"\\{character}" : character.ToString()));

    private sealed record SearchPage<T>(T[] Value);
    private sealed record IndexWriteResult(bool Status);
}
