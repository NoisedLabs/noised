/**
 * JSX typings for native MathML Core elements (React renders them in the MathML namespace under <math>).
 */
import type { DetailedHTMLProps, HTMLAttributes } from "react";

type MathMLProps = DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
  display?: "block" | "inline" | undefined;
  displaystyle?: "true" | "false" | undefined;
  mathvariant?: string | undefined;
  stretchy?: "true" | "false" | undefined;
  fence?: "true" | "false" | undefined;
  separator?: "true" | "false" | undefined;
  largeop?: "true" | "false" | undefined;
  movablelimits?: "true" | "false" | undefined;
  accent?: "true" | "false" | undefined;
  accentunder?: "true" | "false" | undefined;
  lspace?: string | undefined;
  rspace?: string | undefined;
  width?: string | undefined;
  height?: string | undefined;
  depth?: string | undefined;
  linethickness?: string | undefined;
  minsize?: string | undefined;
  maxsize?: string | undefined;
  encoding?: string | undefined;
  scriptlevel?: string | undefined;
  form?: "prefix" | "infix" | "postfix" | undefined;
};

declare module "react" {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      math: MathMLProps;
      semantics: MathMLProps;
      annotation: MathMLProps;
      mrow: MathMLProps;
      mi: MathMLProps;
      mn: MathMLProps;
      mo: MathMLProps;
      ms: MathMLProps;
      mtext: MathMLProps;
      mspace: MathMLProps;
      mfrac: MathMLProps;
      msqrt: MathMLProps;
      mroot: MathMLProps;
      msub: MathMLProps;
      msup: MathMLProps;
      msubsup: MathMLProps;
      munder: MathMLProps;
      mover: MathMLProps;
      munderover: MathMLProps;
      mtable: MathMLProps;
      mtr: MathMLProps;
      mtd: MathMLProps;
      mstyle: MathMLProps;
      mpadded: MathMLProps;
      mphantom: MathMLProps;
    }
  }
}
