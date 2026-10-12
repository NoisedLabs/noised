/**
 * /docs and /docs/* (DOCS_WHITEPAPER.md, the /docs part): a sticky glass sidebar, the content column (max 760px)
 * and an "On this page" outline that follows the reader. Pages come from content/docs/nav.ts: Markdown pages,
 * plus the SDK and programs reference generated from the source. Static and CSP-safe: no HTML strings anywhere.
 */
import { ArrowLeft, ArrowRight, ChevronDown, Menu, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useParams } from "react-router";

import { openCommandPalette } from "../../components/CommandPalette";
import { pageScene } from "../../components/art/scenes";
import { NoiseArt, NoiseGrain, ResolveText } from "../../fx/noise";
import { DOC_SECTIONS, docPath, findDocPage, neighbours, sectionOf, type DocPage } from "../../content/docs/nav";
import { prefersReducedMotion } from "../../fx/text";
import { Blocks, DocSlug, docHref } from "./Markdown";
import { Pixel, type GlyphName } from "./pixels";
import { ProgramPage, SdkGroupPage } from "./Reference";
import "./docs.css";

const SECTION_ICON: Record<string, GlyphName> = {
  start: "bolt",
  concepts: "book",
  guides: "terminal",
  sdk: "cube",
  programs: "sig",
  security: "shield",
};

export function DocsPage(): ReactNode {
  const params = useParams();
  const slug = (params["*"] ?? "").replace(/\/+$/, "");
  const page = findDocPage(slug);
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => setMenuOpen(false), [location.pathname, location.hash]);

  // Title.
  useEffect(() => {
    const before = document.title;
    document.title = page ? `${page.title} · Noised docs` : "Not found · Noised docs";
    return () => {
      document.title = before;
    };
  }, [page]);

  // Anchors: after the route's scroll-to-top (Shell), bring the target heading into view.
  const lastPath = useRef("");
  useEffect(() => {
    const samePage = lastPath.current === location.pathname;
    lastPath.current = location.pathname;
    const id = decodeURIComponent(location.hash.replace(/^#/, ""));
    if (!id) return;
    let raf2 = 0;
    let settle = 0;
    let unflash = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el instanceof HTMLDetailsElement) el.open = true;
        const smooth = samePage && !prefersReducedMotion();
        el.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
        // Mark the target (the hash router's URL never matches :target).
        for (const old of document.querySelectorAll("[data-dx-target]")) old.removeAttribute("data-dx-target");
        el.setAttribute("data-dx-target", "true");
        unflash = window.setTimeout(() => el.removeAttribute("data-dx-target"), 2400);
        // Content above can still settle (fonts, figures): land on the target once more.
        if (!smooth) {
          const top = el.getBoundingClientRect().top;
          settle = window.setTimeout(() => {
            if (Math.abs(el.getBoundingClientRect().top - top) > 24) el.scrollIntoView({ block: "start" });
          }, 400);
        }
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.clearTimeout(settle);
      window.clearTimeout(unflash);
    };
  }, [location.pathname, location.hash]);

  return (
    <DocSlug.Provider value={page?.slug ?? slug}>
      <div className="dx" data-home={page?.slug === "" ? "true" : "false"}>
        <div className="dx-mobilebar">
          <button type="button" className="dx-mobilebar-btn" onClick={() => setMenuOpen(true)} aria-haspopup="dialog" aria-expanded={menuOpen}>
            <Menu aria-hidden="true" />
            <span>Docs menu</span>
          </button>
          <span className="dx-mobilebar-here">{page ? sectionOf(page.section).title : "Docs"}</span>
          <button type="button" className="dx-mobilebar-btn dx-icon-only" onClick={() => openCommandPalette()} aria-label="Search the docs">
            <Search aria-hidden="true" />
          </button>
        </div>

        <aside className="dx-side" aria-label="Documentation">
          <SideNav current={page} />
        </aside>

        <MobileNav open={menuOpen} onClose={() => setMenuOpen(false)} current={page} />

        <div className="dx-main">{page ? <Article page={page} /> : <NotFound slug={slug} />}</div>

        <aside className="dx-toc" aria-label="On this page">
          {page && page.headings.length > 0 ? <Outline page={page} /> : null}
        </aside>
      </div>
    </DocSlug.Provider>
  );
}

// --------------------------------------------------------------- sidebar ---

