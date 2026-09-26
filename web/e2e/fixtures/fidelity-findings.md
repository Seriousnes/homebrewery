## Findings (hand-written; kept in `web/e2e/fixtures/fidelity-findings.md`)

Reproduce the whole report from `web/` with:
`npx tsx scripts/fidelity-run.ts --browsers chromium,firefox --variants keep,trailing-break --workers 4`.
Without `--workers` on a busy machine, some Firefox tests can time out while the dev modules load. This run had 7; they were rerun with 2 workers and merged.
To rebuild only the report from saved runs, add `--report-only`.

**Result:** Chromium 302 / 309 fixtures under 2% (97.7%), Firefox 301 / 309 (97.4%); target ≥ 90%. No fixture clipped content upstream, so none is counted as "expected".
Every fixture still over the threshold has its cause outside the importer. The fixes belong to other lanes:

1. **Table header rows (5 class-table fixtures, both browsers; P5.6 and the canvas lane).** HBFM tables put their header rows in `<thead>`, e.g.
   `<table><thead><tr><th align="center">Level</th>…</tr></thead><tbody><tr><td align="center">1st</td>…</tr></tbody></table>`.
   The schema keeps every row in one `<tbody>`, so these theme rules no longer apply:
   - 5ePHB `style.less:149-167`: `thead { font-weight: 800 }`, `thead th { vertical-align: bottom; padding: 0 1.5px }`, and `tbody tr:nth-child(odd)` striping.
   - Blank `style.less:111`: `thead { font-weight: bold }`.

   Header cells lose bold and bottom alignment and get striped, the first body row loses its stripe, and column widths change. The bold header is wider, so upstream wraps *Features* cells that the import does not (martial class table: 10.2%).
   Expected: header rows render as upstream, either from a real `<thead>` or with the theme selectors rewritten (canvas notes, P5.6: `hb-header-row` plus `:is(thead, tr.hb-header-row)` and `nth-child(odd of :not(.hb-header-row))`).
2. **Empty definition terms (GNU FDL page 3: 17.99%; ORC notice: 2.92%; canvas.css).** `::Text` (a definition without a term) renders `<dl><dt></dt><dd>Text</dd>\n<dt></dt><dd>…</dd>\n</dl>`. Upstream draws the empty inline `dt` as nothing but its margins, which gives a hanging indent. ProseMirror puts `<br class="ProseMirror-trailingBreak">` into the empty `dt`, so every item gets an extra line break and a blank line.
   Expected: an empty `dt` takes no line. With `.hb-canvas .page :is(dt, dd) > br.ProseMirror-trailingBreak { display: none }` (the `trailing-break` column, which adds two more rules from `ImportDevPage.tsx` EXPERIMENTS), both fixtures drop to 0.00%. Chromium goes to 304 / 309 with nothing made worse.
3. **Paragraphs that hold only a float (`welcome` in Firefox: 2.07%; Chromium passes at 0.99%; canvas.css).**
   `[![Discord](/assets/discordOfManyThings.svg){width:50px,float:right,padding-left:10px}](https://discord.gg/…)` alone on its line renders `<p><a href><img style="…float: right…"></a></p>`, which has no height upstream.
   ProseMirror renders `<p><a href><img …><img class="ProseMirror-separator" alt=""></a><br class="ProseMirror-trailingBreak"></p>`. The separator image makes a 16px line, so the next paragraph starts a line lower.
   Expected: no line. Measured with the `trailing-break-separator` experiment, which adds `.hb-canvas .page p:has(> :not(br)) img.ProseMirror-separator { display: none }`: Firefox `welcome` 2.07% → 1.18%. The canvas lane must check that caret placement after a trailing inline image survives.

Fixed in the importer during this pass:
- The sanitizer section no longer lists DOMPurify's own `<remove>`/`<body>` scaffolding, which had appeared on every fixture, or heading ids dropped by its DOM-clobbering check (HeadingIds regenerates them). Every fixture now shows no sanitizer removals.
- The front cover's `{{logo …}}` (a positioned span alone on its line) is kept as a rawHtml block instead of a paragraph with an empty line: 4.64% → 1.42%.
- Clipping is measured on in-flow content only. The class tables were never clipped upstream; the earlier report counted their absolutely positioned decoration frames. Tall `.wide` blocks that overflow the bottom are now detected.
- The harness renders the import in EditorCanvas, read-only (PageView chrome, canvas.css), so `welcome` passes in Chromium: 5.72% in a bare TipTap editor → 0.99%. The probe and both harness frames load Open Sans, as the editor does.
- **Variables:** marked-variables and expr-eval are never loaded on imported text; the importer expands variables with its own evaluator. The 44 fixtures that use variables are all pixel-identical to upstream (0.00%). With `variables=keep` (syntax left as written), all 44 differ (mean 0.16%, max 0.62%). They stay under 2% only because they are one-liners; their text is wrong, so `expand` stays the default.
