import { formatMarketPrice, type MarketQuote } from "./market-quote";

export default function BriefingMarketPrice({ quote }: { quote?: MarketQuote | null }) {
  if (!quote || !Number.isFinite(quote.price)) return null;

  return <aside className="briefing-market-price" aria-label={`Market price for ${quote.name}`}>
    <div className="briefing-market-company">
      <strong>{quote.symbol}</strong>
      <span>{quote.name}</span>
    </div>
    <div className="briefing-market-value">
      <strong>{formatMarketPrice(quote.price, quote.currency)}</strong>
      {quote.currency && <span>{quote.currency}</span>}
      {Number.isFinite(quote.percentChange) && <span className={quote.percentChange > 0 ? "positive" : quote.percentChange < 0 ? "negative" : "unchanged"}>
        {quote.percentChange > 0 ? "+" : ""}{quote.percentChange.toFixed(2)}%
      </span>}
    </div>
    <p>
      {quote.isMarketOpen === null ? "Latest available quote" : quote.isMarketOpen ? "Market open" : "Market closed"}
      {quote.quoteTime && <> · Quote {quote.quoteTime}</>}
      {quote.provider && <> · {quote.provider}</>}
    </p>
  </aside>;
}
