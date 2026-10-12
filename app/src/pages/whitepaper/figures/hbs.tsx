/** Section 4 figures: a Winternitz chain, the live LM-OTS signature, verification work, an LMS tree, forgery cost. */
import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from "react";

import { DEdge, Diagram, DNode, DText, LineChart, steppedRect, type LineSeries } from "../../../components/charts";
import { CHAIN_END, forgeryAt, quantile, quantumLog2, verifyStepsDistribution } from "../model/lmots";
import { demoSign, hex } from "../model/lmotsDemo";
import { lmsVerifyCU } from "../model/perf";
import { C, Figure, SecRef } from "../paper";
import { M } from "../tex";
import { ChainGrid } from "./ChainGrid";

// ------------------------------------------------------------------ chain ---

function ChainRow({ y, digit, label, forged, sub }: { y: number; digit: number; label: string; forged: number; sub: string }): ReactNode {
  const x0 = 120;
  const pitch = 44;
  const cells: ReactNode[] = [];
  for (let j = 0; j <= CHAIN_END; j++) {
    const kind = j < digit ? "s" : j === digit ? "y" : "v";
    cells.push(<rect key={j} x={x0 + j * pitch} y={y} width={30} height={30} className={`chain-cell chain-${kind}`} />);
    if (j === 0 || j === CHAIN_END || j === digit || j === forged)
      cells.push(
        <text key={`t${j}`} x={x0 + j * pitch + 15} y={y + 19} textAnchor="middle" className={j === digit ? "chain-num chain-num-on" : "chain-num"}>
          {j}
        </text>,
      );
  }
  const ok = forged > digit;
  return (
    <g>
      <DText x={8} y={y + 13} kind="title">
        {label}
      </DText>
      <DText x={8} y={y + 29} kind="small">
        {sub}
      </DText>
      {cells}
      <DEdge points={[[x0 + 15, y + 44], [x0 + digit * pitch + 15, y + 44]]} label={`signer: ${digit} steps`} labelAt={[x0 + (digit * pitch) / 2 + 15, y + 60, "middle"]} ink={3} />
      <DEdge points={[[x0 + digit * pitch + 15, y - 12], [x0 + CHAIN_END * pitch + 15, y - 12]]} label={`verifier: ${CHAIN_END - digit} steps to z`} labelAt={[x0 + ((digit + CHAIN_END) * pitch) / 2 + 15, y - 18, "middle"]} ink={2} />
      <DEdge
        d={`M${x0 + digit * pitch + 15} ${y + 34} C ${x0 + digit * pitch + 15} ${y + 78}, ${x0 + forged * pitch + 15} ${y + 78}, ${x0 + forged * pitch + 15} ${y + 36}`}
        dash="dash"
        ink={ok ? 1 : "danger"}
      />
      <DText x={x0 + forged * pitch + 15 + (ok ? 12 : -12)} y={y + 86} anchor={ok ? "start" : "end"}>
        {ok ? `forger: ${digit} → ${forged} is just hashing forward` : `forger: ${digit} → ${forged} needs a SHA-256 preimage`}
      </DText>
    </g>
  );
}

export function ChainFigure(): ReactNode {
  return (
    <Figure
      id="fig-chain"
      title="Why the checksum stops a forger."
      caption={
        <>
          Each of the 67 chains has 16 positions; the secret <M>{"x_i"}</M> sits at 0 and the public end <M>{"z_i"}</M> at 15. A signature reveals
          position <M>{"a_i"}</M>. Anyone can hash forward, so a forger can raise a message digit (top). But raising message digits lowers the
          checksum, so some checksum digit would have to fall (bottom): that is a step backwards, a preimage of SHA-256 (Lemma 4.1).
        </>
      }
      wide
    >
      <Diagram w={860} h={300} minWidth={680} label="Two Winternitz chains: a message digit raised by hashing forward, and a checksum digit that would need to go backwards">
        <ChainRow y={40} digit={9} forged={11} label="message chain" sub="digit a_i = 9" />
        <ChainRow y={184} digit={6} forged={4} label="checksum chain" sub="digit c_j = 6" />
      </Diagram>
    </Figure>
  );
}

