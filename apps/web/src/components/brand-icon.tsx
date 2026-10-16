const iconUrl = new URL('../assets/icon.svg', import.meta.url).href;

/** Decorative brand mark; the surrounding brand text supplies its accessible name. */
export function BrandIcon({ className }: { className?: string }) {
  return <img src={iconUrl} alt="" aria-hidden="true" className={className} />;
}
