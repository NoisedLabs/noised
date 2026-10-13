/**
 * "Draw a pixel icon" (PIXEL_V6 §4): a tiny 32x32 pixel editor with up to 16
 * colours, a generator, and crisp previews. An uploaded picture never comes
 * here: it is stored as a smooth logo (LogoUpload.tsx, ./logoIcon.ts).
 *
 * Presentation and draft state only: the icon lives in the wizard's draft
 * (pixelIcon.ts); nothing here touches the chain. Canvas drawing only (no
 * markup injection).
 */
import { Dices, Eraser, FlipHorizontal2, Grid3x3, PaintBucket, Pencil, Pipette, Redo2, Trash2, Undo2 } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { sfx } from "../../fx/sfx";
import {
  charOf,
  EMPTY,
  fillCells,
  filledCount,
  generateIcon,
  ICON_MAX_COLORS,
  ICON_SIZE,
  indexOf,
  isBlank,
  lineCells,
  mainSlot,
  normalizeHex,
  seedOf,
  setPixels,
  slotOf,
  usedSlots,
  withMirror,
  type IconDraft,
} from "./pixelIcon";
import type { StoredIcon } from "./draft";
import { LogoImage } from "./LogoImage";

type Tool = "draw" | "erase" | "fill" | "pick";

const TOOLS: { id: Tool; label: string; key: string; icon: ReactNode }[] = [
  { id: "draw", label: "Draw", key: "B", icon: <Pencil aria-hidden="true" /> },
  { id: "erase", label: "Erase", key: "E", icon: <Eraser aria-hidden="true" /> },
  { id: "fill", label: "Fill", key: "G", icon: <PaintBucket aria-hidden="true" /> },
  { id: "pick", label: "Pick a colour", key: "I", icon: <Pipette aria-hidden="true" /> },
];

const HISTORY = 64;

// ---------------------------------------------------------------- drawing ---

interface Look {
  checkA: string;
  checkB: string;
  grid: string;
  axis: string;
  cursor: string;
  cursorIn: string;
}

function readLook(el: Element): Look {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback;
  return {
    checkA: v("--ie-check-a", "#141416"),
    checkB: v("--ie-check-b", "#1b1b1e"),
    grid: v("--ie-grid", "rgba(255,255,255,0.07)"),
    axis: v("--ie-axis", "rgba(255,255,255,0.28)"),
    cursor: v("--ie-cursor", "#ffffff"),
    cursorIn: v("--ie-cursor-in", "#000000"),
  };
}

/** Paints the icon at an integer scale (one icon pixel = `k` canvas pixels), with no smoothing. */
export function paintIcon(ctx: CanvasRenderingContext2D, icon: IconDraft, k: number, background: "clear" | "check", look?: Look): void {
  const W = ICON_SIZE * k;
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, W, W);
  if (background === "check" && look) {
    // Two-tone checks of 2x2 icon pixels mark "empty".
    for (let y = 0; y < ICON_SIZE; y += 2) {
      for (let x = 0; x < ICON_SIZE; x += 2) {
        ctx.fillStyle = ((x + y) / 2) % 2 === 0 ? look.checkA : look.checkB;
        ctx.fillRect(x * k, y * k, 2 * k, 2 * k);
      }
    }
  }
  const px = icon.pixels;
  for (let i = 0; i < px.length; i++) {
    const s = slotOf(px[i]);
    if (s < 0) continue;
    ctx.fillStyle = icon.palette[s] ?? "#000000";
    ctx.fillRect((i % ICON_SIZE) * k, Math.floor(i / ICON_SIZE) * k, k, k);
  }
}

/** Integer pixels per icon pixel for a CSS size on this screen (at least 1). */
function scaleFor(cssSize: number): number {
  const dpr = typeof window === "undefined" ? 1 : Math.min(3, window.devicePixelRatio || 1);
  return Math.max(1, Math.round((cssSize * dpr) / ICON_SIZE));
}

