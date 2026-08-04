namespace Signal.Server.Services;

public sealed record MarketTickerReference(string Symbol, string Exchange)
{
    public string QualifiedSymbol => Exchange.Length > 0 ? $"{Symbol}:{Exchange}" : Symbol;
}

public static class MarketTickerParser
{
    public const string ValidationMessage =
        "Enter a ticker such as AAPL or an exchange-qualified ticker such as AIR:NZX.";

    public static MarketTickerReference? ParseOptional(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (TryParse(value, out var ticker)) return ticker;
        throw new ArgumentException(ValidationMessage);
    }

    public static bool TryParse(string? value, out MarketTickerReference? ticker)
    {
        ticker = null;
        if (string.IsNullOrWhiteSpace(value)) return false;

        var parts = value.Trim().TrimStart('$').ToUpperInvariant()
            .Split(':', StringSplitOptions.TrimEntries);
        if (parts.Length is < 1 or > 2 || !IsValidSymbol(parts[0])) return false;

        var exchange = parts.Length == 2 ? NormalizeExchange(parts[1]) : "";
        if (parts.Length == 2 && !IsValidExchange(exchange)) return false;

        ticker = new MarketTickerReference(parts[0], exchange);
        return true;
    }

    private static string NormalizeExchange(string exchange) => exchange switch
    {
        "XNZE" => "NZX",
        _ => exchange,
    };

    private static bool IsValidSymbol(string symbol) =>
        symbol.Length is >= 1 and <= 15
        && char.IsAsciiLetterOrDigit(symbol[0])
        && symbol.All(character => char.IsAsciiLetterOrDigit(character)
            || character is '.' or '-' or '^');

    private static bool IsValidExchange(string exchange) =>
        exchange.Length is >= 2 and <= 12
        && char.IsAsciiLetterOrDigit(exchange[0])
        && exchange.All(character => char.IsAsciiLetterOrDigit(character)
            || character is '.' or '-' or '_');
}
