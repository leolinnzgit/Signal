using Microsoft.EntityFrameworkCore;

namespace Signal.Server.Data;

public static class DisasterDeviceSchema
{
    public static async Task UpgradeAsync(SignalDbContext database)
    {
        var wasClosed = database.Database.GetDbConnection().State == System.Data.ConnectionState.Closed;
        if (wasClosed) await database.Database.OpenConnectionAsync();
        try
        {
            var columns = new HashSet<string>();
            await using (var command = database.Database.GetDbConnection().CreateCommand())
            {
                command.CommandText = "PRAGMA table_info(\"EarthquakeDevices\");";
                await using var reader = await command.ExecuteReaderAsync();
                while (await reader.ReadAsync()) columns.Add(reader.GetString(1));
            }
            if (!columns.Contains("HazardKindsJson"))
                await database.Database.ExecuteSqlRawAsync("ALTER TABLE \"EarthquakeDevices\" ADD COLUMN \"HazardKindsJson\" TEXT NOT NULL DEFAULT '[\"earthquake\"]';");
            if (!columns.Contains("MinimumAlertLevel"))
                await database.Database.ExecuteSqlRawAsync("ALTER TABLE \"EarthquakeDevices\" ADD COLUMN \"MinimumAlertLevel\" TEXT NOT NULL DEFAULT 'green';");
            if (!columns.Contains("WeatherAlertThreshold"))
                await database.Database.ExecuteSqlRawAsync("ALTER TABLE \"EarthquakeDevices\" ADD COLUMN \"WeatherAlertThreshold\" TEXT NOT NULL DEFAULT 'all';");
        }
        finally { if (wasClosed) await database.Database.CloseConnectionAsync(); }
    }
}
