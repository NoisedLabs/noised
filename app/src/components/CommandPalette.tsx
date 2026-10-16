/**
 * Command palette (TERMINAL_V2 spec section 5): ⌘K / Ctrl+K or "/" anywhere
 * (outside text fields). A native <dialog> (focus trap + Escape for free)
 * with a `noised>` prompt, fuzzy-filtered commands, arrow keys + Enter, and
 * output that streams in line by line.
 *
 *   openCommandPalette();                         // empty prompt
 *   openCommandPalette("verify " + mint, true);   // prefill and run
 *
 * Read-only: it navigates, toggles settings and runs the same verification
 * report the token page shows (verifyCached). It never builds or signs a
 * transaction. Typing also searches the developer docs (pages, headings, SDK
 * exports, instructions, accounts and error codes); that index loads lazily,
 * the first time the palette opens.
 */
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { Search } from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useNavigate } from "react-router";

import { isPalette, PALETTE_META, PALETTES, useSettings, type Palette } from "../app/settings";
import { verifyCached } from "../app/verification";
import { sfx, useSound } from "../fx/sfx";
import { prefersReducedMotion, Typewriter } from "../fx/text";
import { errorMessage, shortKey, unixSecs } from "../lib/format";
import { listListedLaunches, mintBrandFlag } from "../lib/brandGuard";
import { OFFICIAL_NOISED } from "../lib/brandPolicy";
import { ADAPTER_MODE, launchPhase, type LaunchAccount, type VerificationReport } from "../lib/noised";
import { useAmbientMotion } from "./AmbientMotion";
import { isPqCheck, PQ_PENDING, pqOrigin } from "./launch";
import { shortCheck } from "./verifyLabels";

// ------------------------------------------------------------- open API ---

const OPEN_EVENT = "phx:palette";

/** Open the palette from anywhere; `initial` prefills the prompt, `run` executes it. */
export function openCommandPalette(initial = "", run = false): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { initial, run } }));
}

// --------------------------------------------------------------- output ---

type Tone = "cmd" | "subj" | "info" | "ok" | "warn" | "fail" | "dim";

interface Line {
  id: number;
  tone: Tone;
  tag: string;
  text: string;
  /** Right column (dotted leader between text and val). */
  val?: string;
  title?: string;
  /** Optional follow-up action rendered as a button. */
  action?: { label: string; run: () => void };
}

type LineInput = Omit<Line, "id">;

interface Command {
  name: string;
  /** Unique key when `name` can repeat (docs results). */
  id?: string;
  arg?: string;
  desc: string;
  group: "INSPECT" | "TOKENS" | "DOCS" | "NAVIGATE" | "SYSTEM";
  run: (arg: string) => void | Promise<void>;
}

type DocsSearch = typeof import("../content/docs/search");

/** List key and a DOM-id-safe suffix for a command. */
function cmdKey(c: Command): string {
  return c.id ?? c.name;
}
function cmdDomId(c: Command): string {
  return cmdKey(c).replace(/[^A-Za-z0-9_-]+/g, "-");
}

/** Subsequence fuzzy score (higher = better, -1 = no match). */
function fuzzy(query: string, target: string): number {
  if (query === "") return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (t.startsWith(q)) return 100 - t.length;
  let ti = 0;
  let score = 0;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at < 0) return -1;
    score += at === ti ? 3 : 1;
    ti = at + 1;
  }
  return score;
}

function isAddress(text: string): PublicKey | null {
  const v = text.trim();
  if (v.length < 32 || v.length > 44) return null;
  try {
    return new PublicKey(v);
  } catch {
    return null;
  }
}

/** What each command group is called on screen. */
const GROUP_LABEL: Record<Command["group"], string> = { INSPECT: "Check", TOKENS: "Tokens", DOCS: "Docs", NAVIGATE: "Go to", SYSTEM: "Preferences" };

function tokenRoute(l: LaunchAccount): string {
  return `/token/${l.status === "live" ? l.baseMint.toBase58() : l.publicKey.toBase58()}`;
}

// ------------------------------------------------------------ component ---