// ------------------------------------------------------- live signature ---

export function LiveSignatureFigure(): ReactNode {
  const [text, setText] = useState("withdraw 250 tokens to my wallet");
  const deferred = useDeferredValue(text);
  const sig = useMemo(() => demoSign(deferred), [deferred]);
  return (
    <Figure
      id="fig-digits"
      title="A real LM-OTS signature, computed in your browser."
      caption={
        <>
          Type a message. The page computes <M>{"Q = H(I \\| q \\| \\texttt{0x8181} \\| C \\| M)"}</M> with the deterministic randomizer{" "}
          <M>{"C"}</M>, splits <M>{"Q"}</M> into 64 base-16 digits, appends the 3 checksum digits, signs with a demo key (derived from a public
          string, so it protects nothing) and verifies. Each column is one chain: the bright cell is the revealed value, filled cells below it the
          signer's hashes, hollow cells above it the verifier's.
        </>
      }
      wide
    >
      <label className="wp-field">
        Message
        <input className="wp-input" value={text} maxLength={200} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      </label>
      <ChainGrid digits={sig.digits} label={`The 67 chains of the signature over "${sig.message}"`} />
      <dl className="wp-stats">
        <div>
          <dt>C (first 8 bytes)</dt>
          <dd>{hex(sig.C, 8)}</dd>
        </div>
        <div>
          <dt>Q (first 8 bytes)</dt>
          <dd>{hex(sig.Q, 8)}</dd>
        </div>
        <div>
          <dt>Checksum</dt>
          <dd>{`${sig.checksum} = 0x${sig.checksum.toString(16)}`}</dd>
        </div>
        <div>
          <dt>Verifier steps</dt>
          <dd>{`${sig.verifierSteps} ≈ ${Math.round(lmsVerifyCU(sig.verifierSteps) / 1000)}k CU`}</dd>
        </div>
        <div>
          <dt>Verified</dt>
          <dd>{sig.ok ? "yes: K' = K" : "no"}</dd>
        </div>
      </dl>
    </Figure>
  );
}

// ---------------------------------------------------- verification work ---

export function StepsFigure(): ReactNode {
  const data = useMemo(() => {
    const dist = verifyStepsDistribution();
    let mean = 0;
    let max = 0;
    for (let t = 0; t < dist.length; t++) {
      const p = dist[t] ?? 0;
      mean += t * p;
      if (p > 0) max = t;
    }
    let cum = 0;
    let p99 = 0;
    let p50 = 0;
    for (let t = 0; t < dist.length; t++) {
      cum += dist[t] ?? 0;
      if (p50 === 0 && cum >= 0.5) p50 = t;
      if (cum >= 0.99) {
        p99 = t;
        break;
      }
    }
    const pts: [number, number][] = [];
    // T is always a multiple of 15 (Lemma 4.3): plot the support only.
    for (let t = 300; t <= 720; t += 15) pts.push([t, (dist[t] ?? 0) * 100]);
    return { pts, mean, p99, p50, max };
  }, []);
  const series: LineSeries[] = [{ id: "pmf", label: "probability (%)", points: data.pts, ink: 1, stem: true, format: (v) => `${v.toFixed(3)}%` }];
  return (
    <Figure
      id="fig-steps"
      title="Verification work for a random digest (exact distribution)."
      caption={
        <>
          <M>{"T = \\sum_{i<67} (15 - a_i)"}</M> chain steps, computed exactly by convolving 64 uniform digits and mapping each checksum to its
          three digits; <M>{"T"}</M> only takes multiples of 15 (Lemma 4.3). Mean {data.mean.toFixed(1)}, median {data.p50}, 99th percentile {data.p99}, maximum {data.max} (an all-zero digest). At the
          measured <M>{"8{,}674 + 137\\,T"}</M> CU of <C>lms_verify</C> that is about {Math.round(lmsVerifyCU(data.mean) / 1000)}k CU on average,{" "}
          {Math.round(lmsVerifyCU(data.p99) / 1000)}k at the 99th percentile and {Math.round(lmsVerifyCU(data.max) / 1000)}k at worst. Values
          outside 300-720 steps carry less than 10<sup>-6</sup> of the mass and are cut from the plot.
        </>
      }
    >
      <LineChart
        series={series}
        x={{ domain: [300, 720], label: "chain steps the verifier hashes" }}
        y={{ domain: [0, 18], label: "probability (%)", ticks: [0, 3, 6, 9, 12, 15, 18], format: (v) => `${v}%` }}
        rules={[
          { axis: "x", value: data.mean, label: `mean ${data.mean.toFixed(0)}`, ink: 2 },
          { axis: "x", value: data.p99, label: `p99 ${data.p99}`, ink: 3 },
        ]}
        height={280}
        xTip={(x) => `${x} steps ≈ ${Math.round(lmsVerifyCU(x)).toLocaleString("en-US")} CU`}
        ariaLabel="Distribution of the number of chain steps a verifier hashes"
      />
    </Figure>
  );
}

