/**
 * The generated reference pages: one SDK group (content/docs/generated/sdk.ts) or one program
 * (content/docs/generated/programs.ts). Pure rendering of data; doc strings go through the docs Markdown.
 */
import { useMemo, type ReactNode } from "react";

import { parseBlocks } from "../../content/docs/markdown";
import { PROGRAMS, SDK_KIND_ORDER, SDK_REFERENCE, sdkAnchor, sdkEntriesOf } from "../../content/docs/nav";
import type { ProgramAccountMeta, ProgramDoc, ProgramField, ProgramInstruction, SdkEntry } from "../../content/docs/types";
import { CopyText } from "./figures";
import { Blocks, CodeBlock, Heading, Md } from "./Markdown";

function Doc({ text }: { text: string }): ReactNode {
  const blocks = useMemo(() => parseBlocks(text.split("\n")), [text]);
  return text.trim() ? <Blocks blocks={blocks} /> : null;
}

function Tag({ children, tone }: { children: ReactNode; tone?: "hi" | "dim" | "warn" | undefined }): ReactNode {
  return (
    <span className="dx-tag" data-tone={tone ?? "base"}>
      {children}
    </span>
  );
}

// ------------------------------------------------------------------- SDK ---

function SdkItem({ e }: { e: SdkEntry }): ReactNode {
  return (
    <section className="dx-api" aria-labelledby={sdkAnchor(e)}>
      <div className="dx-api-head">
        <Heading level={3} id={sdkAnchor(e)} text={e.name}>
          <code>{e.name}</code>
        </Heading>
        <div className="dx-api-tags">
          <Tag tone="hi">{e.kind}</Tag>
          <Tag>{e.module}</Tag>
          {e.typeOnly ? <Tag tone="dim">type only</Tag> : null}
          {e.deprecated ? <Tag tone="warn">deprecated</Tag> : null}
        </div>
      </div>
      <CodeBlock code={e.signature} lang="ts" title={`sdk/src/${e.module}.ts`} />
      <Doc text={e.doc} />
      {e.notes ? (
        <div className="dx-api-notes">
          <span className="dx-api-notes-k">From the SDK README</span>
          <p className="dx-p">
            <Md text={e.notes} />
          </p>
        </div>
      ) : null}
      {e.members.length > 0 ? (
        <div className="dx-table-wrap" role="region" aria-label={`${e.name} members`} tabIndex={0}>
          <table className="dx-table dx-table-api">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Signature</th>
              </tr>
            </thead>
            <tbody>
              {e.members.map((m) => (
                <tr key={m.name}>
                  <td data-label="Member">
                    <code className="dx-ic">{m.name}</code>
                    <div className="dx-cell-sub">{m.kind}</div>
                  </td>
                  <td data-label="Signature">
                    <code className="dx-sig">{m.signature}</code>
                    {m.doc ? (
                      <div className="dx-cell-doc">
                        <Md text={m.doc.replace(/\n+/g, " ")} />
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export function SdkGroupPage({ group }: { group: string }): ReactNode {
  const entries = sdkEntriesOf(group);
  return (
    <>
      <CodeBlock
        code={`import { ${entries
          .filter((e) => !e.typeOnly)
          .slice(0, 3)
          .map((e) => e.name)
          .join(", ")}${entries.length > 3 ? ", …" : ""} } from ${JSON.stringify(SDK_REFERENCE.packageName)};`}
        lang="ts"
        title="import"
      />
      {SDK_KIND_ORDER.map((k) => {
        const of = entries.filter((e) => e.kind === k.kind);
        if (of.length === 0) return null;
        return (
          <section key={k.kind} className="dx-api-group">
            <Heading level={2} id={k.id} text={k.title}>
              {k.title} <span className="dx-count">{of.length}</span>
            </Heading>
            {of.map((e) => (
              <SdkItem key={e.name} e={e} />
            ))}
          </section>
        );
      })}
    </>
  );
}

// -------------------------------------------------------------- programs ---

function AccountFlags({ a }: { a: ProgramAccountMeta }): ReactNode {
  return (
    <span className="dx-flags">
      {a.signer ? <Tag tone="hi">signer</Tag> : null}
      {a.writable ? <Tag>mut</Tag> : null}
      {a.optional ? <Tag tone="dim">optional</Tag> : null}
      {a.init ? <Tag tone="warn">{a.init}</Tag> : null}
      {!a.signer && !a.writable && !a.optional && !a.init ? <Tag tone="dim">read</Tag> : null}
    </span>
  );
}

function FieldsTable({ fields, label }: { fields: ProgramField[]; label: string }): ReactNode {
  if (fields.length === 0) return null;
  return (
    <div className="dx-table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table className="dx-table dx-table-api">
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Type</th>
            <th scope="col" data-align="right">
              Bytes
            </th>
          </tr>
        </thead>
        <tbody>
          {fields.map((f) => (
            <tr key={f.name}>
              <td data-label="Field">
                <code className="dx-ic">{f.name}</code>
                {f.docs ? (
                  <div className="dx-cell-doc">
                    <Md text={f.docs.replace(/\n+/g, " ")} />
                  </div>
                ) : null}
              </td>
              <td data-label="Type">
                <code className="dx-sig">
                  {f.type}
                  {f.maxLen ? ` (max ${f.maxLen})` : ""}
                </code>
              </td>
              <td data-align="right" className="dx-num" data-label="Bytes">
                {f.size ?? "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `name(a: A, b: B)`, one argument per line when long. */
function ixSignature(ix: ProgramInstruction): string {
  const args = ix.args.map((a) => `${a.name}: ${a.type}`);
  const one = `${ix.name}(${args.join(", ")})`;
  return one.length <= 72 ? one : [`${ix.name}(`, ...args.map((a) => `    ${a},`), ")"].join("\n");
}

function Instruction({ ix }: { ix: ProgramInstruction }): ReactNode {
  const id = `ix-${ix.name}`;
  return (
    <section className="dx-api" aria-labelledby={id}>
      <div className="dx-api-head">
        <Heading level={3} id={id} text={ix.name}>
          <code>{ix.name}</code>
        </Heading>
        <div className="dx-api-tags">
          <Tag>{ix.file.replace(/^programs\//, "")}</Tag>
          {ix.customDiscriminator ? <Tag tone="warn">discriminator {ix.customDiscriminator}</Tag> : null}
        </div>
      </div>
      <CodeBlock code={ixSignature(ix)} lang="rust" title={`accounts: ${ix.accountsStruct}`} />
      <Doc text={ix.docs} />
      {ix.handlerDocs && ix.handlerDocs.trim() !== ix.docs.trim() ? (
        <details className="dx-more">
          <summary>How it works</summary>
          <Doc text={ix.handlerDocs} />
        </details>
      ) : null}
      {ix.accounts.length > 0 ? (
        <div className="dx-table-wrap" role="region" aria-label={`${ix.name} accounts`} tabIndex={0}>
          <table className="dx-table dx-table-api">
            <thead>
              <tr>
                <th scope="col" data-align="right">
                  #
                </th>
                <th scope="col">Account</th>
                <th scope="col">Flags</th>
                <th scope="col">Seeds and constraints</th>
              </tr>
            </thead>
            <tbody>
              {ix.accounts.map((a) => (
                <tr key={a.index}>
                  <td data-align="right" className="dx-num" data-label="#">
                    {a.index}
                  </td>
                  <td data-label="Account">
                    <code className="dx-ic">{a.name}</code>
                    <div className="dx-cell-sub">{a.type}</div>
                    {a.docs ? (
                      <div className="dx-cell-doc">
                        <Md text={a.docs.replace(/\n+/g, " ")} />
                      </div>
                    ) : null}
                  </td>
                  <td data-label="Flags">
                    <AccountFlags a={a} />
                  </td>
                  <td data-label="Seeds and constraints">
                    {a.seeds.length > 0 ? (
                      <code className="dx-sig">
                        [{a.seeds.join(", ")}]{a.seedsProgram ? ` @ ${a.seedsProgram}` : ""}
                      </code>
                    ) : null}
                    {a.constraints ? <div className="dx-cell-sub dx-wrap">{a.constraints}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

export function ProgramPage({ slug }: { slug: string }): ReactNode {
  const p: ProgramDoc | undefined = PROGRAMS.find((x) => x.slug === slug);
  if (!p) return null;
  return (
    <>
      <Heading level={2} id="overview" text="Overview">
        Overview
      </Heading>
      <dl className="dx-facts">
        <div>
          <dt>Program id</dt>
          <dd>
            <code className="dx-addr">{p.programId}</code>
            <CopyText value={p.programId} label="program id" />
          </dd>
        </div>
        <div>
          <dt>Crate</dt>
          <dd>
            <code className="dx-ic">{p.crate}</code> in <code className="dx-ic">{p.dir}</code>
          </dd>
        </div>
        {p.errorEnum ? (
          <div>
            <dt>Errors</dt>
            <dd>
              <code className="dx-ic">{p.errorEnum}</code>, codes {p.errors[0]?.code}–{p.errors[p.errors.length - 1]?.code}
            </dd>
          </div>
        ) : null}
      </dl>
      <Doc text={p.docs} />

      {p.instructions.length > 0 ? (
        <section className="dx-api-group">
          <Heading level={2} id="instructions" text="Instructions">
            Instructions <span className="dx-count">{p.instructions.length}</span>
          </Heading>
          {p.instructions.map((ix) => (
            <Instruction key={ix.name} ix={ix} />
          ))}
        </section>
      ) : null}

      {p.accounts.length > 0 ? (
        <section className="dx-api-group">
          <Heading level={2} id="accounts" text="Accounts">
            Accounts <span className="dx-count">{p.accounts.length}</span>
          </Heading>
          {p.accounts.map((a) => (
            <section key={a.name} className="dx-api" aria-labelledby={`acc-${a.name}`}>
              <div className="dx-api-head">
                <Heading level={3} id={`acc-${a.name}`} text={a.name}>
                  <code>{a.name}</code>
                </Heading>
                <div className="dx-api-tags">
                  {a.size !== null ? <Tag tone="hi">{a.size.toLocaleString("en-US")} bytes</Tag> : null}
                  {a.version ? <Tag>version {a.version}</Tag> : null}
                  <Tag>{a.file.replace(/^programs\//, "")}</Tag>
                </div>
              </div>
              <Doc text={a.docs} />
              <FieldsTable fields={a.fields} label={`${a.name} fields`} />
            </section>
          ))}
        </section>
      ) : null}

      {p.types.length > 0 ? (
        <section className="dx-api-group">
          <Heading level={2} id="types" text="Types">
            Types <span className="dx-count">{p.types.length}</span>
          </Heading>
          {p.types.map((t) => (
            <details key={t.name} className="dx-more dx-type" id={`type-${t.name}`}>
              <summary>
                <code>{t.name}</code> <span className="dx-cell-sub">{t.kind}</span>
              </summary>
              <Doc text={t.docs} />
              <FieldsTable fields={t.fields} label={`${t.name} fields`} />
            </details>
          ))}
        </section>
      ) : null}

      {p.pdas.length > 0 ? (
        <section className="dx-api-group">
          <Heading level={2} id="pdas" text="PDAs">
            PDAs <span className="dx-count">{p.pdas.length}</span>
          </Heading>
          <div className="dx-table-wrap" role="region" aria-label="PDAs" tabIndex={0}>
            <table className="dx-table dx-table-api">
              <thead>
                <tr>
                  <th scope="col">Seeds</th>
                  <th scope="col">Used as</th>
                </tr>
              </thead>
              <tbody>
                {p.pdas.map((d) => (
                  <tr key={d.seeds.join("|") + d.program}>
                    <td data-label="Seeds">
                      <code className="dx-sig">[{d.seeds.join(", ")}]</code>
                      {d.program ? <div className="dx-cell-sub">program: {d.program}</div> : null}
                    </td>
                    <td data-label="Used as">
                      {d.names.map((n) => (
                        <code key={n} className="dx-ic dx-ic-list">
                          {n}
                        </code>
                      ))}
                      {d.docs ? (
                        <div className="dx-cell-doc">
                          <Md text={d.docs.replace(/\n+/g, " ")} />
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {p.events.length > 0 ? (
        <section className="dx-api-group">
          <Heading level={2} id="events" text="Events">
            Events <span className="dx-count">{p.events.length}</span>
          </Heading>
          <ul className="dx-events">
            {p.events.map((ev) => (
              <li key={ev.name} id={`ev-${ev.name}`}>
                <code className="dx-ev-name">{ev.name}</code>
                <span className="dx-ev-fields">
                  {ev.fields.map((f) => (
                    <code key={f.name} className="dx-ic dx-ic-list" title={f.type}>
                      {f.name}
                    </code>
                  ))}
                </span>
                {ev.docs ? (
                  <div className="dx-cell-doc">
                    <Md text={ev.docs.replace(/\n+/g, " ")} />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {p.errors.length > 0 ? (
        <section className="dx-api-group">
          <Heading level={2} id="errors" text="Errors">
            Errors <span className="dx-count">{p.errors.length}</span>
          </Heading>
          <div className="dx-table-wrap" role="region" aria-label="Errors" tabIndex={0}>
            <table className="dx-table dx-table-api dx-table-errors">
              <thead>
                <tr>
                  <th scope="col" data-align="right">
                    Code
                  </th>
                  <th scope="col">Name</th>
                  <th scope="col">Message</th>
                </tr>
              </thead>
              <tbody>
                {p.errors.map((er) => (
                  <tr key={er.code} id={`err-${er.code}`}>
                    <td data-align="right" className="dx-num" data-label="Code">
                      {er.code}
                      <div className="dx-cell-sub">0x{er.code.toString(16)}</div>
                    </td>
                    <td data-label="Name">
                      <code className="dx-ic">{er.name}</code>
                    </td>
                    <td data-label="Message">
                      {er.msg}
                      {er.docs ? (
                        <div className="dx-cell-doc">
                          <Md text={er.docs.replace(/\n+/g, " ")} />
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {p.constants.length > 0 ? (
        <section className="dx-api-group">
          <Heading level={2} id="constants" text="Constants">
            Constants <span className="dx-count">{p.constants.length}</span>
          </Heading>
          <div className="dx-table-wrap" role="region" aria-label="Constants" tabIndex={0}>
            <table className="dx-table dx-table-api">
              <thead>
                <tr>
                  <th scope="col">Constant</th>
                  <th scope="col">Value</th>
                </tr>
              </thead>
              <tbody>
                {p.constants.map((c) => (
                  <tr key={c.path}>
                    <td data-label="Constant">
                      <code className="dx-ic">{c.path}</code>
                      <div className="dx-cell-sub">{c.type}</div>
                      {c.docs ? (
                        <div className="dx-cell-doc">
                          <Md text={c.docs.replace(/\n+/g, " ")} />
                        </div>
                      ) : null}
                    </td>
                    <td data-label="Value">
                      <code className="dx-sig dx-wrap">{c.value}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
