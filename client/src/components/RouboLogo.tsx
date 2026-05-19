export default function RouboLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden
    >
      <rect x="2" y="3" width="12" height="26" rx="1.5" fill="currentColor" opacity="0.35" />
      <rect x="14" y="3" width="16" height="26" rx="1.5" fill="currentColor" opacity="0.2" />
      <rect x="8" y="10" width="14" height="12" rx="1" fill="currentColor" />
    </svg>
  );
}