export function CommandPalette(): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [sel, setSel] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [shown, setShown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [tokens, setTokens] = useState<{ sym: string; name: string; route: string; live: boolean; phase: string }[] | null>(null);
  const seq = useRef(0);
  const bodyRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const navigate = useNavigate();
  const { connection } = useConnection();
  const { palette, setPalette, cyclePalette, setTheme } = useSettings();
  const [docs, setDocs] = useState<DocsSearch | null>(null);
  const sound = useSound();
  const motion = useAmbientMotion();

  const push = useCallback((...items: LineInput[]) => {
    setLines((prev) => [...prev, ...items.map((l) => ({ ...l, id: ++seq.current }))].slice(-60));
  }, []);

  // Stream lines in one by one.
  useEffect(() => {
    if (shown >= lines.length) return;
    if (prefersReducedMotion()) {
      setShown(lines.length);
      return;
    }
    const t = setTimeout(() => setShown((s) => s + 1), 55);
    return () => clearTimeout(t);
  }, [shown, lines.length]);

  // Keep the newest output line in view.
  useEffect(() => {
    const b = bodyRef.current;
    if (b && shown > 0) b.scrollTop = b.scrollHeight;
  }, [shown]);

  const close = useCallback(() => {
    setOpen(false);
  }, []);

  const go = useCallback(
    (path: string, label: string) => {
      push({ tone: "info", tag: ">", text: `opening ${label}…` });
      setTimeout(
        () => {
          navigate(path);
          setOpen(false);
        },
        prefersReducedMotion() ? 0 : 260,
      );
    },
    [navigate, push],
  );

  const findLaunch = useCallback(
    async (needle: string): Promise<LaunchAccount | null> => {
      const n = needle.trim().toLowerCase();
      const all = await listListedLaunches(connection);
      return (
        all.find(
          (l) =>
            (l.market?.symbol ?? "").toLowerCase() === n ||
            (l.market?.name ?? "").toLowerCase() === n ||
            l.baseMint.toBase58().toLowerCase() === n ||
            l.publicKey.toBase58().toLowerCase() === n,
        ) ??
        all.find((l) => (l.market?.name ?? "").toLowerCase().startsWith(n) || (l.market?.symbol ?? "").toLowerCase().startsWith(n)) ??
        null
      );
    },
    [connection],
  );

  const runVerify = useCallback(
    async (arg: string) => {
      const a = arg.trim();
      if (a === "") {
        push({ tone: "warn", tag: "[!]", text: "usage: verify <mint address | symbol>" });
        return;
      }
      let mint = isAddress(a);
      let named: { sym: string; name: string } | null = null;
      if (!mint) {
        const l = await findLaunch(a);
        if (l?.status === "live") {
          mint = l.baseMint;
          named = { sym: l.market?.symbol ?? "", name: l.market?.name ?? "" };
        } else if (l) {
          push({ tone: "warn", tag: "[!]", text: `${l.market?.symbol ?? "launch"} is configured but not launched: no mint to verify yet.` });
          return;
        }
      }
      if (!mint) {
        push({ tone: "fail", tag: "[×]", text: `"${a}" is not a mint address or a known symbol.` });
        sfx.play("error");
        return;
      }
      // A pinned subject row: which mint this output is about stays in view while the checks stream.
      const known = named ?? (tokens ?? []).find((t) => t.route === `/token/${mint.toBase58()}`) ?? null;
      push({ tone: "subj", tag: "»", text: `verify ${known ? `${known.sym} · ${known.name} · ` : ""}${shortKey(mint.toBase58(), 4)}` });
      // A launch the site hides (the Noised name on a mint that is not the team's, or the hidden list): said first.
      const flag = await mintBrandFlag(connection, mint).catch(() => null);
      if (flag !== null) {
        push({
          tone: "fail",
          tag: "[×]",
          text: flag.reason === "impersonation" ? `Not affiliated with Noised: this token uses the Noised name but wasn't launched by the Noised team. The official ${OFFICIAL_NOISED.label} is ${OFFICIAL_NOISED.mint}.` : "Hidden on Noised: this token was reported to the Noised team.",
        });
      }
      push({ tone: "dim", tag: ">", text: "reading mint, certificate, curve, guard policy…" });
      try {
        const report = await verifyCached(connection, mint);
        const passed = report.checks.filter((c) => c.status === "pass").length;
        const checkLine = (c: VerificationReport["checks"][number]): LineInput => {
          // Same short wording as the home page's verify terminal; the full sentence is the line's title.
          const [label, value] = shortCheck(c, report.phase);
          return {
            tone: c.status === "pass" ? "ok" : c.status,
            tag: c.status === "pass" ? "[✓]" : c.status === "warn" ? "[!]" : "[×]",
            text: label,
            val: value,
            title: c.detail ? `${c.label}: ${c.detail}` : c.label,
          };
        };
        // Post-quantum origin last, as in the home page's verify terminal: the launch's LMS attestation (reported by
        // protocol v2 verifiers); a certified launch without one says so instead of staying silent.
        const pqChecks = report.checks.filter(isPqCheck);
        const pq = pqOrigin(report);
        const pqLines: LineInput[] =
          report.certificate === null && pqChecks.length === 0
            ? []
            : [
                { tone: "dim", tag: ">", text: "post-quantum origin" },
                ...(pqChecks.length > 0
                  ? [
                      ...pqChecks.map(checkLine),
                      ...(pq?.leaf && pq.status === "pass"
                        ? [{ tone: "ok", tag: "[✓]", text: "lms leaf (one use, ever)", val: pq.leaf.padStart(4, "0") } satisfies LineInput]
                        : []),
                    ]
                  : [{ tone: "dim", tag: "[·]", text: "lms attestation", val: "none · pre-v2 launch", title: PQ_PENDING } satisfies LineInput]),
              ];
        push(
          ...report.checks.filter((c) => !isPqCheck(c)).map(checkLine),
          ...pqLines,
          {
            tone: report.overall === "pass" ? "ok" : report.overall,
            tag: report.overall === "pass" ? "[OK]" : report.overall === "warn" ? "[!]" : "[×]",
            text: `RESULT ${report.overall.toUpperCase()} · ${passed}/${report.checks.length} checks passed`,
            action: { label: "open token page ↗", run: () => go(`/token/${mint.toBase58()}`, "token page") },
          },
        );
        sfx.play(report.overall === "fail" ? "error" : "success");
      } catch (e) {
        push({ tone: "fail", tag: "[×]", text: `verification unavailable: ${errorMessage(e)}` });
        sfx.play("error");
      }
    },
    [connection, findLaunch, go, push, tokens],
  );

  const runOpen = useCallback(
    async (arg: string) => {
      const a = arg.trim();
      if (a === "") {
        const all = await listListedLaunches(connection);
        const now = Math.floor(Date.now() / 1000);
        if (all.length === 0) push({ tone: "dim", tag: ">", text: "no launches yet" });
        push(
          ...all.slice(0, 12).map<LineInput>((l) => ({
            tone: "dim",
            tag: "·",
            text: `${(l.market?.symbol ?? "PENDING").padEnd(6, " ")} ${l.market?.name ?? "Configured launch"}`,
            val: launchPhase(l, unixSecs(now)),
            action: { label: "open ↗", run: () => go(tokenRoute(l), l.market?.symbol ?? "launch") },
          })),
        );
        return;
      }
      const mint = isAddress(a);
      if (mint) {
        go(`/token/${mint.toBase58()}`, shortKey(mint.toBase58(), 4));
        return;
      }
      const l = await findLaunch(a);
      if (!l) {
        push({ tone: "fail", tag: "[×]", text: `no launch named "${a}". Try: open (lists launches)` });
        sfx.play("error");
        return;
      }
      go(tokenRoute(l), l.market?.symbol ?? "launch");
    },
    [connection, findLaunch, go, push],
  );

  const runDocs = useCallback(
    async (arg: string) => {
      const q = arg.trim();
      if (q === "") {
        go("/docs", "docs");
        return;
      }
      const mod = docs ?? (await import("../content/docs/search"));
      const hits = mod.searchDocs(q, 8);
      if (hits.length === 0) {
        push({ tone: "warn", tag: "[!]", text: `nothing in the docs matches "${q}"` });
        return;
      }
      push(
        ...hits.map<LineInput>((h) => ({
          tone: "dim",
          tag: "·",
          text: h.title,
          val: h.where,
          action: { label: "open ↗", run: () => go(h.path, h.title) },
        })),
      );
    },
    [docs, go, push],
  );

  // The docs index: loaded the first time the palette opens (its own chunk).
  useEffect(() => {
    if (!open || docs !== null) return;
    let cancelled = false;
    import("../content/docs/search").then(
      (m) => {
        if (!cancelled) setDocs(m);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [open, docs]);

  const docCommands = useCallback(
    (query: string, limit: number): Command[] =>
      docs
        ? docs.searchDocs(query, limit).map((h) => ({
            id: `doc:${h.path}`,
            name: h.title,
            desc: h.where,
            group: "DOCS" as const,
            run: () => go(h.path, h.title),
          }))
        : [],
    [docs, go],
  );

  const commands = useMemo<Command[]>(
    () => [
      { name: "verify", arg: "<mint | symbol>", desc: "re-check a launch's guarantees on chain", group: "INSPECT", run: runVerify },
      { name: "open", arg: "<token>", desc: "go to a token page (no argument: list launches)", group: "INSPECT", run: runOpen },
      { name: "launchpad", desc: "the launch board", group: "NAVIGATE", run: () => go("/", "launchpad") },
      { name: "launch", desc: "create a token: fair launch wizard", group: "NAVIGATE", run: () => go("/create", "launch wizard") },
      { name: "vault", desc: "post-quantum vault", group: "NAVIGATE", run: () => go("/vault", "PQ vault") },
      { name: "shield", desc: "private balances", group: "NAVIGATE", run: () => go("/shield", "shield") },
      { name: "check", desc: "verify any token against the QSL-1 standard", group: "NAVIGATE", run: () => go("/verify", "verify") },
      { name: "security", desc: "program IDs, CSP, trust assumptions", group: "NAVIGATE", run: () => go("/security", "security") },
      { name: "docs", arg: "<topic>", desc: "developer docs: SDK, programs, guides (with a topic: search them)", group: "NAVIGATE", run: (a) => runDocs(a) },
      { name: "whitepaper", desc: "the Noised whitepaper", group: "NAVIGATE", run: () => go("/whitepaper", "whitepaper") },
      {
        name: "sound",
        arg: "on|off",
        desc: `interface sound (now ${sound.muted ? "off" : "on"})`,
        group: "SYSTEM",
        run: (a) => {
          const v = a.trim().toLowerCase();
          const mute = v === "off" ? true : v === "on" ? false : !sound.muted;
          sound.setMuted(mute);
          push({ tone: "ok", tag: "[OK]", text: `sound ${mute ? "off" : "on"}` });
        },
      },
      {
        name: "theme",
        arg: "graphite|paper|dark|light",
        desc: `theme (now ${PALETTE_META[palette].label}; no argument = switch)`,
        group: "SYSTEM",
        run: (a) => {
          const v = a.trim().toLowerCase();
          let next: Palette;
          if (isPalette(v)) {
            next = v;
            setPalette(v);
          } else if (v === "dark") {
            setTheme("dark");
            next = "graphite";
          } else if (v === "light") {
            setTheme("light");
            next = "paper";
          } else if (v === "") {
            next = cyclePalette();
          } else {
            push({ tone: "warn", tag: "[!]", text: `unknown theme "${v}". Try: theme graphite | paper` });
            return;
          }
          sfx.play("toggle");
          push({ tone: "ok", tag: "[OK]", text: `theme ${PALETTE_META[next].label} · ${PALETTE_META[next].note}` });
        },
      },
      {
        name: "motion",
        arg: "on|off",
        desc: motion.reduced ? "ambient motion (off: reduced motion)" : `ambient motion (now ${motion.paused ? "off" : "on"})`,
        group: "SYSTEM",
        run: (a) => {
          if (motion.reduced) {
            push({ tone: "warn", tag: "[!]", text: "your system asks for reduced motion: ambient motion stays off" });
            return;
          }
          const v = a.trim().toLowerCase();
          const pause = v === "off" ? true : v === "on" ? false : !motion.paused;
          motion.setPaused(pause);
          push({ tone: "ok", tag: "[OK]", text: `ambient motion ${pause ? "off" : "on"}` });
        },
      },
      {
        name: "help",
        desc: "list commands",
        group: "SYSTEM",
        run: () =>
          push(
            { tone: "dim", tag: "#", text: `NOISED terminal · ${ADAPTER_MODE === "mock" ? "simulated chain (demo)" : "live chain"} · read-only commands` },
            ...[
              ["verify <mint|symbol>", "re-check a launch on chain"],
              ["open <token>", "go to a token page"],
              ["launch · vault · privacy · security · launchpad · whitepaper", "navigate"],
              ["docs <topic>", "search the developer docs"],
              ["sound on|off · theme graphite|paper · motion on|off", "preferences"],
              ["clear", "clear the screen"],
            ].map<LineInput>(([c, d]) => ({ tone: "dim", tag: " ", text: c ?? "", val: d ?? "" })),
          ),
      },
      { name: "clear", desc: "clear the screen", group: "SYSTEM", run: () => setLines([]) },
    ],
    [runVerify, runOpen, runDocs, go, sound, palette, setPalette, cyclePalette, setTheme, motion, push],
  );

  // Launches for the TOKENS suggestions (read once per page load, when the palette first opens).
  useEffect(() => {
    if (!open || tokens !== null) return;
    let cancelled = false;
    const now = Math.floor(Date.now() / 1000);
    listListedLaunches(connection).then(
      (all) => {
        if (cancelled) return;
        setTokens(
          all
            .filter((l) => l.market?.symbol)
            .slice(0, 12)
            .map((l) => ({ sym: l.market?.symbol ?? "", name: l.market?.name ?? "", route: tokenRoute(l), live: l.status === "live", phase: launchPhase(l, unixSecs(now)) })),
        );
      },
      () => {
        if (!cancelled) setTokens([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, tokens, connection]);

  const tokenCommands = useCallback(
    (verb: "open" | "verify"): Command[] =>
      (tokens ?? [])
        .filter((t) => verb === "open" || t.live)
        .map((t) => ({
          name: `${verb} ${t.sym}`,
          desc: `${t.name} · ${t.phase}`,
          group: "TOKENS" as const,
          run: verb === "open" ? () => go(t.route, t.sym) : () => runVerify(t.sym),
        })),
    [tokens, go, runVerify],
  );

  // What the list shows for the current input.
  const head = (input.trimStart().split(/\s+/)[0] ?? "").toLowerCase();
  const hasArg = input.trimStart().includes(" ");
  const directAddress = isAddress(input);
  const matches = useMemo(() => {
    if (directAddress) {
      return commands.filter((c) => c.name === "verify" || c.name === "open");
    }
    if (hasArg) {
      const base = commands.find((c) => c.name === head);
      const arg = input.trimStart().slice(head.length).trim();
      if (head === "theme" && base) {
        const subs: Command[] = PALETTES.map((p) => ({
          name: `theme ${p}`,
          desc: `${PALETTE_META[p].note}${p === palette ? " · current" : ""}`,
          group: "SYSTEM" as const,
          run: () => base.run(p),
        }));
        return [base, ...subs.filter((c) => arg === "" || fuzzy(arg, c.name.slice(6)) >= 0)];
      }
      if (head === "docs") {
        const sugg = arg === "" ? [] : docCommands(arg, 8);
        return base ? [base, ...sugg] : sugg;
      }
      if (head === "open" || head === "verify") {
        const sugg = tokenCommands(head)
          .map((c) => ({ c, s: fuzzy(arg, c.name.slice(head.length + 1)) }))
          .filter((x) => arg === "" || x.s >= 0)
          .sort((a, b) => b.s - a.s)
          .map((x) => x.c)
          .slice(0, 6);
        return base ? [base, ...sugg] : sugg;
      }
      return base ? [base] : docCommands(input.trim(), 8);
    }
    const pool = [...commands, ...(head === "" ? tokenCommands("open").slice(0, 5) : tokenCommands("open"))];
    const ranked = pool
      .map((c) => ({ c, s: Math.max(fuzzy(head, c.name), fuzzy(head, c.desc) - 20) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
    // Docs results for anything typed (two characters or more).
    return head.length >= 2 ? [...ranked, ...docCommands(input.trim(), 6)] : ranked;
  }, [commands, tokenCommands, docCommands, head, hasArg, directAddress, input, palette]);

  useEffect(() => setSel(0), [input]);

  const execute = useCallback(
    async (text: string, cmd?: Command) => {
      const raw = text.trim();
      const addr = isAddress(raw);
      const [name = "", ...rest] = raw.split(/\s+/);
      const command = cmd ?? commands.find((c) => c.name === name.toLowerCase());
      const arg = addr ? raw : rest.join(" ");
      const resolved = command ?? (addr ? commands.find((c) => c.name === "verify") : undefined);
      // Suggestions ("open AEGS", "theme paper") already carry their argument in the name.
      const echo = resolved ? (resolved.name.includes(" ") ? resolved.name : `${resolved.name}${arg ? ` ${arg}` : ""}`) : raw;
      push({ tone: "cmd", tag: "$", text: `noised ${echo}` });
      setInput("");
      if (!resolved) {
        push({ tone: "fail", tag: "[×]", text: `unknown command "${name}". Type help.` });
        sfx.play("error");
        return;
      }
      sfx.play("click");
      setBusy(true);
      try {
        await resolved.run(arg);
      } finally {
        setBusy(false);
      }
    },
    [commands, push],
  );

  // Global shortcuts + programmatic open.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      const typing = !!target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable);
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey) && !e.altKey) {
        e.preventDefault();
        setOpen((o) => !o);
        return;
      }
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === "?" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && !document.querySelector("dialog[open]")) {
        e.preventDefault();
        setOpen(true);
        setTimeout(() => void execute("help"), 60);
      }
    };
    const onOpen = (e: Event): void => {
      const detail = (e as CustomEvent<{ initial?: string; run?: boolean }>).detail ?? {};
      setOpen(true);
      if (detail.run && detail.initial) {
        setTimeout(() => void execute(detail.initial ?? ""), 60);
      } else {
        setInput(detail.initial ?? "");
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, [execute]);

  // Sync the native dialog with `open`.
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      sfx.play("open");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    if (!open && d.open) d.close();
  }, [open]);

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => (matches.length === 0 ? 0 : (s + 1) % matches.length));
      sfx.play("key");
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => (matches.length === 0 ? 0 : (s - 1 + matches.length) % matches.length));
      sfx.play("key");
    } else if (e.key === "Tab") {
      const m = matches[sel];
      if (m && !hasArg) {
        e.preventDefault();
        setInput(`${m.name}${m.arg ? " " : ""}`);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (busy) return;
      const m = matches[sel];
      if (directAddress) {
        void execute(input, m);
      } else if (m && (m.group === "TOKENS" || m.group === "DOCS" || m.name.startsWith("theme "))) {
        void execute(m.name, m);
      } else if (hasArg || (m && m.name === head)) {
        void execute(input);
      } else if (m) {
        if (m.arg && !m.name.startsWith("theme") && !m.name.startsWith("sound") && !m.name.startsWith("motion") && m.name !== "open") {
          setInput(`${m.name} `);
        } else {
          void execute(m.name, m);
        }
      } else if (input.trim() !== "") {
        void execute(input);
      }
    }
  };

  const groups = (["INSPECT", "TOKENS", "DOCS", "NAVIGATE", "SYSTEM"] as const)
    .map((g) => ({ g, items: matches.filter((m) => m.group === g) }))
    .filter((x) => x.items.length > 0);
  // Once there is output, the command list only shows while typing (output stays in view).
  const showList = input.trim() !== "" || lines.length === 0;
  const flat = showList ? groups.flatMap((x) => x.items) : [];
  const activeId = flat[sel] ? `${listId}-${cmdDomId(flat[sel])}` : undefined;

  return (
    <dialog
      ref={ref}
      className="phx-palette"
      aria-label="Command palette"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClose={() => setOpen(false)}
      onClick={(e) => {
        if (e.target === ref.current) close();
      }}
    >
      <div className="phx-pal">
        <div className="phx-pal-bar" aria-hidden="true">
          <span>Search tokens, pages, docs and settings</span>
          <span>{ADAPTER_MODE === "mock" ? "Demo mode" : "Read-only"}</span>
        </div>
        <div className="phx-pal-input">
          <Search className="phx-pal-prompt" aria-hidden="true" />
          <div className="phx-pal-field">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                sfx.play("key");
              }}
              onKeyDown={onInputKey}
              placeholder="Type a command, a symbol or a docs topic, or paste a token address…"
              aria-label="Command"
              role="combobox"
              aria-expanded={flat.length > 0}
              aria-controls={listId}
              aria-activedescendant={activeId}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {busy ? <span className="spinner text-signal" aria-label="Working" /> : null}
        </div>
        <div className="phx-pal-body" ref={bodyRef}>
          {lines.length > 0 ? (
            <div className="phx-pal-out" role="log" aria-live="polite">
              {lines.slice(0, shown).map((l) => (
                <div key={l.id} className="phx-pal-line" data-tone={l.tone} title={l.title}>
                  <span className="t">{l.tag}</span>
                  {l.val !== undefined ? (
                    <>
                      <span className="lead">
                        <Typewriter text={l.text} speed={6} />
                      </span>
                      <span className="dots" aria-hidden="true" />
                      <span className="val">{l.val}</span>
                    </>
                  ) : (
                    <span className="min-w-0 flex-1">
                      <Typewriter text={l.text} speed={6} />
                    </span>
                  )}
                  {l.action ? (
                    <button type="button" className="btn btn-ghost btn-sm ml-2 !min-h-[24px] !px-2" onClick={l.action.run}>
                      {l.action.label}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          <div id={listId} role="listbox" aria-label="Commands" hidden={!showList}>
            {(showList ? groups : []).map(({ g, items }) => (
              <div key={g} role="group" aria-label={g}>
                <div className="phx-pal-group" aria-hidden="true">
                  {GROUP_LABEL[g]}
                </div>
                {items.map((m) => {
                  const i = flat.indexOf(m);
                  return (
                    <div
                      key={cmdKey(m)}
                      id={`${listId}-${cmdDomId(m)}`}
                      role="option"
                      aria-selected={i === sel}
                      className="phx-pal-item"
                      onPointerMove={() => setSel(i)}
                      onClick={() => {
                        if (directAddress) void execute(input, m);
                        else if (m.arg && m.name !== "open" && m.group !== "SYSTEM") {
                          setInput(`${m.name} `);
                          inputRef.current?.focus();
                        } else void execute(m.name, m);
                      }}
                    >
                      <span className="glyph" aria-hidden="true">
                        {i === sel ? "›" : "·"}
                      </span>
                      <span className="cmd">{m.name}</span>
                      {m.arg ? <span className="arg">{m.arg}</span> : null}
                      <span className="desc">{m.desc}</span>
                    </div>
                  );
                })}
              </div>
            ))}
            {showList && flat.length === 0 ? <div className="phx-pal-group">no matching command · Enter runs it anyway</div> : null}
          </div>
        </div>
        <div className="phx-pal-foot" aria-hidden="true">
          <span>
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd>select
          </span>
          <span>
            <kbd className="kbd">↵</kbd>run
          </span>
          <span>
            <kbd className="kbd">tab</kbd>complete
          </span>
          <span className="grow" />
          <span>
            <kbd className="kbd">esc</kbd>close
          </span>
        </div>
      </div>
    </dialog>
  );
}
