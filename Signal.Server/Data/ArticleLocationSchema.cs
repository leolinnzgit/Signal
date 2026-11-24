using Microsoft.EntityFrameworkCore;

namespace Signal.Server.Data;

public static class ArticleLocationSchema
{
    public static async Task UpgradeAsync(SignalDbContext database)
    {
        var wasClosed = database.Database.GetDbConnection().State == System.Data.ConnectionState.Closed;
        if (wasClosed) await database.Database.OpenConnectionAsync();
        try
        {
            var columns = new HashSet<string>(StringComparer.Ordinal);
            await using (var command = database.Database.GetDbConnection().CreateCommand())
            {
                command.CommandText = "PRAGMA table_info(\"StoredNewsArticles\");";
                await using var reader = await command.ExecuteReaderAsync();
                while (await reader.ReadAsync()) columns.Add(reader.GetString(1));
            }
            if (!columns.Contains("LocationName"))
                await database.Database.ExecuteSqlRawAsync("ALTER TABLE \"StoredNewsArticles\" ADD COLUMN \"LocationName\" TEXT NOT NULL DEFAULT '';");
            if (!columns.Contains("LocationLatitude"))
                await database.Database.ExecuteSqlRawAsync("ALTER TABLE \"StoredNewsArticles\" ADD COLUMN \"LocationLatitude\" REAL NULL;");
            if (!columns.Contains("LocationLongitude"))
                await database.Database.ExecuteSqlRawAsync("ALTER TABLE \"StoredNewsArticles\" ADD COLUMN \"LocationLongitude\" REAL NULL;");
            if (!columns.Contains("LocationExtractedAtUtc"))
                await database.Database.ExecuteSqlRawAsync("ALTER TABLE \"StoredNewsArticles\" ADD COLUMN \"LocationExtractedAtUtc\" TEXT NULL;");
            await database.Database.ExecuteSqlRawAsync(
                "CREATE INDEX IF NOT EXISTS \"IX_StoredNewsArticles_UserId_LocationExtractedAtUtc\" ON \"StoredNewsArticles\" (\"UserId\", \"LocationExtractedAtUtc\");");
        }
        finally
        {
            if (wasClosed) await database.Database.CloseConnectionAsync();
        }
    }
}