// ---------------------------------------------------------------- LMS tree ---

export function TreeFigure(): ReactNode {
  const h = 4;
  const leaves = 1 << h;
  const q = 5;
  const w = 880;
  const levelY = (lvl: number): number => 30 + lvl * 62;
  const nodeX = (r: number): number => {
    const lvl = Math.floor(Math.log2(r));
    const idx = r - (1 << lvl);
    const span = w / (1 << lvl);
    return span * idx + span / 2;
  };
  const path = new Set<number>();
  const sib = new Set<number>();
  for (let r = leaves + q; r > 1; r = Math.floor(r / 2)) {
    path.add(r);
    sib.add(r ^ 1);
  }
  path.add(1);
  const nodes: ReactNode[] = [];
  const edges: ReactNode[] = [];
  for (let r = 1; r < 2 * leaves; r++) {
    const lvl = Math.floor(Math.log2(r));
    const x = nodeX(r);
    const y = levelY(lvl);
    if (r > 1) {
      const p = Math.floor(r / 2);
      edges.push(<line key={`e${r}`} x1={nodeX(p)} y1={levelY(lvl - 1) + 12} x2={x} y2={y - 12} className={path.has(r) ? "tree-edge tree-edge-on" : "tree-edge"} />);
    }
    const kind = path.has(r) ? "path" : sib.has(r) ? "sib" : "plain";
    const wN = lvl === h ? 46 : 54;
    nodes.push(
      <g key={`n${r}`} className={`tree-node tree-${kind}`}>
        <path d={steppedRect(x - wN / 2, y - 12, wN, 24, 2)} />
        <text x={x} y={y + 4} textAnchor="middle">{`T[${r}]`}</text>
      </g>,
    );
  }
  const leafY = levelY(h) + 34;
  return (
    <Figure
      id="fig-tree"
      title="An LMS tree and one authentication path."
      caption={
        <>
          Drawn with height 4 (16 leaves) for legibility; a Noised identity has height 10 (1,024 leaves, a 10-node path). Leaf{" "}
          <M>{"q = 5"}</M> is node <M>{"T[2^h + q] = T[21]"}</M>. The signature carries the LM-OTS signature of that leaf and the siblings on its
          way up (outlined); the verifier recomputes the filled nodes and compares the result with the public root <M>{"T[1]"}</M>.
        </>
      }
      wide
    >
      <Diagram w={w} h={leafY + 40} minWidth={660} label="Merkle tree of height 4 with the authentication path of leaf 5">
        {edges}
        {nodes}
        {Array.from({ length: leaves }, (_, i) => (
          <DText key={i} x={nodeX(leaves + i)} y={leafY} anchor="middle" kind={i === q ? "mono" : "faint"}>
            {i === q ? `K₅` : `K${i}`}
          </DText>
        ))}
        <DNode x={8} y={4} w={250} h={54} title="the verifier climbs" lines={["r = 2^h + q, then r ← ⌊r/2⌋", "h hashes, then compare with T[1]"]} kind="note" align="start" />
      </Diagram>
    </Figure>
  );
}

// ------------------------------------------------------------ forgery cost ---

interface ForgeryPoint {
  k: number;
  p10: number;
  p50: number;
  p90: number;
}

