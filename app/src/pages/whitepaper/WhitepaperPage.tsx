/**
 * /whitepaper: "Noised: the quantum security layer for Solana" (DOCS_WHITEPAPER.md, the /whitepaper part).
 *
 * A paper in the app's graphite glass: a cover with a frontispiece computed from the title's own hash, a sticky table
 * of contents with reading progress, fifteen numbered sections with native MathML equations (tex.tsx), numbered
 * figures computed in the browser from the protocol's real formulas and parameters (model/, components/charts), and
 * tables of measured numbers. scripts/whitepaper-pdf.mjs prints the same page (print stylesheet in whitepaper.css)
 * to public/noised-whitepaper.pdf with headless Chrome.
 */
import { BookOpen, Download } from "lucide-react";
import { useEffect, useMemo, type ReactNode } from "react";
import { Link } from "react-router";

import { NoiseGrain, ResolveText } from "../../fx/noise";
import { ChainGrid } from "./figures/ChainGrid";
import { digitsOfText } from "./model/lmotsDemo";
import { FIGURE_COUNT, SECTIONS, TABLE_COUNT } from "./paper";
import { REFS } from "./refs";
import { S01, S02 } from "./sections/s01-02";
import { S03 } from "./sections/s03";
import { S04 } from "./sections/s04";
import { S05 } from "./sections/s05";
import { S06, S07 } from "./sections/s06-07";
import { S08, S09 } from "./sections/s08-09";
import { S10, S11 } from "./sections/s10-11";
import { S12, S13 } from "./sections/s12-13";
import { S14, S15 } from "./sections/s14-15";
import { Toc } from "./toc";
import "../../components/charts/charts.css";
import "./whitepaper.css";

const TITLE = "Noised: the quantum security layer for Solana";
const VERSION = "Protocol v2, safety policy 3 · draft of 2026-10-10";

function Cover(): ReactNode {
  const digits = useMemo(() => digitsOfText(TITLE), []);
  return (
    <header className="wp-cover glass glass-strong">
      <div className="wp-cover-dither px-corners" aria-hidden="true">
        <NoiseGrain fade="right" pitch={16} strength={0.2} seed={37} />
      </div>
      <div className="wp-cover-inner">
      <p className="wp-eyebrow">
        <span className="wp-eyebrow-dot" aria-hidden="true" />
        <span>Whitepaper</span>
        <span>{VERSION}</span>
      </p>
      <h1 className="wp-title">
        <ResolveText text="Noised:" trigger="mount" durationMs={700} />{" "}
        <ResolveText text={"the quantum security layer for Solana"} className="wp-title-soft" trigger="mount" delay={120} durationMs={950} />
      </h1>
      <p className="wp-lede">
        A security layer with four products: a launchpad where no key can rug a launch and the first trade is one fair price for everyone, a
        vault whose keys are hash-based, private balances, and a verifier for QSL-1, the token standard that names these guarantees. The
        creator's identity and long-term custody rest on hash-based signatures that a quantum computer cannot forge. With every derivation,
        every bound, and an honest list of what is still trusted.
      </p>
      <dl className="wp-meta px-corners">
        <div>
          <dt>Sections</dt>
          <dd>{SECTIONS.length}</dd>
        </div>
        <div>
          <dt>Figures, computed live</dt>
          <dd>{FIGURE_COUNT}</dd>
        </div>
        <div>
          <dt>Tables</dt>
          <dd>{TABLE_COUNT}</dd>
        </div>
        <div>
          <dt>References</dt>
          <dd>{REFS.length}</dd>
        </div>
      </dl>
      <div className="wp-actions">
        <a className="btn btn-primary" href="noised-whitepaper.pdf" download="noised-whitepaper.pdf">
          <Download aria-hidden="true" className="h-4 w-4" />
          Download PDF
        </a>
        <Link className="btn btn-secondary" to="/docs">
          <BookOpen aria-hidden="true" className="h-4 w-4" />
          Developer docs
        </Link>
      </div>
      <div className="wp-art">
        <ChainGrid digits={digits} label="Frontispiece: the 67 Winternitz chains of an LM-OTS signature over this paper's title" />
        <p className="wp-art-cap">
          Frontispiece. The 67 hash chains an LM-OTS signature over this paper's title would reveal: 64 digits of SHA-256(title), then the 3
          checksum digits. Section 4 explains every pixel.
        </p>
      </div>
      <div className="wp-print-toc" aria-hidden="true">
        <p className="wp-print-toc-h">Contents</p>
        <ol>
          {SECTIONS.map((s) => (
            <li key={s.id}>
              <span>{String(s.n).padStart(2, "0")}</span> {s.title}
            </li>
          ))}
        </ol>
      </div>
      </div>
    </header>
  );
}

export function WhitepaperPage(): ReactNode {
  useEffect(() => {
    const prev = document.title;
    document.title = "Whitepaper · Noised";
    return () => {
      document.title = prev;
    };
  }, []);
  return (
    <div className="wp">
      <Cover />
      <div className="wp-layout">
        <Toc />
        <article id="wp-article" className="wp-article" aria-label="Whitepaper">
          <S01 />
          <S02 />
          <S03 />
          <S04 />
          <S05 />
          <S06 />
          <S07 />
          <S08 />
          <S09 />
          <S10 />
          <S11 />
          <S12 />
          <S13 />
          <S14 />
          <S15 />
        </article>
      </div>
    </div>
  );
}
