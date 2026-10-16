/**
 * The row of small links under the home hero's verify field: the SDK and the MCP server on npm, the source on GitHub
 * and the whitepaper (PDF), each a pill with its mark. Plain links that open in a new tab, without an opener or a
 * referrer; nothing is fetched (the marks are inline SVG). Lines up with the field's left edge; two per row on phones.
 *
 *   <HeroLinks ref={links} />
 */
import type { ReactNode, Ref } from "react";

import { HERO_LINKS, type HeroLink } from "../../app/opensource";
import { DocMark, GitHubMark, NpmMark } from "../brandMarks";
import { sfx } from "../../fx/sfx";

const MARKS: Record<HeroLink["mark"], (p: { className?: string }) => ReactNode> = { npm: NpmMark, github: GitHubMark, doc: DocMark };

export function HeroLinks({ ref }: { ref?: Ref<HTMLUListElement> }): ReactNode {
  return (
    <ul ref={ref} className="hx-links" aria-label="Code and whitepaper">
      {HERO_LINKS.map((l) => {
        const Icon = MARKS[l.mark];
        return (
          <li key={l.id}>
            <a className="hx-link" href={l.href} target="_blank" rel="noopener noreferrer" data-link={l.id} onClick={() => sfx.play("click")}>
              <Icon className="hx-link-mark" />
              <span>{l.label}</span>
              <span className="sr-only"> ({l.more})</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
