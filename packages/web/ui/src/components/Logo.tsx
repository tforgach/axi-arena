/** axi-arena mark: a purple Colosseum (public/logo.png, 128px for crisp rendering at 2×). */
export function LogoMark({ size = 30 }: { size?: number }) {
  return <img className="logo-mark" src="/logo.png" width={size} height={size} alt="" aria-hidden="true" />;
}

export function Logo() {
  return (
    <a className="brand" href="#/" aria-label="axi-arena, all runs">
      <LogoMark />
      <span>axi-arena</span>
    </a>
  );
}
