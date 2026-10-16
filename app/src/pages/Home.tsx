import { useConnection } from "@solana/wallet-adapter-react";
import { memo, useMemo, type ReactNode } from "react";

import { useAsync } from "../app/hooks";
import { BuildWithNoised } from "../components/landing/BuildWithNoised";
import { CtaBand } from "../components/landing/CtaBand";
import { Hero } from "../components/landing/Hero";
import { HowItWorks } from "../components/landing/HowItWorks";
import { KeepSafe } from "../components/landing/KeepSafe";
import { LiveLaunches } from "../components/landing/LiveLaunches";
import { usePhaseNow } from "../components/landing/phaseClock";
import { WhyNoised } from "../components/landing/WhyNoised";
import { unixSecs } from "../lib/format";
import { listListedLaunches } from "../lib/brandGuard";
import { launchPhase } from "../lib/noised";

import "../components/landing/tokens.css";
import "../components/landing/sections.css";
import "../components/landing/noise/home.css";

/** The hero ticks on its own (HeroStats reads the clock); the page's renders do not need to reach it. */
const StableHero = memo(Hero);

/**
 * The home page, in this order and nothing else: hero (with the three live numbers), the live
 * launches right under those numbers, Why Noised, How it works, Keep it safe, Build with Noised (what developers
 * install, and the verified programs), the closing call to action. The footer belongs to the shell. One launch-list
 * read feeds the hero and the launches.
 */
export function HomePage(): ReactNode {
  const { connection } = useConnection();
  const launches = useAsync(() => listListedLaunches(connection), [connection]);
  // Re-renders at phase boundaries only.
  const now = usePhaseNow(launches.data);
  const rows = useMemo(() => (launches.data ?? []).map((launch) => ({ launch, phase: launchPhase(launch, unixSecs(now)) })), [launches.data, now]);
  const heroLaunches = useMemo(() => ({ data: launches.data, error: launches.error }), [launches.data, launches.error]);

  return (
    <div className="ld-home">
      <StableHero launches={heroLaunches} />
      <LiveLaunches launches={launches} rows={rows} />
      <WhyNoised />
      <HowItWorks />
      <KeepSafe />
      <BuildWithNoised />
      <CtaBand />
    </div>
  );
}
