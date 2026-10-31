const logoUrl = new URL('../assets/logo.svg', import.meta.url).href;

/** Horizontal lockup shared by navigation and public entry pages. */
export function BrandLogo({ className }: { className?: string }) {
  return <img src={logoUrl} alt="eat — Easy Agent Team" className={className} />;
}