/** The theme's colours change with html[data-theme]: redraw when it flips. */
function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const mo = new MutationObserver(() => setTick((t) => t + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return tick;
}

/** A token icon drawn crisp at `size` CSS pixels (use multiples of 32). Decorative unless `label` is given. */
export function IconCanvas({ icon, size, className = "", label }: { icon: IconDraft; size: number; className?: string | undefined; label?: string | undefined }): ReactNode {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const k = scaleFor(size);
    if (c.width !== ICON_SIZE * k) {
      c.width = ICON_SIZE * k;
      c.height = ICON_SIZE * k;
    }
    const ctx = c.getContext("2d");
    if (ctx) paintIcon(ctx, icon, k, "clear");
  }, [icon, size]);
  return (
    <canvas
      ref={ref}
      className={`ie-canvas ${className}`}
      style={{ width: size, height: size } as CSSProperties}
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
    />
  );
}

// ----------------------------------------------------------------- editor ---

/**
 * The 32x32 editor: tools, mirror, undo, the 16-colour palette (each slot
 * editable), "make one for me", and previews at real sizes.
 * Keyboard: arrows move the cursor (Shift: 4 at a time), Space draws, Delete
 * erases, B / E / G / I pick a tool, M mirrors, Ctrl+Z / Ctrl+Y undo / redo.
 */