function useForgerySweep(kMax: number, trials: number): ForgeryPoint[] {
  const [points, setPoints] = useState<ForgeryPoint[]>([]);
  useEffect(() => {
    let cancelled = false;
    let k = 1;
    let batch = 0;
    const CHUNK = 16;
    let acc: number[] = [];
    const out: ForgeryPoint[] = [];
    let id = 0;
    const run = (): void => {
      if (cancelled) return;
      // 16 keys per task keeps every task short (tens of milliseconds) and the page responsive.
      acc = acc.concat(forgeryAt(k, CHUNK, 0x5eed + k * 1_000 + batch).log2Work);
      batch++;
      if (acc.length >= trials) {
        out.push({ k, p10: quantile(acc, 0.1), p50: quantile(acc, 0.5), p90: quantile(acc, 0.9) });
        setPoints([...out]);
        k++;
        batch = 0;
        acc = [];
      }
      if (k <= kMax) id = window.setTimeout(run, 8);
    };
    id = window.setTimeout(run, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [kMax, trials]);
  return points;
}

export function ForgeryFigure(): ReactNode {
  const KMAX = 8;
  const TRIALS = 64;
  const pts = useForgerySweep(KMAX, TRIALS);
  const done = pts.length === KMAX;
  const series: LineSeries[] = [
    { id: "cl", label: "classical, median key", points: pts.map((p) => [p.k, p.p50]), ink: 1, format: (v) => `2^${v.toFixed(1)}` },
    { id: "q", label: "quantum (Grover), median key", points: pts.map((p) => [p.k, quantumLog2(p.p50)]), ink: 2, dash: "dash", format: (v) => `2^${v.toFixed(1)}` },
    { id: "lo", label: "classical, weakest 10% of keys", points: pts.map((p) => [p.k, p.p10]), ink: 3, dash: "dot", format: (v) => `2^${v.toFixed(1)}` },
  ];
  const k2 = pts.find((p) => p.k === 2);
  return (
    <Figure
      id="fig-forge"
      title="Forgery cost after k signatures by one LM-OTS key."
      caption={
        <>
          log2 of the expected number of digests a forger must try, per key, when it holds <M>{"k"}</M> signatures of independent random digests
          by the same key: exact per-key probabilities (equation 4.6), {TRIALS} random keys per <M>{"k"}</M>, deterministic seed. With one
          signature the cost is exactly <M>{"2^{256}"}</M> (Lemma 4.1).{" "}
          {k2 ? (
            <>
              With two it collapses to a median of <M>{`2^{${k2.p50.toFixed(1)}}`}</M>, and the weakest 10% of key pairs fall to{" "}
              <M>{`2^{${k2.p10.toFixed(1)}}`}</M> or less: minutes of hashing on one ordinary computer.
            </>
          ) : null}{" "}
          The dashed line applies Grover's square root. Hence one key, one signature, enforced on-chain (<SecRef to="vault" />,{" "}
          <SecRef to="identity" />).
        </>
      }
    >
      <div data-wp-compute={done ? "done" : "running"}>
        <LineChart
          series={series}
          x={{ domain: [1, KMAX], label: "signatures revealed by one key (k)", ticks: [1, 2, 3, 4, 5, 6, 7, 8] }}
          y={{ domain: [0, 260], label: "forgery work (bits, log2)", ticks: [0, 32, 64, 96, 128, 160, 192, 224, 256], format: (v) => String(v) }}
          rules={[
            { axis: "y", value: 128, label: "128-bit security", ink: 3, at: "end" },
            { axis: "y", value: 64, label: "2⁶⁴ hashes: feasible today", ink: "danger", at: "end" },
          ]}
          height={320}
          xTip={(x) => `k = ${x} signature${x === 1 ? "" : "s"}`}
          ariaLabel="Forgery work in bits as a function of the number of signatures revealed by one LM-OTS key"
        />
      </div>
      {!done ? <p className="wp-art-cap">{`Computing exact probabilities: k = ${pts.length + 1} of ${KMAX}…`}</p> : null}
    </Figure>
  );
}
