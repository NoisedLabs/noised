/**
 * The extra launch rules on the wizard's Review step: what they say in plain
 * English, every wallet or app they name in full, and their size. The claim
 * that the quantum key binds them is made only where that is true (review
 * U8): where rules are not live, the step says so and nothing can be added.
 */
import type { ReactNode } from "react";

import { Button } from "../../../components/ui";
import { toHex } from "../../../lib/format";
import { explainRuleSet, ruleKeyList, RULES_LIMITS, type RulesBuild } from "../../../lib/programmable";
import { Chip, Comment, Details, Panel, Readout, Row } from "../../inner/kit";
import { ruleSetOf, type RulesDraft, type RulesEnv } from "./state";

export function RulesReview({ rules, env, build, onEdit, available }: { rules: RulesDraft; env: RulesEnv; build: RulesBuild | null; onEdit: () => void; available: boolean }): ReactNode {
  const { set } = ruleSetOf(rules, env);
  const lines = build?.ok === true ? explainRuleSet(set) : [];
  const keys = build?.ok === true ? ruleKeyList(set) : [];
  return (
    <Panel
      title="Extra launch rules"
      description={
        !available
          ? "Coming soon on this network: your launch uses the early limits only."
          : build === null
            ? "None. Only the early limits apply."
            : "Checked by the chain on every transfer until the early limits end. Selling always works."
      }
      status={<Chip tone={!available || build === null ? "muted" : build.ok ? "ok" : "warn"}>{!available ? "Coming soon" : build === null ? "None" : build.ok ? `${rules.items.length} rule${rules.items.length === 1 ? "" : "s"}` : "Needs a fix"}</Chip>}
    >
      {lines.length > 0 ? (
        <ol className="rl-plain">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      ) : null}
      {keys.length > 0 ? (
        <div className="rl-keys-list">
          <p className="pg-label">Wallets and apps they name</p>
          <ul>
            {keys.map((k) => (
              <li key={k.address}>
                {k.name !== null ? <span className="rl-key-name">{k.name}</span> : null} <code className="pg-break">{k.address}</code>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {build?.ok === true && available ? (
        <>
          <Comment>
            Your quantum key signs these rules together with your launch, so the launch can only open with exactly these rules, and nobody can swap them later.
          </Comment>
          <Details summary="Check it yourself">
            <Readout label="Extra rules on Solana">
              <Row k="Size">
                {build.bytes.length.toLocaleString("en-US")} of {RULES_LIMITS.maxBytes.toLocaleString("en-US")} bytes
              </Row>
              <Row k="Fingerprint" wide>
                <code className="pg-break">{toHex(build.hash)}</code>
              </Row>
            </Readout>
          </Details>
        </>
      ) : null}
      {available ? (
        <div className="pg-btns">
          <Button size="sm" onClick={onEdit}>
            {build === null ? "Add extra rules" : "Change them"}
          </Button>
        </div>
      ) : null}
    </Panel>
  );
}
