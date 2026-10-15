using System.Data;
using Microsoft.EntityFrameworkCore;

namespace Signal.Server.Data;

internal static class AnonymousCommentSchema
{
    internal static async Task UpgradeAsync(SignalDbContext database)
    {
        var connection = database.Database.GetDbConnection();
        var wasClosed = connection.State == ConnectionState.Closed;
        if (wasClosed) await database.Database.OpenConnectionAsync();
        try
        {
            await using var check = connection.CreateCommand();
            check.CommandText = "SELECT COUNT(*) FROM pragma_table_info('SharedNewsArticles') WHERE name = 'DiscussionUrl';";
            if (Convert.ToInt64(await check.ExecuteScalarAsync()) == 0)
                await database.Database.ExecuteSqlRawAsync("ALTER TABLE SharedNewsArticles ADD COLUMN DiscussionUrl TEXT NOT NULL DEFAULT ''; ");

            check.CommandText = "SELECT COUNT(*) FROM pragma_table_info('NewsComments') WHERE name = 'UserId' AND \"notnull\" = 1;";
            if (Convert.ToInt64(await check.ExecuteScalarAsync()) == 0) return;
            // SQLite requires a table rebuild to make an existing foreign key nullable.
            // Keep IDs, ownership, indexes and the high-water mark in one transaction.
            await using var transaction = await database.Database.BeginTransactionAsync();
            await database.Database.ExecuteSqlRawAsync("""
                CREATE TABLE NewsComments_AnonymousUpgrade (
                    Id INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
                    ArticleUrl TEXT NOT NULL,
                    ArticleTitle TEXT NOT NULL,
                    UserId TEXT NULL,
                    Body TEXT NOT NULL,
                    CreatedAtUtc TEXT NOT NULL,
                    FOREIGN KEY (UserId) REFERENCES AspNetUsers (Id) ON DELETE CASCADE
                );
                INSERT INTO NewsComments_AnonymousUpgrade (Id, ArticleUrl, ArticleTitle, UserId, Body, CreatedAtUtc)
                    SELECT Id, ArticleUrl, ArticleTitle, UserId, Body, CreatedAtUtc FROM NewsComments;
                UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'NewsComments'), 0))
                    WHERE name = 'NewsComments_AnonymousUpgrade';
                INSERT INTO sqlite_sequence (name, seq)
                    SELECT 'NewsComments_AnonymousUpgrade', seq FROM sqlite_sequence WHERE name = 'NewsComments'
                    AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'NewsComments_AnonymousUpgrade');
                DROP TABLE NewsComments;
                ALTER TABLE NewsComments_AnonymousUpgrade RENAME TO NewsComments;
                CREATE INDEX IX_NewsComments_ArticleUrl_CreatedAtUtc ON NewsComments (ArticleUrl, CreatedAtUtc);
                CREATE INDEX IX_NewsComments_UserId ON NewsComments (UserId);
                """);
            await transaction.CommitAsync();
        }
        finally { if (wasClosed) await database.Database.CloseConnectionAsync(); }
    }
}
