using System.Data;
using Microsoft.EntityFrameworkCore;

namespace Signal.Server.Data;

internal static class SharedArticleLinkSchema
{
    internal static async Task UpgradeAsync(SignalDbContext database)
    {
        var connection = database.Database.GetDbConnection();
        var wasClosed = connection.State == ConnectionState.Closed;
        if (wasClosed) await database.Database.OpenConnectionAsync();
        try
        {
            await using var check = connection.CreateCommand();
            check.CommandText = "SELECT COUNT(*) FROM pragma_table_info('SharedNewsArticles') WHERE name = 'ShareKey';";
            if (Convert.ToInt64(await check.ExecuteScalarAsync()) == 0)
                await database.Database.ExecuteSqlRawAsync("ALTER TABLE SharedNewsArticles ADD COLUMN ShareKey TEXT NULL;");
            // Existing URLs remain valid, including multiple snapshots saved by earlier versions.
            await database.Database.ExecuteSqlRawAsync("""
                CREATE UNIQUE INDEX IF NOT EXISTS IX_SharedNewsArticles_UserId_ShareKey
                    ON SharedNewsArticles (UserId, ShareKey);
                """);
        }
        finally { if (wasClosed) await database.Database.CloseConnectionAsync(); }
    }
}