export function PixelIconEditor({ icon, onChange, name, symbol }: { icon: IconDraft; onChange: (next: IconDraft) => void; name: string; symbol: string }): ReactNode {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [tool, setTool] = useState<Tool>("draw");
  const [slot, setSlot] = useState(() => mainSlot(icon));
  const [mirror, setMirror] = useState(true);
  const [grid, setGrid] = useState(true);
  const [cursor, setCursor] = useState<{ x: number; y: number }>({ x: 15, y: 15 });
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [announce, setAnnounce] = useState("");
  const generated = useRef(0);

  // The working copy: a stroke paints here and reaches the draft when it ends.
  const [work, setWork] = useState<IconDraft>(icon);
  const workRef = useRef<IconDraft>(icon);
  const put = (next: IconDraft): void => {
    workRef.current = next;
    setWork(next);
  };
  const stroke = useRef<{ last: number; erase: boolean; pointer: number } | null>(null);
  useEffect(() => {
    if (stroke.current !== null || workRef.current === icon) return;
    workRef.current = icon;
    setWork(icon);
  }, [icon]);

  const past = useRef<IconDraft[]>([]);
  const future = useRef<IconDraft[]>([]);
  const [, setHistoryTick] = useState(0);
  const remember = (before: IconDraft): void => {
    past.current.push(before);
    if (past.current.length > HISTORY) past.current.shift();
    future.current = [];
    setHistoryTick((t) => t + 1);
  };
  const commit = (next: IconDraft, before: IconDraft = icon): void => {
    if (next.pixels === before.pixels && next.palette.join() === before.palette.join()) return;
    remember(before);
    put(next);
    onChange(next);
  };
  const undo = (): void => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(workRef.current);
    setHistoryTick((t) => t + 1);
    put(prev);
    onChange(prev);
    sfx.play("click");
  };
  const redo = (): void => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(workRef.current);
    setHistoryTick((t) => t + 1);
    put(next);
    onChange(next);
    sfx.play("click");
  };

  // ------------------------------------------------------------- canvas ---
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [cssSize, setCssSize] = useState(384);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setCssSize(Math.max(ICON_SIZE, Math.floor(el.getBoundingClientRect().width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const theme = useThemeTick();

  useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const k = Math.min(24, scaleFor(cssSize));
    const W = ICON_SIZE * k;
    if (c.width !== W) {
      c.width = W;
      c.height = W;
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const look = readLook(c);
    paintIcon(ctx, work, k, "check", look);
    if (grid && k >= 6) {
      ctx.fillStyle = look.grid;
      for (let i = 1; i < ICON_SIZE; i++) {
        ctx.fillRect(i * k, 0, 1, W);
        ctx.fillRect(0, i * k, W, 1);
      }
    }
    if (mirror) {
      // The mirror axis: a dim dashed line (only while mirror is on), so it never reads as part of the drawing.
      ctx.fillStyle = look.axis;
      ctx.globalAlpha = 0.4;
      const dash = Math.max(2, Math.round(k / 2));
      for (let y = 0; y < W; y += dash * 2) ctx.fillRect((ICON_SIZE / 2) * k - 1, y, 2, dash);
      ctx.globalAlpha = 1;
    }
    const box = (i: number, outer: string, inner: string): void => {
      const x = (i % ICON_SIZE) * k;
      const y = Math.floor(i / ICON_SIZE) * k;
      ctx.lineWidth = Math.max(1, Math.round(k / 8));
      ctx.strokeStyle = inner;
      ctx.strokeRect(x + ctx.lineWidth * 1.5, y + ctx.lineWidth * 1.5, k - ctx.lineWidth * 3, k - ctx.lineWidth * 3);
      ctx.strokeStyle = outer;
      ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, k - ctx.lineWidth, k - ctx.lineWidth);
    };
    if (hover !== null && stroke.current === null) box(hover, look.cursor, look.cursorIn);
    if (focused) box(indexOf(cursor.x, cursor.y), look.cursor, look.cursorIn);
  }, [work, cssSize, grid, mirror, hover, focused, cursor, theme]);

  const cellAt = (e: PointerEvent<HTMLCanvasElement>): { x: number; y: number; i: number } | null => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * ICON_SIZE);
    const y = Math.floor(((e.clientY - r.top) / r.height) * ICON_SIZE);
    const i = indexOf(x, y);
    return i < 0 ? null : { x, y, i };
  };

  const paintCells = (base: IconDraft, cells: readonly number[], erase: boolean): IconDraft => {
    const pixels = setPixels(base.pixels, withMirror(cells, mirror), erase ? EMPTY : charOf(slot));
    return pixels === base.pixels ? base : { palette: base.palette, pixels };
  };

  /** One click / key press of the current tool at a cell. Returns the new icon (or the same one). */
  const applyAt = (base: IconDraft, x: number, y: number, t: Tool, erase = false): IconDraft => {
    const i = indexOf(x, y);
    if (i < 0) return base;
    if (t === "pick") {
      const s = slotOf(base.pixels[i]);
      if (s >= 0) {
        setSlot(s);
        setTool("draw");
        setAnnounce(`Picked colour ${s + 1}, ${base.palette[s] ?? ""}. Back to drawing.`);
      } else setAnnounce("That pixel is empty.");
      return base;
    }
    if (t === "fill") {
      const cells = fillCells(base.pixels, x, y);
      return paintCells(base, mirror ? [...cells, ...fillCells(base.pixels, ICON_SIZE - 1 - x, y)] : cells, erase);
    }
    return paintCells(base, [i], erase || t === "erase");
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>): void => {
    if (e.button !== 0 && e.button !== 2) return;
    const cell = cellAt(e);
    if (!cell) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    setCursor({ x: cell.x, y: cell.y });
    const erase = e.button === 2;
    if (tool === "fill" || tool === "pick") {
      const next = applyAt(work, cell.x, cell.y, tool, erase);
      if (next !== work) {
        commit(next, work);
        sfx.play("click");
      }
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    stroke.current = { last: cell.i, erase: erase || tool === "erase", pointer: e.pointerId };
    remember(work);
    put(paintCells(workRef.current, [cell.i], erase || tool === "erase"));
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>): void => {
    const cell = cellAt(e);
    const s = stroke.current;
    if (s === null || s.pointer !== e.pointerId) {
      setHover(cell ? cell.i : null);
      return;
    }
    if (!cell || cell.i === s.last) return;
    const from = s.last;
    s.last = cell.i;
    put(paintCells(workRef.current, lineCells(from % ICON_SIZE, Math.floor(from / ICON_SIZE), cell.x, cell.y), s.erase));
  };
  const endStroke = (e: PointerEvent<HTMLCanvasElement>): void => {
    const s = stroke.current;
    if (s === null || s.pointer !== e.pointerId) return;
    stroke.current = null;
    // The finished stroke reaches the draft (one undo step).
    onChange(workRef.current);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLCanvasElement>): void => {
    const step = e.shiftKey ? 4 : 1;
    const move = (dx: number, dy: number): void => {
      e.preventDefault();
      const x = Math.max(0, Math.min(ICON_SIZE - 1, cursor.x + dx));
      const y = Math.max(0, Math.min(ICON_SIZE - 1, cursor.y + dy));
      setCursor({ x, y });
      const s = slotOf(work.pixels[indexOf(x, y)]);
      setAnnounce(`Row ${y + 1}, column ${x + 1}: ${s < 0 ? "empty" : `colour ${s + 1}`}`);
    };
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "z" || e.key === "Z")) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && (e.key === "y" || e.key === "Y")) {
      e.preventDefault();
      redo();
      return;
    }
    if (mod || e.altKey) return;
    switch (e.key) {
      case "ArrowLeft":
        return move(-step, 0);
      case "ArrowRight":
        return move(step, 0);
      case "ArrowUp":
        return move(0, -step);
      case "ArrowDown":
        return move(0, step);
      case " ":
      case "Enter": {
        e.preventDefault();
        const next = applyAt(work, cursor.x, cursor.y, tool);
        if (next !== work) {
          commit(next, work);
          setAnnounce(`${tool === "erase" ? "Erased" : tool === "fill" ? "Filled" : "Drew"} at row ${cursor.y + 1}, column ${cursor.x + 1}`);
        }
        return;
      }
      case "Delete":
      case "Backspace": {
        e.preventDefault();
        const next = applyAt(work, cursor.x, cursor.y, "erase");
        if (next !== work) commit(next, work);
        setAnnounce(`Erased at row ${cursor.y + 1}, column ${cursor.x + 1}`);
        return;
      }
      default: {
        const t = TOOLS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
        if (t) {
          e.preventDefault();
          setTool(t.id);
          setAnnounce(`${t.label} tool`);
        } else if (e.key === "m" || e.key === "M") {
          e.preventDefault();
          setMirror((m) => !m);
          setAnnounce(mirror ? "Mirror off" : "Mirror on");
        } else if (e.key === "[" || e.key === "]") {
          e.preventDefault();
          const s = (slot + (e.key === "]" ? 1 : ICON_MAX_COLORS - 1)) % Math.max(1, work.palette.length);
          setSlot(s);
          setAnnounce(`Colour ${s + 1}, ${work.palette[s] ?? ""}`);
        }
      }
    }
  };

  // ------------------------------------------------------------- actions ---
  const generate = (): void => {
    generated.current += 1;
    // icon seed kept from the original name: changing it changes the generated icons
    const seed = seedOf(`${symbol.trim() || name.trim() || "phalanx"}#${generated.current}`);
    const next = generateIcon(seed, work.palette.length === ICON_MAX_COLORS ? work.palette : undefined);
    commit(next, work);
    setSlot(mainSlot(next));
    sfx.play("toggle");
    setAnnounce("Made a new icon.");
  };
  const clear = (): void => {
    if (isBlank(work.pixels)) return;
    commit({ palette: work.palette, pixels: EMPTY.repeat(ICON_SIZE * ICON_SIZE) }, work);
    sfx.play("click");
    setAnnounce("Cleared.");
  };
  // A whole colour-picker session is one undo step.
  const colourSession = useRef(false);
  const setColour = (hex: string): void => {
    const c = normalizeHex(hex);
    if (c === null) return;
    const before = workRef.current;
    const palette = [...before.palette];
    while (palette.length <= slot) palette.push("#000000");
    if (palette[slot] === c) return;
    palette[slot] = c;
    if (colourSession.current) {
      colourSession.current = false;
      remember(before);
    }
    const next = { palette, pixels: before.pixels };
    put(next);
    onChange(next);
  };

  const used = usedSlots(work.pixels);
  const filled = filledCount(work.pixels);
  const current = work.palette[slot] ?? "#000000";

  return (
    <div className="ie-editor">
      <div className="ie-tools" role="toolbar" aria-label="Icon tools" aria-controls={`${uid}-canvas`}>
        <div className="ie-tool-group" role="group" aria-label="Tool">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="ie-tool"
              aria-pressed={tool === t.id}
              title={`${t.label} (${t.key})`}
              onClick={() => {
                if (tool !== t.id) sfx.play("toggle");
                setTool(t.id);
              }}
            >
              {t.icon}
              <span className="ie-tool-t">{t.label}</span>
            </button>
          ))}
        </div>
        <span className="ie-tool-sep" aria-hidden="true" />
        <div className="ie-tool-group" role="group" aria-label="Options">
          <button type="button" className="ie-tool" aria-pressed={mirror} title="Mirror left and right (M)" onClick={() => setMirror((m) => !m)}>
            <FlipHorizontal2 aria-hidden="true" />
            <span className="ie-tool-t">Mirror</span>
          </button>
          <button type="button" className="ie-tool" aria-pressed={grid} title="Show the grid" onClick={() => setGrid((g) => !g)}>
            <Grid3x3 aria-hidden="true" />
            <span className="ie-tool-t">Grid</span>
          </button>
        </div>
        <span className="ie-tool-sep" aria-hidden="true" />
        <div className="ie-tool-group" role="group" aria-label="History">
          <button type="button" className="ie-tool" title="Undo (Ctrl+Z)" disabled={past.current.length === 0} onClick={undo}>
            <Undo2 aria-hidden="true" />
            <span className="ie-tool-t">Undo</span>
          </button>
          <button type="button" className="ie-tool" title="Redo (Ctrl+Y)" disabled={future.current.length === 0} onClick={redo}>
            <Redo2 aria-hidden="true" />
            <span className="ie-tool-t">Redo</span>
          </button>
          <button type="button" className="ie-tool" title="Clear every pixel" disabled={filled === 0} onClick={clear}>
            <Trash2 aria-hidden="true" />
            <span className="ie-tool-t">Clear</span>
          </button>
        </div>
      </div>

      <div className="ie-stage">
        <div className="ie-board" ref={boxRef}>
          <canvas
            ref={canvasRef}
            id={`${uid}-canvas`}
            className="ie-board-canvas"
            data-tool={tool}
            tabIndex={0}
            role="application"
            aria-roledescription="pixel editor"
            aria-label={`Token icon, 32 by 32 pixels, ${filled} drawn. ${TOOLS.find((t) => t.id === tool)?.label ?? ""} tool, colour ${slot + 1}.`}
            aria-describedby={`${uid}-keys`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            onPointerLeave={() => setHover(null)}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          />
        </div>
        <p className="sr-only" id={`${uid}-keys`}>
          Arrow keys move the cursor, Shift moves 4 pixels. Space draws with the current tool, Delete erases. B draw, E erase, G fill, I pick a colour, M mirror,
          square brackets change colour. Control Z undoes.
        </p>
        <p className="sr-only" role="status" aria-live="polite">
          {announce}
        </p>
      </div>

      <div className="ie-side">
        <fieldset className="ie-palette">
          <legend className="ie-label">Colours</legend>
          <div className="ie-swatches" role="radiogroup" aria-label="Colour">
            {Array.from({ length: ICON_MAX_COLORS }, (_, s) => {
              const c = work.palette[s] ?? "#000000";
              return (
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={slot === s}
                  aria-label={`Colour ${s + 1}, ${c}${used.includes(s) ? ", in use" : ""}`}
                  tabIndex={slot === s ? 0 : -1}
                  className="ie-swatch"
                  data-used={used.includes(s) ? "" : undefined}
                  style={{ "--sw": c } as CSSProperties}
                  onClick={() => {
                    setSlot(s);
                    if (tool === "erase" || tool === "pick") setTool("draw");
                    sfx.play("toggle");
                  }}
                  onKeyDown={(e) => {
                    const cols = 8;
                    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? cols : e.key === "ArrowUp" ? -cols : 0;
                    if (d === 0) return;
                    e.preventDefault();
                    const n = (s + d + ICON_MAX_COLORS) % ICON_MAX_COLORS;
                    setSlot(n);
                    const el = e.currentTarget.parentElement?.children[n];
                    if (el instanceof HTMLElement) el.focus();
                  }}
                />
              );
            })}
          </div>
          <label className="ie-colour">
            <span className="ie-colour-chip" style={{ "--sw": current } as CSSProperties} aria-hidden="true" />
            <span className="ie-colour-t">
              <span className="ie-colour-k">This colour</span>
            </span>
            <span className="ie-colour-edit">Change</span>
            <input
              type="color"
              className="ie-colour-input"
              value={normalizeHex(current) ?? "#000000"}
              onFocus={() => {
                colourSession.current = true;
              }}
              onChange={(e) => setColour(e.target.value)}
              aria-label={`Change colour ${slot + 1}`}
            />
          </label>
        </fieldset>

        <div className="ie-actions">
          <button type="button" className="btn btn-secondary btn-sm ie-action" onClick={generate}>
            <Dices aria-hidden="true" /> Make one for me
          </button>
        </div>
        <p className="ie-hint">Draw your own 32 x 32 pixel icon with up to 16 colours. To use a picture, upload it as your logo instead.</p>

        <div className="ie-previews" aria-label="Previews">
          <span className="ie-label">Preview</span>
          <div className="ie-preview-row">
            <span className="ie-tile" data-bg="dark">
              <IconCanvas icon={work} size={64} />
            </span>
            <span className="ie-tile" data-bg="light">
              <IconCanvas icon={work} size={64} />
            </span>
            <span className="ie-tile ie-tile-sm" data-bg="dark">
              <IconCanvas icon={work} size={32} />
            </span>
            <span className="ie-tile ie-tile-xs" data-bg="dark">
              <IconCanvas icon={work} size={16} />
            </span>
          </div>
          <IconCard icon={work} name={name} symbol={symbol} />
          <p className="ie-hint ie-num">
            {filled === 0 ? "No icon yet: your token shows its address pattern instead." : "Small enough to store on-chain ✓"}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * How the icon looks on a launch card: the pixel art `icon`, or with `stored` an uploaded logo exactly as it is stored
 * (smooth).
 */
export function IconCard({
  icon,
  stored,
  name,
  symbol,
  description,
}: {
  icon: IconDraft;
  stored?: StoredIcon | undefined;
  name: string;
  symbol: string;
  description?: string | undefined;
}): ReactNode {
  const logo = stored?.kind === "logo" ? stored.logo : null;
  const blank = logo === null && isBlank(icon.pixels);
  return (
    <div className="ie-card" aria-hidden="true">
      <span className="ie-card-icon" data-blank={blank ? "" : undefined}>
        {logo !== null ? <LogoImage icon={logo} size={48} /> : blank ? <span className="ie-card-none">?</span> : <IconCanvas icon={icon} size={48} />}
      </span>
      <span className="ie-card-text">
        <span className="ie-card-name">{name.trim() || "Your token"}</span>
        <span className="ie-card-sym">{symbol.trim() ? `$${symbol.trim()}` : "$SYMBOL"}</span>
        {description !== undefined && description.trim() !== "" ? <span className="ie-card-desc">{description.trim()}</span> : null}
      </span>
      <span className="ie-card-bar" />
    </div>
  );
}
