/** Both marks are rendered so the early seasonal bootstrap also works offline. */
export default function SeasonalBrand() {
  return <>
    <img className="brand-mark brand-mark-standard" src="/icons/signal-medallion-64.png" alt="" aria-hidden="true" />
    <img className="brand-mark brand-mark-halloween" src="/icons/signal-halloween.svg" alt="" aria-hidden="true" />
  </>;
}

export function SeasonalEdition() {
  return <p className="seasonal-edition"><span aria-hidden="true">✦</span> Halloween edition <span aria-hidden="true">·</span> October 31</p>;
}
