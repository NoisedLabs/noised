/**
 * Simple mode's controls (LAYER_V1 §B.2): a slider over fixed, safe stops with a live plain sentence under it, choice
 * cards and choice chips. They only pick values; ./simple.ts turns a pick into the draft's strings.
 *
 * The slider is a native range input (keyboard, screen readers and touch for free) over a pixel track: one square per
 * stop, lit up to the thumb. A value set under "Advanced" that is not a stop puts the thumb on the nearest stop and
 * says so, without changing the value until the slider is moved.
 */
import { useId, type CSSProperties, type ReactNode } from "react";

import { sfx } from "../../fx/sfx";

export function StopSlider({
  label,
  stops,
  index,
  exact,
  valueText,
  stopText,
  onIndex,
  ends,
  say,
}: {
  label: string;
  /** How many stops (the slider's positions 0..count-1). */
  stops: number;
  /** The stop the thumb sits on. */
  index: number;
  /** False when the draft's value is not this stop (set under Advanced). */
  exact: boolean;
  /** The current value in words, big ("85 SOL", "6 hours"). */
  valueText: string;
  /** A stop in words, for screen readers ("6 hours"). */
  stopText: (i: number) => string;
  onIndex: (i: number) => void;
  /** The ends of the scale ("1 minute", "30 minutes"). */
  ends: [string, string];
  /** The live consequence sentence, in plain words (omitted: a group shows one sentence for several sliders). */
  say?: string | undefined;
}): ReactNode {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const max = Math.max(1, stops - 1);
  const style = { ["--p" as string]: index / max } as CSSProperties;
  return (
    <div className="sl" data-exact={exact ? "" : undefined}>
      <div className="sl-head">
        <label className="sl-label" htmlFor={`sl-${id}`}>
          {label}
        </label>
        <span key={valueText} className="sl-value" aria-hidden="true">
          {valueText}
        </span>
      </div>
      <div className="sl-track" style={style}>
        <span className="sl-fill" aria-hidden="true" />
        {Array.from({ length: stops }, (_, i) => (
          <i key={i} className="sl-tick" data-on={i <= index ? "" : undefined} style={{ ["--t" as string]: i / max } as CSSProperties} aria-hidden="true" />
        ))}
        <input
          id={`sl-${id}`}
          className="sl-input"
          type="range"
          min={0}
          max={max}
          step={1}
          value={index}
          aria-valuetext={exact ? valueText : `${valueText} (set exactly under Advanced; the slider is at ${stopText(index)})`}
          aria-describedby={say === undefined ? undefined : `sl-${id}-say`}
          onChange={(e) => {
            const i = Number(e.target.value);
            if (i !== index || !exact) {
              sfx.play("key");
              onIndex(i);
            }
          }}
        />
      </div>
      <div className="sl-ends" aria-hidden="true">
        <span>{ends[0]}</span>
        <span>{ends[1]}</span>
      </div>
      {say !== undefined ? (
        <p id={`sl-${id}-say`} className="sl-say" aria-live="polite">
          <span className="sl-say-mark" aria-hidden="true" />
          <span key={say}>{say}</span>
        </p>
      ) : null}
      {!exact ? <p className="sl-custom">Set exactly under Advanced. Move the slider to pick a stop instead.</p> : null}
    </div>
  );
}

export interface Choice<T extends string> {
  id: T;
  title: string;
  summary: ReactNode;
  /** Small facts under the summary ("Max wallet 1%"). */
  facts?: readonly [string, string][];
}

/** Cards as a radio group (the presets' look). `value` null: none chosen (values set under Advanced). */
export function ChoiceCards<T extends string>({ label, choices, value, onPick, size = "md" }: { label: string; choices: readonly Choice<T>[]; value: T | null; onPick: (id: T) => void; size?: "md" | "sm" }): ReactNode {
  return (
    <div className="cr-presets sm-cards" data-size={size} role="radiogroup" aria-label={label}>
      {choices.map((c) => {
        const selected = value === c.id;
        return (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={selected}
            className="cr-preset"
            data-selected={selected ? "true" : undefined}
            onClick={() => {
              if (!selected) sfx.play("toggle");
              onPick(c.id);
            }}
          >
            <span className="cr-preset-top">
              <span className="cr-preset-title">{c.title}</span>
              <span className="cr-preset-radio" aria-hidden="true" />
            </span>
            <span className="cr-preset-summary">{c.summary}</span>
            {c.facts && c.facts.length > 0 ? (
              <span className="cr-preset-spec">
                {c.facts.map(([k, v]) => (
                  <span key={k}>
                    <span>{k}</span>
                    <b>{v}</b>
                  </span>
                ))}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** A short row of choices (chips). */
export function ChoiceChips<T extends string>({ label, choices, value, onPick }: { label: string; choices: readonly { id: T; text: string }[]; value: T | null; onPick: (id: T) => void }): ReactNode {
  return (
    <div className="sm-chips">
      <p className="sl-label">{label}</p>
      <div className="cr-picks" role="radiogroup" aria-label={label}>
        {choices.map((c) => (
          <button
            key={c.id}
            type="button"
            role="radio"
            aria-checked={value === c.id}
            aria-pressed={value === c.id}
            className="cr-pick"
            onClick={() => {
              if (value !== c.id) sfx.play("toggle");
              onPick(c.id);
            }}
          >
            {c.text}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A plain sentence under a choice group (same look as a slider's). */
export function Say({ text }: { text: string }): ReactNode {
  return (
    <p className="sl-say" aria-live="polite">
      <span className="sl-say-mark" aria-hidden="true" />
      <span key={text}>{text}</span>
    </p>
  );
}
