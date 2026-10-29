const seasons = ["halloween", "christmas", "new-year", "chinese-new-year"] as const;
const editions = [
  ["halloween", "Halloween edition", "October 31"],
  ["christmas", "Christmas edition", "Merry Christmas"],
  ["new-year", "New Year edition", "A fresh start"],
  ["chinese-new-year", "Chinese New Year", "新年快乐"],
];

/** CSS selects one mark before hydration, including when opening offline. */
export default function SeasonalBrand() {
  return <>
    <img className="brand-mark brand-mark-standard" src="/icons/signal-medallion-64.png" alt="" aria-hidden="true" />
    {seasons.map(season => <img key={season} className="brand-mark brand-mark-seasonal" data-brand-season={season} src={`/icons/signal-${season}.svg`} alt="" aria-hidden="true" />)}
  </>;
}

export function SeasonalEdition() {
  return <p className="seasonal-edition">{editions.map(([season, title, greeting]) =>
    <span key={season} data-brand-season={season}><span aria-hidden="true">✦ </span>{title} <span aria-hidden="true"> · </span>{greeting}</span>
  )}</p>;
}
