import type { HTMLAttributes } from 'react';

/**
 * Loading-state primitive — a content-shaped placeholder shown while data
 * loads, so a screen reads as "filling in" rather than blank or stuck on a
 * plain "Loading…". A directional shimmer (keyframes `skeleton-shimmer` in
 * index.css) makes loading read as motion toward content; it falls back to a
 * plain pulse when the operator prefers reduced motion. Ported from FleetHQ so
 * the two apps read as one platform.
 */
export function Skeleton({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl bg-(--surface-2) after:absolute after:inset-0 after:-translate-x-full after:animate-[skeleton-shimmer_1.6s_infinite] after:bg-gradient-to-r after:from-transparent after:via-(--text-tertiary)/10 after:to-transparent motion-reduce:animate-pulse motion-reduce:after:hidden ${className}`}
      {...props}
    />
  );
}
