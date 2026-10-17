import Link from "next/link";
import type { ReactNode } from "react";
import { Arrow, Box, Diagram, Group } from "./diagrams";

/**
 * About DataDesk: what the tool is, how data moves through it, and how it is built,
 * from the first thing a new user needs to know down to the code and the database.
 */

const SECTIONS = [
  { id: "what", label: "What DataDesk is" },
  { id: "features", label: "What you can do" },
  { id: "flow", label: "How data reaches a table" },
  { id: "lifecycle", label: "The life of a request" },
  { id: "onboarding", label: "Onboarding & contracts" },
  { id: "studio", label: "Data Studio in depth" },
  { id: "file-upload", label: "File upload (Cloud Run)" },
  { id: "convertor", label: "Convertor" },
  { id: "roles", label: "Who can do what" },
  { id: "architecture", label: "Architecture" },
  { id: "storage", label: "Where things are stored" },
  { id: "security", label: "Security & identity" },
  { id: "engineering", label: "For engineers" },
  { id: "glossary", label: "Glossary" },
] as const;

export function About() {
  return (
    <div className="px-4 pb-16 lg:px-6">
      <header className="pb-2 pt-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand">About</p>
        <h1 className="mt-1 text-3xl">DataDesk</h1>
        <p className="mt-2 max-w-3xl text-muted">
          A shared workspace for the data your team keeps in spreadsheets and tables, with one rule: nothing is written to a
          table until it has passed that table&apos;s checks and an admin has approved it.
        </p>
        <div className="mt-4 max-w-3xl rounded-xl border border-brand/30 bg-brand/5 px-4 py-3">
          <p className="text-sm font-semibold text-brand">Built for supplementary data</p>
          <p className="mt-1 text-sm">
            DataDesk is mainly for <b>supplementary data uploads</b>: the data that doesn&apos;t come from a source system&apos;s
            own pipeline but still has to sit next to it in the warehouse. Think reference lists, mappings, adjustments,
            manual corrections and business-maintained values. People own and update that data themselves, and each change is
            checked, approved and recorded before it reaches the table.
          </p>
        </div>
      </header>

      {/* on small screens the contents sit at the top */}
      <details className="my-4 rounded-xl border border-line lg:hidden">
        <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">On this page</summary>
        <Contents />
      </details>

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_13rem]">
        <article className="min-w-0 max-w-4xl text-[15px] leading-relaxed">
          <Section id="what" title="What DataDesk is">
            <p>
              Teams keep plenty of important data outside the systems it belongs in: customer lists, price changes, stock
              counts, corrections to last month&apos;s figures. Getting it into a BigQuery table usually means
              asking an engineer, or being given write access that is hard to audit. DataDesk sits in between.
            </p>
            <ul className="mt-3 list-disc space-y-1.5 pl-5">
              <li>
                <b>A private file workspace</b>, like a small OneDrive: folders, uploads, a spreadsheet editor and a full
                version history.
              </li>
              <li>
                <b>A Data Studio</b> for querying tables with SQL and making small corrections directly in the results.
              </li>
              <li>
                <b>File upload</b>: send a CSV or Excel file to a table through the <b>Cloud Run file processor</b>, and
                follow it from approval to the rows landing in BigQuery.
              </li>
              <li>
                <b>Onboarded tables</b>, each with a <b>data contract</b>: the rules the data must follow before it can be
                loaded.
              </li>
              <li>
                <b>An approval step.</b> Every load is checked, recorded and approved by an admin. DataDesk then writes it
                using its own account, never yours.
              </li>
            </ul>
            <Callout>
              The short version: you prepare the data, DataDesk checks it against the table&apos;s rules, an admin approves it,
              and DataDesk writes it. You can follow every step on the request&apos;s page.
            </Callout>
          </Section>

          <Section id="features" title="What you can do">
            <div className="grid gap-3 sm:grid-cols-2">
              <Card title="My files" href="/">
                Upload CSV, TSV, Excel and JSON files (up to 50 MB and 100,000 rows), organise them in folders, and edit them in
                a spreadsheet grid. Every save is a new version you can view, download or restore.
              </Card>
              <Card title="Convertor" href="/convertor">
                Turn an Excel workbook into CSV files: one per sheet you tick, named after the sheet (or as you like), with
                the delimiter you choose, saved in any folder of My files.
              </Card>
              <Card title="Load to table" href="/">
                From any file&apos;s page: the same form and process as File upload, for that file. Pick the table, see its
                contract and the name Cloud Run expects; problems are listed row by row before anything reaches an admin.
              </Card>
              <Card title="Data Studio" href="/studio">
                Browse datasets and tables like the BigQuery console, query them with SQL (Format tidies it), switch on Edit
                to change cells or add rows, and submit the changes for approval. For bigger changes, export to My files.
              </Card>
              <Card title="File upload" href="/file-upload">
                Upload a CSV or Excel file (or pick one from My files), choose the dataset and table, and see the file name
                Cloud Run expects. After approval Cloud Run loads it; every step, and the reason if it fails, is on the
                request.
              </Card>
              <Card title="Onboarding" href="/onboarding">
                See which tables are open for data, with their contracts. Ask for a new one to be onboarded; admins can onboard
                tables straight away.
              </Card>
              <Card title="Load requests" href="/uploads">
                Everyone can see every request, of every kind: who sent what, to which table, who approved it and how it
                went, so the same data isn&apos;t sent twice. The <b>Decided (history)</b> filter lists every decision.
              </Card>
              <Card title="Approvals (admins)" href="/admin">
                Approve or reject loads, file uploads and onboarding requests, approve new accounts and set temporary
                passwords. The list refreshes on its own; admins can also delete any request.
              </Card>
            </div>
          </Section>

          <Section id="flow" title="How data reaches a table">
            <p>
              There are two ways in, and both go through the same checks, the same approval and the same record.{" "}
              <b>Files</b> (from File upload, or a file&apos;s Load to table tab) are handed to the Cloud Run file processor
              to load; see <a href="#file-upload" className="text-brand hover:underline">File upload</a>.{" "}
              <b>Data Studio edits</b> change rows in place, so DataDesk writes those itself.
            </p>
            <FlowDiagram />
            <ol className="mt-2 list-decimal space-y-2 pl-5">
              <li>
                <b>Prepare the data.</b> Either upload and edit a file (every save is a version), or query a table in Data
                Studio and edit the rows you need.
              </li>
              <li>
                <b>Check it.</b> DataDesk reads the table&apos;s <i>live</i> schema and checks every value: that the columns
                exist, the types fit, and NOT NULL columns are filled. Then it applies the table&apos;s data contract. If
                anything fails, <b>nothing is filed</b> and you see each problem with its row and column.
              </li>
              <li>
                <b>Request.</b> If it passes, a load request is created. It records the data, the table, the contract
                version it passed and your reason. Everyone can see it, which stops two people sending the same data.
              </li>
              <li>
                <b>Approve.</b> An admin reviews it. Approving checks the data <i>again</i>, against the table as it is now
                and the contract as it is now, so tightening a contract also covers requests that are already waiting.
              </li>
              <li>
                <b>Write.</b> DataDesk writes the rows using its own identity and records the outcome (rows inserted and
                updated, or why it failed).
              </li>
            </ol>
          </Section>

          <Section id="lifecycle" title="The life of a request">
            <p>
              Every request page, and every card in the lists, shows its progress as stages: six for Load to table and Data
              Studio (below), eight for File upload, which adds Landing, Cloud Run, Cloud Run checks and BigQuery load. The stage in progress
              pulses, finished stages turn green, and a stage that fails turns red with its reason.
            </p>
            <div className="my-5 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {[
                ["Initiated", "Who sent it, when, and from which file version or Data Studio query."],
                ["Validation", "The file was read (format, delimiter), and its columns and types match the table."],
                ["Data contract", "Every rule of the contract version in force passed. Skipped if the table has no contract."],
                ["Approval", "Waiting for an admin, then who approved or rejected it, with their note."],
                ["Load", "The rows are being written; then how many were inserted and updated, or the error."],
                ["Completed", "The data is in the table."],
              ].map(([title, text], i) => (
                <div key={title} className="rounded-xl border border-line p-3">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand text-[10px] text-brand-contrast">
                      {i + 1}
                    </span>
                    {title}
                  </p>
                  <p className="mt-1 text-xs text-muted">{text}</p>
                </div>
              ))}
            </div>
            <p>Behind the stages, a request has one of five statuses:</p>
            <StatusDiagram />
            <p>
              For a File upload, <b>approved</b> means the file is with Cloud Run; it becomes completed or failed when Cloud
              Run finishes. Completed, failed and rejected are final: nothing moves a request back.
            </p>
            <p className="mt-2">
              A request that fails at approval stays <b>failed</b> with its reason, and nothing from it is kept half-written.
              BigQuery appends are single load jobs, and upserts and Data Studio edits run as one MERGE or one
              transaction. To try again, fix the data and send a new request.
            </p>
          </Section>

          <Section id="onboarding" title="Onboarding & data contracts">
            <p>
              A table can only receive data once it has been <b>onboarded</b>. Anyone can ask for a table to be onboarded;
              an admin approves the request. Tables an admin onboards are approved straight away.
            </p>
            <OnboardingDiagram />
            <h3 className="mt-6 font-semibold">Test access</h3>
            <p>
              Before a table can be onboarded, DataDesk proves it can work with the table <i>as itself</i>:
            </p>
            <p className="mt-2">
              The dataset and table are visible, the account holds read and write permissions, it can run query and load
              jobs, and, for upsert, it can create the temporary staging table an upsert uses. Because every file loads
              through Cloud Run, it also checks DataDesk can write to Cloud Run&apos;s config and landing buckets and
              read its audit tables.
            </p>
            <p className="mt-2">
              Any check that fails names the role that fixes it. A table can&apos;t be onboarded until every check passes, and the API enforces this, not
              only the page.
            </p>

            <h3 className="mt-6 font-semibold">The data contract</h3>
            <p>Per column, on top of what the table&apos;s own schema enforces:</p>
            <div className="mt-3 overflow-hidden rounded-xl border border-line">
              <table className="w-full text-sm">
                <tbody>
                  {[
                    ["Required", "The column must be in the data, and every row must have a value."],
                    ["Unique", "No value may repeat within the data being sent."],
                    ["Allowed values", "Only values from a list, e.g. retail, business."],
                    ["Pattern", "The value must match a regular expression, e.g. an email or a product code."],
                    ["Range", "A number between a minimum and a maximum (0 is a valid limit)."],
                    ["Length", "Text between a minimum and a maximum number of characters."],
                    ["Date format", "For dates and timestamps not written as ISO (2026-10-17), e.g. %d/%m/%Y."],
                    ["If it fails", "Stop the file (the default), or Warn only: failures are shown but the file goes through."],
                    ["Fewest / most rows", "The fewest and the most rows one load may carry."],
                    ["Note", "Guidance shown to people preparing data for the table."],
                  ].map(([rule, text]) => (
                    <tr key={rule} className="border-t border-line first:border-t-0">
                      <td className="w-40 bg-surface px-4 py-2 font-medium">{rule}</td>
                      <td className="px-4 py-2 text-muted">{text}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3">
              Every change to a contract makes a new <b>version</b>. A request records the version it passed, and approval
              checks against the current one.
            </p>
            <p className="mt-2">
              <b>One contract for both paths.</b> Every table loads files through Cloud Run. Onboarding also sets its file
              name prefix, CSV and/or Excel, and whether files may append, overwrite or either (the sender then chooses).
              DataDesk publishes the same contract
              to Cloud Run&apos;s config bucket whenever it changes, so DataDesk and Cloud Run always check the same rules.
              When Cloud Run already had a contract for the table, onboarding starts from its rules.
            </p>

            <h3 className="mt-6 font-semibold">Write modes</h3>
            <p className="mt-2">
              <b>Files</b> (File upload, or a file&apos;s Load to table tab) are loaded by Cloud Run:
            </p>
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              <li>
                <b>Append:</b> the file&apos;s rows are added to the table.
              </li>
              <li>
                <b>Overwrite:</b> the file replaces every row of the table.
              </li>
            </ul>
            <p className="mt-2">
              The admin allows one or both per table. When both are allowed, the person sending the file chooses (append by
              default).
            </p>
            <p className="mt-3">
              <b>Data Studio edits</b> are written by DataDesk itself:
            </p>
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              <li>
                <b>Append:</b> new rows are inserted.
              </li>
              <li>
                <b>Upsert:</b> rows are matched on the key the admin chose; a match is updated, the rest inserted (a
                staging table and one MERGE).
              </li>
              <li>
                <b>Edit in place</b> (on tables that allow upsert): the changed rows are updated where they are. See Data
                Studio below.
              </li>
            </ul>
            <p className="mt-2">
              Pausing a table hides it from everyone&apos;s lists without losing its contract. Rejected onboarding requests
              are hidden from the list.
            </p>
          </Section>

          <Section id="studio" title="Data Studio in depth">
            <StudioDiagram />
            <h3 className="mt-4 font-semibold">Querying: read-only, always</h3>
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              <li>
                The left panel lists datasets and their tables, like the BigQuery console. Clicking a table writes a starting
                query; you change it and press Run (or ⌘/Ctrl + Enter). <b>Format</b> (⌘/Ctrl + Shift + F) lays the query out
                one clause per line.
              </li>
              <li>
                Only one <code>SELECT</code> (or <code>WITH … SELECT</code>) runs at a time, and only over onboarded tables.
                Anything else is refused before it reaches the database.
              </li>
              <li>
                <b>BigQuery</b> dry-runs the query first to learn its statement type, the tables it reads and how much it
                would scan. It refuses anything over 1 GB.
              </li>
              <li>Up to 1,000 rows are shown.</li>
            </ul>

            <h3 className="mt-6 font-semibold">Editing</h3>
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              <li>
                The grid is read-only until you switch on <b>Edit</b>. Then any cell can be changed, key columns included,
                and rows can be added. Changed cells turn amber and new rows green; each row can be undone.
              </li>
              <li>
                Results from a single table can be edited. Joins and computed or renamed columns are read-only. Tables
                onboarded for append only allow <b>Add rows</b>. Nested BigQuery records and arrays can&apos;t be edited as
                text.
              </li>
              <li>Up to 500 changed rows go in one submission. For more, use <b>Export to My files</b>.</li>
            </ul>

            <h3 className="mt-6 font-semibold">What happens when you submit</h3>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5">
              <li>
                Each edited row is found in the table again <b>by the values it had when you queried it</b>. If it has
                changed since, the submission is refused, so you never overwrite someone else&apos;s change.
              </li>
              <li>
                The rows as they will be (and your new rows) are checked against the schema and the data contract, exactly
                like a file. A copy is kept as a CSV in <b>My files › Data Studio</b> as the record.
              </li>
              <li>
                The request shows the approver every change as <b>before → after</b>, and the query the rows came from.
              </li>
              <li>
                On approval, every edit runs as an <code>UPDATE … WHERE</code> on the original values, and every new row as
                an <code>INSERT</code>, <b>all in one transaction</b>. If any edited row changed in the meantime, nothing is
                written and the request says which row.
              </li>
            </ol>
            <Callout>
              Rows that are identical in every queried column can&apos;t be told apart, so changing one changes all of them.
              The request shows this as, for example, &ldquo;(4 identical rows)&rdquo;. To change just one of them, include
              a column that tells them apart in your query.
            </Callout>
          </Section>

          <Section id="file-upload" title="File upload (Cloud Run)">
            <p>
              Every file load, from the File upload tab or a file&apos;s Load to table tab, goes through the{" "}
              <b>Cloud Run file processor</b>: Cloud Storage landing bucket → Pub/Sub → Cloud Run → BigQuery. Cloud Run records every attempt in{" "}
              <code>file_audit.job_metadata</code> and every check in <code>file_audit.validation_metadata</code>, and
              DataDesk reads those back to show what happened.
            </p>
            <FileUploadDiagram />
            <ol className="mt-2 list-decimal space-y-2 pl-5">
              <li>
                <b>Send.</b> Upload a CSV or Excel file (it is saved in <b>My files › File uploads</b>) or pick one from My
                files, grouped by folder, then choose the dataset and table, and append or overwrite when the table
                allows both.
              </li>
              <li>
                <b>The file name.</b> Files land as the table&apos;s prefix plus a business date, e.g.{" "}
                <code>customer_20261017.csv</code>. A file with another name keeps its own name in My files; the date comes
                from a date in its name, or today, and can be changed.
              </li>
              <li>
                <b>Checked here first,</b> exactly as Cloud Run will: CSV or Excel, comma-separated, every column of the
                table in order with a header row, the types, and every contract rule. Warn-only rules are shown but
                don&apos;t stop the file. Only a passing file becomes a request.
              </li>
              <li>
                <b>Approve.</b> An admin approves it in Approvals, with no waiting. It is checked again against the current
                contract, then copied to{" "}
                <code>landing/datadesk/&lt;dataset&gt;.&lt;table&gt;/&lt;request&gt;/&lt;name&gt;</code>, tagged with the
                load mode and the contract version it passed. Your copy moves to <b>My files › File uploads › Archive</b>{" "}
                so sent files don&apos;t pile up.
              </li>
              <li>
                <b>Follow it.</b> The request moves through Landing, Cloud Run (picked up, which attempt), Cloud Run checks
                and BigQuery load. If it fails you see Cloud Run&apos;s reason and each failed check with example rows (only
                you and admins see the values). If nothing picks the file up within five minutes, it says so.
              </li>
            </ol>
            <h3 className="mt-6 font-semibold">How Cloud Run gets the contract</h3>
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              <li>
                Saving a table in Onboarding publishes its contract to Cloud Run&apos;s config bucket as{" "}
                <code>contracts/&lt;dataset&gt;.&lt;table&gt;.yaml</code>.
              </li>
              <li>
                The table folder in the landed file&apos;s path tells Cloud Run which contract to read: only that one, when
                it is needed, however many tables there are.
              </li>
              <li>
                Each Cloud Run instance caches the contracts it has read. A change in the config bucket notifies the{" "}
                <code>contract-changes</code> topic, which calls Cloud Run&apos;s <code>/contracts</code> endpoint to read it
                again straight away.
              </li>
              <li>
                Because a file says which contract version it passed, any instance that still has an older copy reads the
                new one before using it. Cached copies also expire after five minutes.
              </li>
            </ul>

            <h3 className="mt-6 font-semibold">DataDesk keeps the record</h3>
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              <li>
                The API checks Cloud Run&apos;s progress every 15 seconds for requests still with it, and saves each step in
                DataDesk&apos;s own database, whether or not anyone is looking. The request page also refreshes every few
                seconds and has a <b>Refresh status</b> button.
              </li>
              <li>
                Once a request is completed or failed it is final: cleaning up <code>file_audit</code> or the table later
                doesn&apos;t change it, and attempts seen once are kept.
              </li>
              <li>
                A completed request offers <b>Check the data</b>: Data Studio opens with a query for the rows that load added
                (Cloud Run tags each row with <code>_job_id</code>), ready for you to run.
              </li>
            </ul>
          </Section>

          <Section id="convertor" title="Convertor">
            <p>Turns an Excel workbook (.xlsx) into CSV files in My files.</p>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5">
              <li>
                Upload a workbook (saved in <b>My files › Convertor</b>) or pick one from My files.
              </li>
              <li>
                <b>One sheet:</b> it becomes one CSV with the workbook&apos;s own name. <b>Several sheets:</b> tick the
                ones you want; each becomes a CSV named after its sheet, or after the workbook and the sheet, or anything
                you type. Each sheet shows its size and a preview of its first rows.
              </li>
              <li>
                Choose the delimiter (comma, tab, semicolon or pipe) and the folder to save in (or make a new one), then
                convert. A name already taken in that folder gets a number, e.g. <code>Customers (1).csv</code>.
              </li>
            </ol>
            <p className="mt-2">
              Cells are written the way Cloud Run reads Excel, so the CSVs pass File upload&apos;s checks: formulas give
              their calculated value, dates become <code>2026-10-17</code>, <code>12.0</code> becomes <code>12</code>, and
              empty rows are dropped. Old .xls files aren&apos;t supported: save them as .xlsx first.
            </p>
          </Section>

          <Section id="roles" title="Who can do what">
            <div className="overflow-hidden rounded-xl border border-line">
              <table className="w-full text-sm">
                <thead className="bg-surface text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2 font-semibold">What</th>
                    <th className="w-28 px-4 py-2 text-center font-semibold">Everyone</th>
                    <th className="w-28 px-4 py-2 text-center font-semibold">Admins</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ["Upload, edit, version and export your own files", true, true],
                      ["Convert Excel sheets to CSV files", true, true],
                      ["Query onboarded tables in Data Studio", true, true],
                      ["Send data for approval (files, Data Studio edits, File upload)", true, true],
                      ["See every load request: who, what, where, the outcome", true, true],
                      ["See the row-level validation errors of a request", "own", true],
                      ["See onboarded tables and their contracts", true, true],
                      ["Ask for a table to be onboarded", true, true],
                      ["Onboard a table straight away, change contracts, pause tables", false, true],
                      ["Approve or reject loads and onboarding requests", false, true],
                      ["Approve accounts, set temporary passwords, suspend people", false, true],
                      ["Delete any request", false, true],
                    ] as [string, boolean | string, boolean][]
                  ).map(([what, everyone, admins]) => (
                    <tr key={what} className="border-t border-line">
                      <td className="px-4 py-2">{what}</td>
                      <td className="px-4 py-2 text-center">{mark(everyone)}</td>
                      <td className="px-4 py-2 text-center">{mark(admins)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3">
              Files are private: nobody else can open them. When a file is sent for approval, others see its name and the
              request&apos;s summary, while the rows stay visible only to you and the admins.
            </p>
          </Section>

          <Section id="architecture" title="Architecture">
            <p>
              DataDesk has three parts: a web app in your browser, an API that holds all the rules, and the places data lives.
              The web app never talks to a database or a bucket directly. Every action is an API call, and the API decides.
            </p>
            <ArchitectureDiagram />
            <h3 className="mt-4 font-semibold">Inside the API: layers</h3>
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              <li>
                <b>Routes</b> (<code>app/api/v1</code>) handle HTTP: they read the request, check who is signed in, call a
                service, and shape the answer. They hold no business rules.
              </li>
              <li>
                <b>Services</b> (<code>app/services</code>) hold the rules: validation, contracts, onboarding, approvals,
                Data Studio, the workspace. They raise errors people can act on (&ldquo;column qty above max 1000&rdquo;),
                which the API turns into a message and the field it concerns.
              </li>
              <li>
                <b>Adapters</b> (<code>app/adapters</code>) are the only code that talks to the outside world: Cloud Storage,
                BigQuery, the Cloud Run file processor&apos;s buckets and audit tables, and Google Cloud credentials.
              </li>
              <li>
                <b>Models and schemas</b>: SQLAlchemy models for DataDesk&apos;s own tables, and Pydantic shapes for what goes
                in and out of the API.
              </li>
              <li>
                <b>Core</b>: settings from <code>.env</code>, the database connection, password hashing and tokens, logging
                with a request id on every line, and the middleware that records each request.
              </li>
            </ul>
            <h3 className="mt-6 font-semibold">The web app</h3>
            <p>
              Next.js (App Router) with React and Tailwind. Pages check the session on the server before they render. The
              browser calls <code>/api/…</code> on the same address, which the web server forwards to the API. That keeps
              the sign-in cookie same-origin and httpOnly. The look (a forest-green palette, Figtree and Source Serif) comes
              from colour tokens, so light, dark and automatic themes all follow from one place.
            </p>
          </Section>

          <Section id="storage" title="Where things are stored">
            <p>
              <b>File contents</b> live in a Cloud Storage bucket, one object per version, under a folder per person. Nothing
              is overwritten. <b>Everything else</b> lives in DataDesk&apos;s own PostgreSQL database:
            </p>
            <DataModelDiagram />
            <ul className="mt-2 list-disc space-y-1.5 pl-5">
              <li>
                <b>users</b> and <b>password_reset_requests</b>: accounts, roles, sign-in state and lockouts.
              </li>
              <li>
                <b>workspace_folders</b>, <b>workspace_files</b>, <b>workspace_file_versions</b>: the tree, each file&apos;s
                current version and columns, and every version&apos;s location in the bucket.
              </li>
              <li>
                <b>upload_targets</b>: onboarded tables with their contract (JSON) and its version, write modes, upsert key,
                a snapshot of the schema, the onboarding request and review, and where the contract was last published for
                Cloud Run.
              </li>
              <li>
                <b>upload_requests</b>: each load. It records the file and version, the target, the write mode, the validation
                report, the status and who decided, the result, and, for Data Studio, the change summary (every cell before and
                after). For a File upload it also keeps the name it landed under, where and when it landed, and every Cloud
                Run attempt and check read back.
              </li>
            </ul>
            <p className="mt-2">
              The schema is built only by versioned migrations (<code>V001</code> … <code>V014</code>). Each one is applied
              once, recorded with a checksum, and never edited afterwards; a change is always a new migration.
            </p>
          </Section>

          <Section id="security" title="Security & identity">
            <ul className="list-disc space-y-1.5 pl-5">
              <li>
                <b>Accounts:</b> new accounts wait for an admin&apos;s approval. Passwords are hashed with argon2id. Five
                wrong passwords lock an account for 15 minutes. A forgotten password is reset by an admin, who sets a
                temporary one.
              </li>
              <li>
                <b>Sessions:</b> a signed token in an httpOnly cookie (scripts can&apos;t read it), valid for 12 hours.
              </li>
              <li>
                <b>DataDesk writes as itself, never as you.</b> BigQuery and Cloud Storage are reached as DataDesk&apos;s own
                service account (impersonated, so no key file). Test access reports which identity it checked as.
              </li>
              <li>
                <b>Least privilege by design:</b> Data Studio queries are read-only and limited to onboarded tables. All SQL
                values are passed as parameters, never pasted into the SQL, and table and column names are checked before
                use.
              </li>
              <li>
                <b>Everything is recorded:</b> who asked, who approved, when, what passed, and what was written. Files keep
                every version.
              </li>
            </ul>
          </Section>

          <Section id="engineering" title="For engineers">
            <div className="grid gap-3 sm:grid-cols-2">
              <Card title="Stack">
                FastAPI · SQLAlchemy (async, asyncpg) · Pydantic · Next.js · React · Tailwind · PostgreSQL (DataDesk&apos;s own
                data) · BigQuery · Cloud Storage · Cloud Run (File upload).
              </Card>
              <Card title="Ports">
                API on <code>8001</code>, web app on <code>3001</code>. The web app forwards <code>/api</code> to the API.
              </Card>
            </div>
            <h3 className="mt-6 font-semibold">Repository</h3>
            <pre className="mt-2 overflow-x-auto rounded-xl border border-line bg-surface p-4 font-mono text-xs leading-5">{`backend/app/
  api/v1/        routes: auth, workspace, studio, onboarding, requests, file_uploads, convertor, admin, health
  services/      the rules: validators, workspace, onboarding, reviews, studio, file_upload …
  adapters/      storage (GCS), bigquery, file_pipeline (Cloud Run), gcp (identity)
  models/ schemas/ core/
backend/tests/   API and service tests
database/
  postgres/migrations/   V001 … V014, applied in order, checksummed
  postgres/schema/       generated snapshot of the schema
  scripts/               setup_db, migrate, seed, check_db …
frontend/
  app/           pages (files, studio, file-upload, uploads, requests, onboarding, admin, about …)
  components/    UI (FileBrowser, SpreadsheetEditor, DataStudio, FileUpload, LoadFlow …)
  lib/           api client, types, session, theme`}</pre>
            <h3 className="mt-6 font-semibold">Everyday commands</h3>
            <div className="mt-2 overflow-hidden rounded-xl border border-line">
              <table className="w-full text-sm">
                <tbody>
                  {[
                    ["make setup", "Install everything and create the database"],
                    ["make db-init", "Create or upgrade the database: migrations and seed data"],
                    ["make api / make web", "Run the API and the web app with live reload"],
                    ["make check-all", "Check the database, Cloud Storage, BigQuery and the Cloud Run buckets and audit tables"],
                    ["make admin EMAIL=…", "Make someone an admin"],
                    ["make test / make lint", "Tests and linters"],
                  ].map(([cmd, what]) => (
                    <tr key={cmd} className="border-t border-line first:border-t-0">
                      <td className="w-56 bg-surface px-4 py-2 font-mono text-xs">{cmd}</td>
                      <td className="px-4 py-2 text-muted">{what}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3 className="mt-6 font-semibold">Settings worth knowing (.env)</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
              <li>
                <code>DATABASE_URL</code> (DataDesk&apos;s own database).
              </li>
              <li>
                <code>GCP_PROJECT_ID</code>, <code>GCP_SERVICE_ACCOUNT</code>, <code>GCS_BUCKET</code>,{" "}
                <code>BQ_LOCATION</code>.
              </li>
              <li>
                <code>MAX_UPLOAD_BYTES</code>, <code>MAX_ROWS</code>, and for Data Studio <code>STUDIO_ROW_LIMIT</code>,{" "}
                <code>STUDIO_MAX_CHANGES</code>, <code>STUDIO_QUERY_TIMEOUT_SECONDS</code>,{" "}
                <code>STUDIO_MAX_BYTES_BILLED</code>.
              </li>
              <li>
                <code>FILE_UPLOAD_LANDING_BUCKET</code>, <code>FILE_UPLOAD_CONFIG_BUCKET</code> (File upload is off while
                they are empty), <code>FILE_UPLOAD_AUDIT_DATASET</code>,{" "}
                <code>FILE_UPLOAD_PICKUP_MINUTES</code>, <code>FILE_UPLOAD_POLL_SECONDS</code>.
              </li>
              <li>
                <code>ENFORCE_APP_IDENTITY</code>: when true, Test access fails unless DataDesk runs as its own service
                account rather than a person&apos;s gcloud login.
              </li>
            </ul>
          </Section>

          <Section id="glossary" title="Glossary">
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[10rem_1fr]">
              {[
                ["Target", "A BigQuery table DataDesk can write to."],
                ["Onboarded", "A target that has been approved for loads, with its data contract."],
                ["Data contract", "The rules a table's data must follow, per column. Versioned."],
                ["Load request", "Data waiting for (or past) an admin's decision to write it to a table."],
                ["Append / Overwrite", "How a file loads: add its rows / replace the whole table."],
                ["Upsert", "Data Studio: update rows that match the key and insert the rest."],
                ["Convertor", "Turns Excel sheets into CSV files in My files."],
                ["Edit in place", "Data Studio's mode: update the edited rows where they are."],
                ["File upload", "Sending a file to a table through the Cloud Run file processor."],
                ["Landing bucket", "Where approved File upload files are put; a new file there starts Cloud Run."],
                ["Warn only", "A contract rule whose failures are shown but don't stop the file."],
                ["Version", "A saved state of a file. Restoring one makes it the newest version."],
                ["Test access", "The check that DataDesk itself can read and write a table."],
              ].map(([term, text]) => (
                <div key={term} className="contents">
                  <dt className="font-semibold">{term}</dt>
                  <dd className="text-muted">{text}</dd>
                </div>
              ))}
            </dl>
          </Section>
        </article>

        <aside className="hidden lg:block">
          <nav aria-label="On this page" className="sticky top-20">
            <p className="px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-muted">On this page</p>
            <Contents />
          </nav>
        </aside>
      </div>
    </div>
  );
}

function Contents() {
  return (
    <ul className="flex flex-col pb-2 text-sm">
      {SECTIONS.map((s) => (
        <li key={s.id}>
          <a href={`#${s.id}`} className="block rounded-lg px-3 py-1.5 text-muted hover:bg-surface hover:text-fg">
            {s.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="mt-10 scroll-mt-20 border-t border-line pt-8 first:mt-0 first:border-t-0 first:pt-4">
      <h2 className="display mb-3 text-2xl">{title}</h2>
      {children}
    </section>
  );
}

function Card({ title, href, children }: { title: string; href?: string; children: ReactNode }) {
  const body = (
    <>
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-sm text-muted">{children}</p>
    </>
  );
  return href ? (
    <Link href={href} className="rounded-xl border border-line p-4 transition hover:border-brand/50 hover:bg-surface">
      {body}
    </Link>
  ) : (
    <div className="rounded-xl border border-line p-4">{body}</div>
  );
}

function Callout({ children }: { children: ReactNode }) {
  return <p className="mt-4 rounded-xl border-l-4 border-brand bg-surface px-4 py-3 text-sm">{children}</p>;
}

function mark(value: boolean | string) {
  if (value === "own") return <span className="text-xs text-muted">own only</span>;
  return value ? <span className="font-semibold text-ok">✓</span> : <span className="text-muted">—</span>;
}

// ------------------------------------------------------------------ diagrams
function FlowDiagram() {
  const id = "flow";
  return (
    <Diagram id={id} width={1000} height={360} title="Two ways in, one way through: every change is checked, approved and recorded.">
      <Group x={15} y={20} w={530} h={120} label="My files" />
      <Box x={30} y={58} w={150} h={62} title="Upload a file" lines={["CSV, Excel or JSON"]} />
      <Box x={205} y={58} w={150} h={62} title="Edit & save" lines={["saved as versions"]} />
      <Box x={380} y={58} w={150} h={62} title="Load to table" lines={["choose a table"]} />
      <Arrow id={id} d="M180 89 L205 89" />
      <Arrow id={id} d="M355 89 L380 89" />

      <Group x={15} y={170} w={530} h={120} label="Data Studio" />
      <Box x={30} y={208} w={150} h={62} title="Query" lines={["one read-only SELECT"]} />
      <Box x={205} y={208} w={150} h={62} title="Edit in the grid" lines={["switch on Edit"]} />
      <Box x={380} y={208} w={150} h={62} title="Submit" lines={["review, add a reason"]} />
      <Arrow id={id} d="M180 239 L205 239" />
      <Arrow id={id} d="M355 239 L380 239" />

      <Arrow id={id} d="M530 89 L560 89 L560 62 L590 62" />
      <Arrow id={id} d="M530 239 L575 239 L575 90 L590 90" />

      <Box x={590} y={30} w={180} h={78} title="Checks" lines={["table schema", "data contract rules"]} tone="warn" />
      <Box x={590} y={150} w={180} h={70} title="Request (pending)" lines={["waits for an admin", "visible to everyone"]} tone="brand" />
      <Box x={590} y={262} w={180} h={78} title="Admin approves" lines={["re-checked against the", "current contract"]} />
      <Box x={820} y={30} w={160} h={78} title="Nothing is filed" lines={["problems listed by row", "fix and send again"]} tone="bad" dashed />
      <Box x={820} y={150} w={160} h={70} title="Rejected or failed" lines={["with the reason"]} tone="bad" dashed />
      <Box x={820} y={262} w={160} h={78} title="Written to the table" lines={["rows inserted and", "updated, as DataDesk"]} tone="accent" />

      <Arrow id={id} d="M770 69 L820 69" tone="bad" label="fail" lx={795} ly={61} />
      <Arrow id={id} d="M680 108 L680 150" tone="brand" label="pass" lx={702} ly={134} />
      <Arrow id={id} d="M680 220 L680 262" tone="brand" label="decide" lx={708} ly={246} />
      <Arrow id={id} d="M770 280 L795 280 L795 185 L820 185" tone="bad" dashed />
      <Arrow id={id} d="M770 312 L820 312" tone="brand" label="load" lx={795} ly={304} />
    </Diagram>
  );
}

function StatusDiagram() {
  const id = "status";
  return (
    <Diagram id={id} width={760} height={230} minWidth={560} title="A request's status, and what moves it on.">
      <Box x={30} y={75} w={150} h={60} title="pending" lines={["waiting for an admin"]} tone="warn" />
      <Box x={300} y={75} w={150} h={60} title="approved" lines={["being written"]} tone="brand" />
      <Box x={570} y={20} w={160} h={60} title="completed" lines={["the data is in"]} tone="accent" />
      <Box x={570} y={130} w={160} h={60} title="failed" lines={["re-check or write failed"]} tone="bad" />
      <Box x={300} y={160} w={150} h={60} title="rejected" lines={["with the admin's note"]} tone="bad" />
      <Arrow id={id} d="M180 105 L300 105" tone="brand" label="admin approves" lx={240} ly={97} />
      <Arrow id={id} d="M105 135 L105 190 L300 190" tone="bad" label="admin rejects" lx={205} ly={183} />
      <Arrow id={id} d="M450 95 L510 95 L510 50 L570 50" tone="brand" label="written" lx={538} ly={43} />
      <Arrow id={id} d="M450 115 L510 115 L510 160 L570 160" tone="bad" label="error" lx={538} ly={153} />
    </Diagram>
  );
}

function FileUploadDiagram() {
  const id = "fu";
  return (
    <Diagram id={id} width={1000} height={190} title="File upload: checked and approved in DataDesk, loaded by Cloud Run, followed back in DataDesk.">
      <Box x={20} y={30} w={150} h={70} title="Send" lines={["file + dataset.table"]} />
      <Box x={200} y={30} w={150} h={70} title="Checks" lines={["name · header", "schema · contract"]} tone="warn" />
      <Box x={380} y={30} w={150} h={70} title="Admin approves" lines={["checked again"]} />
      <Box x={560} y={30} w={150} h={70} title="Landing bucket" lines={["prefix_YYYYMMDD.csv"]} tone="brand" />
      <Box x={740} y={30} w={240} h={70} title="Cloud Run" lines={["checks · loads BigQuery", "archives the file"]} tone="accent" />
      <Arrow id={id} d="M170 65 L200 65" />
      <Arrow id={id} d="M350 65 L380 65" />
      <Arrow id={id} d="M530 65 L560 65" />
      <Arrow id={id} d="M710 65 L740 65" />
      <Box x={560} y={125} w={420} h={50} title="DataDesk reads file_audit back" lines={["every 15 s · saved for good"]} />
      <Arrow id={id} d="M860 100 L860 125" />
    </Diagram>
  );
}

function OnboardingDiagram() {
  const id = "onb";
  const steps: [string, string[], "base" | "warn" | "accent"][] = [
    ["Pick a table", ["a BigQuery dataset", "and table"], "base"],
    ["Test access", ["can DataDesk itself", "read and write it?"], "warn"],
    ["Write the contract", ["rules per column,", "write modes, key"], "base"],
    ["Admin review", ["approve or reject", "(admins: at once)"], "base"],
    ["Open for data", ["in everyone's lists;", "contract v1, v2 …"], "accent"],
  ];
  return (
    <Diagram id={id} width={1000} height={170} title="Onboarding a table: from a request to a table open for data.">
      {steps.map(([title, lines, tone], i) => (
        <Box key={title} x={20 + i * 198} y={45} w={168} h={80} title={title} lines={lines} tone={tone} />
      ))}
      {steps.slice(1).map((_, i) => (
        <Arrow key={i} id={id} d={`M${188 + i * 198} 85 L${218 + i * 198} 85`} tone="brand" />
      ))}
      <text x={302} y={150} textAnchor="middle" style={{ fill: "var(--muted)", fontSize: 11.5 }}>
        a failed check names the grant to fix
      </text>
    </Diagram>
  );
}

function StudioDiagram() {
  const id = "studio";
  return (
    <Diagram id={id} width={1000} height={250} title="Data Studio: read-only queries; edits checked against the table, then written in one transaction.">
      <Box x={20} y={30} w={170} h={78} title="Query" lines={["SELECT over onboarded", "tables only"]} />
      <Box x={20} y={150} w={170} h={78} title="Guard" lines={["BigQuery dry run:", "SELECT only, 1 GB cap"]} tone="warn" />
      <Arrow id={id} d="M105 108 L105 150" />
      <Box x={240} y={30} w={170} h={78} title="Edit" lines={["any cell, new rows", "up to 500 rows"]} tone="brand" />
      <Arrow id={id} d="M190 69 L240 69" />
      <Box x={460} y={30} w={170} h={78} title="Re-read" lines={["find each row by its", "original values"]} />
      <Arrow id={id} d="M410 69 L460 69" />
      <Box x={460} y={150} w={170} h={78} title="Changed since?" lines={["refused; run the", "query again"]} tone="bad" dashed />
      <Arrow id={id} d="M545 108 L545 150" tone="bad" />
      <Box x={680} y={30} w={140} h={78} title="Checks" lines={["schema +", "contract"]} tone="warn" />
      <Arrow id={id} d="M630 69 L680 69" tone="brand" />
      <Box x={860} y={30} w={120} h={78} title="Approval" lines={["before → after", "for the admin"]} />
      <Arrow id={id} d="M820 69 L860 69" tone="brand" />
      <Box x={680} y={150} w={300} h={78} title="Written in one transaction" lines={["UPDATE … WHERE original values; INSERT new rows", "any row changed meanwhile → nothing written"]} tone="accent" />
      <Arrow id={id} d="M920 108 L920 150" tone="brand" />
    </Diagram>
  );
}

function ArchitectureDiagram() {
  const id = "arch";
  return (
    <Diagram id={id} width={1000} height={450} title="How DataDesk is built: the browser talks only to the API; the API alone reaches data.">
      <Box x={20} y={170} w={170} h={110} title="Your browser" lines={["DataDesk web app", "Next.js · port 3001"]} tone="brand" />
      <Arrow id={id} d="M190 225 L230 225" tone="brand" label="/api" lx={210} ly={216} />

      <Group x={230} y={30} w={330} h={400} label="DataDesk API · FastAPI · port 8001" tone="base" />
      <Box x={250} y={60} w={290} h={70} title="Routes (api/v1)" lines={["auth · workspace · studio · onboarding", "requests · admin · health"]} />
      <Box x={250} y={150} w={290} h={70} title="Services: the rules" lines={["validation · contracts · approvals", "onboarding · workspace · studio"]} tone="brand" />
      <Box x={250} y={240} w={290} h={70} title="Adapters: the outside world" lines={["Cloud Storage · BigQuery", "Cloud Run pipeline · GCP identity"]} />
      <Box x={250} y={330} w={290} h={80} title="Core" lines={["settings · database · security", "logging with request ids"]} />
      <Arrow id={id} d="M395 130 L395 150" />
      <Arrow id={id} d="M395 220 L395 240" />

      <Box x={650} y={40} w={320} h={70} title="DataDesk database (PostgreSQL)" lines={["people · folders · files · versions", "onboarded tables · requests"]} />
      <Box x={650} y={130} w={320} h={70} title="Cloud Storage bucket" lines={["every version of every file"]} />
      <Group x={630} y={225} w={360} h={155} label="Target tables · written only on approval" />
      <Box x={650} y={255} w={320} h={52} title="BigQuery" lines={["as DataDesk's service account"]} tone="accent" />
      <Box x={650} y={317} w={320} h={52} title="Cloud Run file processor" lines={["File upload: landing bucket → BigQuery"]} tone="accent" />

      <Arrow id={id} d="M540 175 L570 175 L570 75 L650 75" label="metadata" lx={610} ly={67} />
      <Arrow id={id} d="M540 262 L595 262 L595 165 L650 165" label="file bytes" lx={622} ly={157} />
      <Arrow id={id} d="M540 290 L630 290" tone="brand" label="loads" lx={585} ly={282} />
    </Diagram>
  );
}

function DataModelDiagram() {
  const id = "model";
  return (
    <Diagram id={id} width={1000} height={330} title="DataDesk's own tables, and how they refer to each other.">
      <Box x={20} y={110} w={170} h={80} title="users" lines={["people, roles,", "sign-in state"]} tone="brand" />
      <Box x={250} y={20} w={200} h={64} title="workspace_folders" lines={["the folder tree"]} />
      <Box x={250} y={120} w={200} h={64} title="workspace_files" lines={["current version, columns"]} />
      <Box x={250} y={220} w={200} h={64} title="workspace_file_versions" lines={["where each version is"]} />
      <Box x={520} y={20} w={200} h={64} title="upload_targets" lines={["onboarded tables, contracts"]} tone="accent" />
      <Box x={520} y={170} w={200} h={90} title="upload_requests" lines={["file + version → table", "status · report · result", "Studio change summary"]} tone="warn" />
      <Box x={780} y={20} w={200} h={64} title="password_reset_requests" lines={["waiting for an admin"]} />
      <Box x={780} y={170} w={200} h={90} title="Earlier grants" lines={["db_access_grants,", "bq_access_requests:", "per-person access"]} dashed />
      <Arrow id={id} d="M190 140 L250 52" />
      <Arrow id={id} d="M190 155 L250 152" />
      <Arrow id={id} d="M350 184 L350 220" />
      <Arrow id={id} d="M520 205 L450 165" label="file" lx={492} ly={176} />
      <Arrow id={id} d="M620 170 L620 84" label="target" lx={646} ly={132} />
      <Arrow id={id} d="M620 260 L620 305 L105 305 L105 190" label="asked by · decided by" lx={360} ly={322} />
    </Diagram>
  );
}
