/**
 * Root motion provider: the full motion feature set (domMax: animations,
 * gestures, whileInView, layout and layoutId) and the user's reduced-motion
 * preference. Mounted once in main.tsx; components use `m.*` (or `motion.*`)
 * from "motion/react".
 */
import { domMax, LazyMotion, MotionConfig } from "motion/react";
import type { ReactNode } from "react";

export function MotionRoot({ children }: { children: ReactNode }): ReactNode {
  return (
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domMax}>{children}</LazyMotion>
    </MotionConfig>
  );
}