function SideNav({ current, onNavigate }: { current: DocPage | null; onNavigate?: () => void }): ReactNode {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <nav className="dx-nav">
      <button type="button" className="dx-search" onClick={() => openCommandPalette()}>
        <Search aria-hidden="true" />
        <span>Search docs</span>
        <kbd className="dx-kbd">Ctrl K</kbd>
      </button>
      {DOC_SECTIONS.map((s) => {
        const here = current?.section === s.id;
        const expanded = open[s.id] ?? (!s.reference || here);
        const listId = `dx-nav-${s.id}`;
        return (
          <div key={s.id} className="dx-nav-sec" data-here={here ? "true" : "false"}>
            <button
              type="button"
              className="dx-nav-head"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setOpen((o) => ({ ...o, [s.id]: !expanded }))}
            >
              <Pixel name={SECTION_ICON[s.id] ?? "book"} size={16} />
              <span>{s.title}</span>
              <span className="dx-nav-count">{s.pages.length}</span>
              <ChevronDown className="dx-nav-chev" aria-hidden="true" />
            </button>
            <ul id={listId} hidden={!expanded}>
              {s.pages.map((p) => (
                <li key={p.slug}>
                  <NavLink to={docPath(p.slug)} end className="dx-nav-link" onClick={onNavigate}>
                    <span>{p.nav}</span>
                    {p.rolling ? <span className="dx-dot-rolling" role="img" title="Rolling out in this release" aria-label="rolling out" /> : null}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <Link to="/whitepaper" className="dx-nav-paper" onClick={onNavigate}>
        <Pixel name="book" size={22} />
        <span>
          <b>Whitepaper</b>
          <small>The long-form argument, with figures</small>
        </span>
        <ArrowRight aria-hidden="true" />
      </Link>
    </nav>
  );
}

function MobileNav({ open, onClose, current }: { open: boolean; onClose: () => void; current: DocPage | null }): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dx-sheet"
      aria-label="Docs menu"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="dx-sheet-inner">
        <div className="dx-sheet-head">
          <b>Docs</b>
          <button type="button" className="dx-mobilebar-btn dx-icon-only" onClick={onClose} aria-label="Close the docs menu">
            <X aria-hidden="true" />
          </button>
        </div>
        <SideNav current={current} onNavigate={onClose} />
      </div>
    </dialog>
  );
}

// --------------------------------------------------------------- outline ---

function useActiveHeading(ids: readonly string[]): string {
  const [active, setActive] = useState(ids[0] ?? "");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || ids.length === 0) return;
    const els = ids.map((id) => document.getElementById(id)).filter((e): e is HTMLElement => e !== null);
    const visible = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) visible.set(e.target.id, e.isIntersecting);
        const first = els.find((el) => visible.get(el.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-96px 0px -62% 0px", threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ids]);
  return active;
}

function Outline({ page }: { page: DocPage }): ReactNode {
  const ids = useMemo(() => page.headings.map((h) => h.id), [page]);
  const active = useActiveHeading(ids);
  return (
    <nav className="dx-outline">
      <p className="dx-outline-k">On this page</p>
      <ul>
        {page.headings.map((h) => (
          <li key={h.id} data-level={h.level}>
            <Link to={docHref(page.slug, h.id)} className="dx-outline-link" title={h.text} aria-current={active === h.id ? "location" : undefined}>
              {h.text}
            </Link>
          </li>
        ))}
      </ul>
      <button type="button" className="dx-totop" onClick={() => window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" })}>
        Back to top
      </button>
    </nav>
  );
}

// --------------------------------------------------------------- article ---

function Article({ page }: { page: DocPage }): ReactNode {
  const { prev, next } = neighbours(page.slug);
  const section = sectionOf(page.section);
  return (
    <article className="dx-article">
      <header className="dx-head">
        {page.slug !== "" ? (
          <div className="dx-head-field" aria-hidden="true">
            <NoiseGrain fade="radial" pitch={16} strength={0.22} seed={31} />
          </div>
        ) : null}
        <p className="dx-crumbs">
          <Link to="/docs">Docs</Link>
          <span aria-hidden="true">/</span>
          <span>{section.title}</span>
        </p>
        {page.slug === "" ? <HomeArt /> : null}
        <h1 id="dx-title" className="dx-title">
          <ResolveText key={page.slug} text={page.title} trigger="mount" durationMs={680} />
        </h1>
        {page.summary ? <p className="dx-lead">{page.summary}</p> : null}
        <div className="dx-head-tags">
          {page.rolling ? (
            <span className="dx-pill" data-tone="rolling">
              <Pixel name="clock" size={14} /> Rolling out in this release
            </span>
          ) : null}
          {page.kind !== "md" ? (
            <span className="dx-pill">
              <Pixel name="cube" size={14} /> Generated from source
            </span>
          ) : null}
        </div>
      </header>

      {page.headings.length > 0 ? (
        <details className="dx-toc-inline">
          <summary>On this page</summary>
          <ul>
            {page.headings
              .filter((h) => h.level === 2)
              .map((h) => (
                <li key={h.id}>
                  <Link to={docHref(page.slug, h.id)}>{h.text}</Link>
                </li>
              ))}
          </ul>
        </details>
      ) : null}

      <div className="dx-body">
        {page.kind === "md" ? <Blocks blocks={page.blocks} /> : null}
        {page.kind === "sdk-group" ? <SdkGroupPage group={page.ref} /> : null}
        {page.kind === "program" ? <ProgramPage slug={page.ref} /> : null}
      </div>

      <nav className="dx-pager" aria-label="Previous and next page">
        {prev ? (
          <Link to={docPath(prev.slug)} className="dx-pager-link" data-dir="prev">
            <ArrowLeft aria-hidden="true" />
            <span>
              <small>Previous</small>
              <b>{prev.nav}</b>
            </span>
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link to={docPath(next.slug)} className="dx-pager-link" data-dir="next">
            <span>
              <small>Next</small>
              <b>{next.nav}</b>
            </span>
            <ArrowRight aria-hidden="true" />
          </Link>
        ) : null}
      </nav>
    </article>
  );
}

/** The docs home's banner: a shield of dots in a glass frame that streaks of noise bounce off (fx/noise). */
function HomeArt(): ReactNode {
  return (
    <div className="dx-home-art" aria-hidden="true">
      <NoiseArt scene={pageScene("docs")} />
      <span className="dx-home-cap">
        <span>SDK 0.1.0</span>
        <span>Policy v2</span>
      </span>
    </div>
  );
}

function NotFound({ slug }: { slug: string }): ReactNode {
  return (
    <article className="dx-article">
      <header className="dx-head">
        <p className="dx-crumbs">
          <Link to="/docs">Docs</Link>
        </p>
        <h1 id="dx-title" className="dx-title">
          No such page
        </h1>
        <p className="dx-lead">
          There is no docs page at <code className="dx-ic">/docs/{slug}</code>. Search with <kbd className="dx-kbd">Ctrl K</kbd>, or start from the{" "}
          <Link className="dx-a" to="/docs">
            introduction
          </Link>
          .
        </p>
      </header>
    </article>
  );
}
