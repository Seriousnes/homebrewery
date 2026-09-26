
Homebrewery WYSIWYG Plan

-
-
-

    Implementation plan · fork of naturalcrit/homebrewery · September 2026

# Homebrewery WYSIWYG Plan

    Rebuild the brew editor as one WYSIWYG canvas. Authors type directly on fixed-size, theme-styled pages, and text moves to a new page automatically when a page fills. The front end is a React SPA with TipTap; the back end is ASP.NET Core on .NET 10 with PostgreSQL jsonb. The existing theme CSS and snippet generators carry over unchanged.

      UI React 19 + TypeScript
      Editor TipTap 3 / ProseMirror
      API ASP.NET Core, .NET 10
      DB PostgreSQL 18 jsonb
      Layout auto-pagination, 1–2 columns

      Contents

          - §0Using this plan

          - §1Decisions

          - §2Architecture

          - §3Document model

          - §4Automatic pagination

          - §5Canvas, themes and CSS

          - §6Editor features

          - §7Importing markdown brews

          - §8Backend (.NET 10)

          - §9Frontend app

          - §10What to reuse

          - §11Phases and tasks

          - §12Testing

          - §13Risks

          - §14Upstream behaviour to drop

## §0Using this plan

    - Every unit of work has an ID: S1–S3 for spikes and P0.1–P8.4 for tasks (§11). Ask a coding session for work by ID, for example “implement P4.3”, and point it at the matching section.

    - Order: P0 → S1–S3 (go/no-go) → P2 and P3 in parallel → P4 → P5 → P6 → P7 → P8.

    - Code on this page is a sketch of intent written against the real APIs. Exact signatures and edge cases get settled by the tests named in each task's “Done when”.

    - Paths like legacy/client/… refer to the original code after task P0.1 moves it. Line numbers were taken at upstream commit 4b9fdba.

  Paste this into the repository's CLAUDE.md so every session starts from the same rules:

  CLAUDE.md (paste into the repo root)Copy
## WYSIWYG rewrite (fork)
- Plan of record: https://claude.ai/artifact/1X5nXZesTgEWWRCTuCXEgt ("Homebrewery WYSIWYG Plan").
  Before starting a task, read the plan section for its ID (e.g. P4.3) and meet its "Done when".
- Backend: src/ (.NET 10, ASP.NET Core minimal APIs, EF Core + Npgsql, PostgreSQL 18).
  Run: dotnet run --project src/Homebrewery.Api
- Frontend: web/ (React 19, TypeScript, Vite, TipTap 3). Run: npm --prefix web run dev (proxies /api).
- themes/ is shared with upstream. Only edit theme LESS to fix bugs. The editor must emit the
  HTML listed in the plan's "CSS contract" so theme CSS keeps working unchanged.
- legacy/ holds the original Node/React code for reference. Never import from it at runtime.
- Pagination: transactions set addToHistory=false and move page boundaries only with
  join + split (never delete + insert). See plan section 4.
- Tests: dotnet test | npm --prefix web test | npm --prefix web run e2e

## §1Decisions

### Decided

     |  | Area | Choice | Reason

       | Front end | React 19 + TypeScript SPA, built with Vite | Reuses the existing React UI. Every production rich-text engine is JavaScript.

       | Editor engine | TipTap 3 on ProseMirror, MIT packages only (no TipTap Pro) | Schema-driven documents, custom node views, and HTML parse rules for importing.

       | Stored format | ProseMirror JSON in brews.doc (jsonb) | WYSIWYG editing without a markdown round trip. Markdown is import-only.

       | Back end | ASP.NET Core minimal APIs on .NET 10 (LTS) | Familiar .NET stack. The server logic is small.

       | Database | PostgreSQL 18 with EF Core + Npgsql | jsonb for documents, tsvector for search, arrays for tags.

       | Pagination | Automatic: overflowing content moves to a new page | The editor knows the page size and measures the real layout.

       | Columns | 1 or 2 per section | Covers every shipped theme.

       | Theme CSS | Reused unchanged; the editor emits the same HTML shape as today's renderer | The themes are the most valuable part of the repository.

### Defaults (change these if you disagree)

     |  | Area | Default | Reason

       | Editing canvas | Same document as the app, with theme CSS scoped under .hb-canvas | The research suggested keeping the iframe. Rendering in the same document avoids cross-frame selection, popover positioning and drag-and-drop problems. Fall back to an iframe if S1 shows CSS leaking between app and pages.

       | Saving | Sign-in required to save. /new drafts live in IndexedDB until then. | Upstream let anyone holding an edit link edit an authorless brew.

       | Links | Keep shareId (public read) and editId (edit URL); editing still requires authorship | Same URL shapes as upstream.

       | Variables ($[var], [var]:) | Not supported. Imports keep the expanded text. | Computed text inside WYSIWYG is a separate feature. Revisit later.

       | Legacy-renderer brews | Not importable | Different markdown dialect (marked 0.3).

       | Google Drive storage | Dropped | Large surface area for little value in a fork.

       | Browsers | Chromium and Firefox; Safari best effort | Upstream already warns non-Chrome users.

       | Auth | ASP.NET Core Identity with cookie auth; external providers optional | Upstream login lives on naturalcrit.com and can't be reused.

## §2Architecture

    [figure]

    Only the browser can measure layout, so pagination lives entirely in the editor. The server validates the resulting JSON against the schema manifest and stores it.

### Repository layout

  Repository layoutCopy
homebrewery/                       your fork
├─ src/
│  ├─ Homebrewery.Api/             ASP.NET Core host: endpoints, auth, SPA hosting, share shell
│  │  ├─ Endpoints/                Brew, Theme, Vault, User, Account, Import, Notification, Admin
│  │  ├─ Infrastructure/           SameOriginWriteGuard, ShareShell, RateLimits, ProblemDetails
│  │  ├─ wwwroot/                  Vite build output (git-ignored)
│  │  └─ Program.cs
│  ├─ Homebrewery.Core/            Brew, BrewAuthor, BrewService, AccessPolicy, DocInspector,
│  │                               SchemaManifest, ThemeCatalog, UpstreamImportClient
│  └─ Homebrewery.Data/            AppDbContext, Configurations/, Migrations/
├─ tests/
│  └─ Homebrewery.Api.Tests/       xUnit + WebApplicationFactory + Testcontainers.PostgreSql
├─ web/                            Vite + React 19 + TypeScript (strict)
│  ├─ src/
│  │  ├─ app/                      router, providers, layout shell
│  │  ├─ api/                      generated OpenAPI types + openapi-fetch client
│  │  ├─ pages/                    Home, New, Edit, Share, User, Vault, Account, Import, Admin
│  │  ├─ editor/
│  │  │  ├─ schema/                doc.ts, nodes/*, marks/*, attrs.ts, index.ts (no DOM imports)
│  │  │  ├─ nodeviews/             PageView.ts (vanilla), ThemeBlockView.tsx, ObjectLayer.ts, RawHtmlView.tsx
│  │  │  ├─ pagination/            plugin.ts, step.ts, measure.ts, cut.ts, boundary.ts, triggers.ts
│  │  │  ├─ canvas/                EditorCanvas.tsx, cssScope.ts, themeLoader.ts, zoom.ts
│  │  │  ├─ commands/              keymap.ts, sections.ts, continuation.ts, blocks.ts
│  │  │  ├─ import/                hbfmToDoc.ts, brewText.ts, sanitize.ts, importReport.ts
│  │  │  ├─ snippets/              insertSnippet.ts, compileSnippets.ts
│  │  │  ├─ save/                  useAutosave.ts, drafts.ts, ConflictDialog.tsx
│  │  │  └─ ui/                    Toolbar, Inspector, InsertMenu, StyleDrawer, Outline, PageNav
│  │  └─ ported/                   MetadataEditor, TagInput, Navbar, BrewItem (from legacy/, now TS)
│  ├─ e2e/                         Playwright specs, fixtures/*.hbfm.txt, fixtures/*.doc.json
│  ├─ scripts/schema-manifest.ts   writes ../shared/schema-manifest.json
│  └─ vite/                        generateAssetsPlugin.ts (ported), scopeThemes.ts
├─ themes/                         unchanged: V3/*, fonts, assets, snippets (*.gen.js)
├─ shared/schema-manifest.json     generated; read by DocInspector on the server
├─ legacy/                         original client/, server/, shared/, server.js (reference only)
├─ docker-compose.yml
├─ Dockerfile
└─ Homebrewery.sln

### Running locally

    - docker compose up -d db

    - dotnet user-secrets set ConnectionStrings:Homebrewery "Host=localhost;Database=homebrewery;Username=homebrewery;Password=homebrewery" --project src/Homebrewery.Api

    - dotnet ef database update --project src/Homebrewery.Data --startup-project src/Homebrewery.Api

    - dotnet run --project src/Homebrewery.Api, then npm --prefix web run dev. Vite proxies /api and /share to Kestrel.

  docker-compose.ymlCopy
services:
  db:
    image: postgres:18
    environment:
      POSTGRES_USER: homebrewery
      POSTGRES_PASSWORD: homebrewery
      POSTGRES_DB: homebrewery
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql"]   # postgres 18 images keep data under a versioned subfolder
volumes:
  pgdata:

  DockerfileCopy
FROM node:24 AS web
WORKDIR /repo
COPY web/package*.json web/
RUN npm --prefix web ci
COPY themes themes
COPY shared shared
COPY web web
RUN npm --prefix web run build            # writes src/Homebrewery.Api/wwwroot + shared/schema-manifest.json

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS api
WORKDIR /repo
COPY . .
COPY --from=web /repo/src/Homebrewery.Api/wwwroot src/Homebrewery.Api/wwwroot
COPY --from=web /repo/shared/schema-manifest.json shared/schema-manifest.json
RUN dotnet publish src/Homebrewery.Api -c Release -o /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=api /out .
ENV ASPNETCORE_HTTP_PORTS=8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "Homebrewery.Api.dll"]

## §3Document model

  The document is doc › page+ › blocks. Pages are real nodes, and each renders as one fixed-size .page, so theme CSS applies unchanged. A manual page starts a section. Auto pages are created by the paginator and copy their section's settings.

### 3.1 Nodes and marks

     |  | Node / mark | Content and attributes | Emits | Replaces (markdown)

       | doc | page+ | ProseMirror root div.pages | the brew text

       | page | block+; pid, kind, columns, markers, pageNumber, footer, objects | div.page › chrome + div.columnWrapper | \page {…}

       | paragraph | inline; align, continuation | p[align] | paragraphs, :- -: :-:

       | heading | inline; level 1–6, id | h1…h6 | #…######

       | bulletList, orderedList, listItem | start, continuation | ul, ol, li | -, 1.

       | definitionList › definitionTerm, definitionDesc | inline; continuation | dl › dt, dd | Term :: Def

       | blockquote | block+ | blockquote | >

       | codeBlock | text; language | pre › code | fences

       | horizontalRule | — | hr | ___

       | table and row/header/cell | colspan, rowspan, colwidth, align | table | GFM + extended tables

       | themeBlock | block+ | div.block.<classes> | {{monster,frame …}}

       | columnBreak | atom | div.columnSplit | \column

       | spacer | atom | div.blank | : lines

       | toc | atom; depth, wide | div.block.toc › ul | TOC snippet (now live)

       | rawHtml | atom; html (sanitized) | the HTML | anything the importer doesn't recognise

       | image (inline) | src, alt, title, width, height | img[loading=lazy] with --HB_src | ![]()

       | icon (inline atom) | font, glyph | i.df.d12-2 | :df_d12_2:

       | inlineBox (inline atom) | classes, style | empty span.inline-block | {{width:100px}} spacers

       | hardBreak | — | br | line breaks

       | marks | bold, italic, underline, strike, code, superscript, subscript, link, span (classes, style, id; excludes: '' so spans can nest) | strong em u s code sup sub a span.inline-block | ** * <u> ~~ ` ^ ^^ []() {{class text}}

  Every node listed in HB_ATTR_TYPES also carries the generic classes, style, id and attributes (3.5). They replace the markdown dialect's {…} injection.

### 3.2 CSS contract

  Theme selectors depend on the exact HTML today's renderer produces. The editor's DOM (NodeViews and renderHTML) must match this table; S3 checks it visually.

     |  | Structure the editor must emit | Theme rules that depend on it

       | .hb-canvas › div.pages › div.page with only pages as children | .page:nth-child(even) mirrored footers and page numbers; Journal's odd/even padding

       | div.page › div.columnWrapper holding the flow | column settings inherited by .columnWrapper (Blank style.less:40-46)

       | marker spans inside .page, e.g. span.inline-block.frontCover | .page:has(.frontCover) switches to the cover layout (5ePHB style.less:547)

       | span.pageNumber.auto, span.footnote inside .page | absolute positioning and counter(page-numbers) (Blank style.less:481-497, 5ePHB :409-431)

       | .page:has(.skipCounting), :has(.resetCounting) | page counter increment and reset

       | div.block.monster.frame with h2, p, hr, dl, table children in upstream order | .monster hr ~ dl, hr + table:first-of-type, triangle rules (5ePHB :301-385)

       | h1 followed directly by p | drop cap h1 + p::first-letter; p + p indent

       | div.columnSplit | break-after: always column break

       | div.blank | vertical spacer

       | img with style="--HB_src:url(…)" | .wrapLeft/.wrapRight shape-outside

       | div.block.toc[.wide] › ul › li › a › span + span | TOC dot leaders (5ePHB :806-870)

       | .wide on blocks | column-span: all

  WatchUpstream's paragraph renderer leaves a paragraph's trailing inline span outside the <p>, which shifts p + p matches. Markers, page numbers and footers are now page attributes, so most of these cases disappear. Record any that remain in the S3 report.

### 3.3 A stored document

  A stored document (brews.doc)Copy
{
  "type": "doc",
  "content": [
    {
      "type": "page",
      "attrs": {
        "pid": "k3f9a1qe",
        "kind": "manual",
        "columns": 2,
        "markers": [],
        "pageNumber": true,
        "footer": "Part 1 | The Wandering Inn",
        "objects": [
          {
            "id": "o1",
            "kind": "image",
            "src": "https://example.com/inn-sketch.png",
            "classes": [],
            "style": "position:absolute;bottom:0;right:-80px;height:45%"
          }
        ],
        "classes": [],
        "style": null
      },
      "content": [
        { "type": "heading", "attrs": { "level": 1, "id": "the-wandering-inn" },
          "content": [{ "type": "text", "text": "The Wandering Inn" }] },
        { "type": "paragraph",
          "content": [{ "type": "text", "text": "Travelers speak of an inn that is never in the same place twice." }] },
        { "type": "themeBlock", "attrs": { "classes": ["note"] },
          "content": [
            { "type": "heading", "attrs": { "level": 5 }, "content": [{ "type": "text", "text": "Rumors" }] },
            { "type": "paragraph", "content": [{ "type": "text", "text": "The innkeeper never ages." }] }
          ] },
        { "type": "paragraph",
          "content": [{ "type": "text", "text": "The common room smells of cedar," }] }
      ]
    },
    {
      "type": "page",
      "attrs": { "pid": "p7x2qe0m", "kind": "auto", "columns": 2, "pageNumber": true,
                 "footer": "Part 1 | The Wandering Inn", "markers": [], "objects": [] },
      "content": [
        { "type": "paragraph", "attrs": { "continuation": true },
          "content": [{ "type": "text", "text": "pipe smoke and rain that never falls outside." }] }
      ]
    }
  ]
}

### 3.4 Rules

    - continuation: true marks the second fragment of a paragraph or list that pagination split. It renders an extra class hb-continued with text-indent: 0, and ids stay on the first fragment.

    - Heading ids come from a plugin that slugs the heading text and keeps ids unique across the document. The TOC and #id links use them.

    - pid is a stable page id assigned by an appendTransaction. Pages also get id="p{n}" by index so imported #p3 links keep working.

    - DocSchemaVersion is bumped on incompatible schema changes. The client migrates older docs on load (web/src/editor/schema/migrations.ts) and saves the new version.

    - The schema is the single source of truth. A build step writes shared/schema-manifest.json, and the server validates every save against it (§8.5).

### 3.5 Generic attributes

  web/src/editor/schema/attrs.tsCopy
// Homebrewery's {{class,key:value,#id,attr=x}} tags and {…} injection become four
// generic attributes on every node that can carry them.
import { Extension } from '@tiptap/core';

export const RESERVED_CLASSES = new Set([
  'block', 'inline-block', 'page', 'columnWrapper', 'ProseMirror', 'hb-continued',
]);
const SAFE_ATTR = /^(data-[\w-]+|aria-[\w-]+|title|lang|dir|role)$/;

export const HB_ATTR_TYPES = [
  'page', 'paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote',
  'codeBlock', 'horizontalRule', 'image', 'table', 'tableRow', 'tableHeader', 'tableCell',
  'definitionList', 'themeBlock', 'inlineBox',
];

export const HbAttributes = Extension.create({
  name: 'hbAttributes',
  addGlobalAttributes() {
    return [{
      types: HB_ATTR_TYPES,
      attributes: {
        classes: {
          default: [] as string[],
          parseHTML: (el) => [...el.classList].filter((c) => !RESERVED_CLASSES.has(c)),
          renderHTML: (a) => (a.classes?.length ? { class: a.classes.join(' ') } : {}),
        },
        style: {
          default: null as string | null,
          parseHTML: (el) => el.getAttribute('style'),
          renderHTML: (a) => (a.style ? { style: a.style } : {}),
        },
        id: {
          default: null as string | null,
          parseHTML: (el) => el.getAttribute('id'),
          renderHTML: (a) => (a.id ? { id: a.id } : {}),
        },
        attributes: {
          default: {} as Record<string, string>,
          parseHTML: (el) => Object.fromEntries(
            [...el.attributes].filter((x) => SAFE_ATTR.test(x.name)).map((x) => [x.name, x.value])),
          renderHTML: (a) => a.attributes ?? {},
        },
      },
    }];
  },
});

### 3.6 Document and page nodes

  web/src/editor/schema/nodes/page.tsCopy
import { Node, mergeAttributes } from '@tiptap/core';

export const HbDocument = Node.create({ name: 'doc', topNode: true, content: 'page+' });

export type PageKind = 'manual' | 'auto';   // manual starts a section; auto is created by pagination

export interface PageObject {                // absolutely positioned; never part of the text flow
  id: string;
  kind: 'image' | 'text';
  classes: string[];                         // e.g. banner, logo, artist, watercolor4
  style: string;                             // includes position:absolute and offsets
  src?: string;
  text?: string;
}

// Section settings: copied from a manual page to the auto pages that follow it
// (kept in sync by an appendTransaction in commands/sections.ts).
export const SECTION_ATTRS = ['columns', 'pageNumber', 'footer', 'classes', 'style'] as const;

export const Page = Node.create({
  name: 'page',
  content: 'block+',
  isolating: true,        // default Backspace/Delete never cross a page; commands/continuation.ts does it
  defining: true,

  addAttributes() {
    return {
      pid:        { default: null as string | null },    // stable id, assigned by an appendTransaction
      kind:       { default: 'manual' as PageKind },
      columns:    { default: null as 1 | 2 | null },     // null = let the theme decide
      markers:    { default: [] as string[] },           // frontCover, insideCover, partCover, backCover,
                                                         // skipCounting, resetCounting (never inherited)
      pageNumber: { default: false },
      footer:     { default: null as string | null },
      objects:    { default: [] as PageObject[] },
      oversized:  { default: false, rendered: false },   // set by pagination, not saved meaningfully
    };
  },

  parseHTML() {
    return [{
      tag: 'div.page',
      contentElement: '.columnWrapper',
      getAttrs: (el) => ({
        kind: el.getAttribute('data-kind') ?? 'manual',
        markers: JSON.parse(el.getAttribute('data-markers') ?? '[]'),
        objects: JSON.parse(el.getAttribute('data-objects') ?? '[]'),
        footer: el.getAttribute('data-footer'),
        pageNumber: el.hasAttribute('data-page-number'),
      }),
    }];
  },

  // Used for static HTML export and clipboard. The editor uses PageView (same DOM shape).
  renderHTML({ node, HTMLAttributes }) {
    const a = node.attrs;
    return ['div',
      mergeAttributes(HTMLAttributes, {
        class: ['page', a.columns === 1 ? 'hb-cols-1' : null, a.columns === 2 ? 'hb-cols-2' : null]
          .filter(Boolean).join(' '),
        'data-kind': a.kind,
      }),
      ...a.markers.map((m: string) => ['span', { class: `inline-block ${m}` }]),
      ...a.objects.map((o: PageObject) => o.kind === 'image'
        ? ['img', { class: o.classes.join(' '), style: o.style, src: o.src, alt: '' }]
        : ['span', { class: ['inline-block', ...o.classes].join(' '), style: o.style }, o.text ?? '']),
      ...(a.footer ? [['span', { class: 'inline-block footnote' }, a.footer]] : []),
      ...(a.pageNumber ? [['span', { class: 'inline-block pageNumber auto' }]] : []),
      ['div', { class: 'columnWrapper' }, 0],
    ];
  },
});

### 3.7 Schema manifest

  web/scripts/schema-manifest.tsCopy
// Runs before `vite build`. The server validates saved documents against this file,
// so the client schema is the single source of truth.
import { getSchema } from '@tiptap/core';
import { writeFileSync } from 'node:fs';
import { schemaExtensions } from '../src/editor/schema';   // schema only, no NodeViews or DOM imports

const schema = getSchema(schemaExtensions);
const describe = (t: { spec: { attrs?: object; content?: string; group?: string } }) => ({
  attrs: Object.keys(t.spec.attrs ?? {}),
  content: t.spec.content ?? null,
  group: t.spec.group ?? null,
});
const manifest = {
  version: 1,
  nodes: Object.fromEntries(Object.entries(schema.nodes).map(([n, t]) => [n, describe(t)])),
  marks: Object.fromEntries(Object.entries(schema.marks).map(([n, t]) => [n, describe(t)])),
};
writeFileSync(new URL('../../shared/schema-manifest.json', import.meta.url), JSON.stringify(manifest, null, 2));

## §4Automatic pagination

  This is the riskiest and most valuable part of the project. The paginator is a ProseMirror plugin. After each change it measures the rendered pages and moves page boundaries until every page fits. It runs in requestAnimationFrame, before paint, so a line that overflows while you type has already moved when the frame is drawn.

### 4.1 Sections and pages

    - A manual page starts a section: Mod-Enter, a cover page, or an imported \page. Content never flows across a manual page boundary.

    - Auto pages are created and removed only by the paginator. They copy the section's columns, pageNumber, footer, classes and style (SECTION_ATTRS). An appendTransaction keeps the copies in sync when the section's first page changes.

    - Markers such as frontCover and page objects belong to one page and are never copied.

    - Saved JSON includes auto pages, so share pages render without waiting. On load the paginator re-checks every page and changes only what differs, for example after a font or theme update.

### 4.2 Layout assumptions

  The paginator relies on these. Each one has a test in §4.11.

    - .page has a fixed size and overflow: clip. .columnWrapper is a multi-column container with a constrained height and column-fill: auto. Content that doesn't fit forms extra columns to the right of the content box, where it is clipped.

    - 1-column sections still render as a multi-column container (.hb-cols-1 { column-count: 1 }), so overflow behaves the same way. Measurements read the computed column-count, because theme rules like .page:has(.frontCover) { columns: 1 } change it.

    - Theme break-inside: avoid rules (.block, table, blockquote, li in Blank style.less:24-29, 145-160) decide which blocks move whole.

    - Don't port upstream's trailing &nbsp;\column&nbsp; hack (brewRenderer.jsx:216-217). It was added for old Chrome builds. S2 confirms that current Chrome and Firefox fill column 1 first with column-fill: auto.

    - In the editor, override .page { content-visibility: visible }. The theme's auto skips layout for offscreen pages, which would make measurements wrong.

### 4.3 Detecting overflow

    [figure]

    Page 3 is full, so the last three lines of the paragraph land in a third column that is clipped and never painted. The paginator finds the first position outside the content box and moves the page boundary there. Those lines become a continuation paragraph at the top of page 4.

    - Take the content box of the page's .columnWrapper, without padding.

    - Walk its top-level children in order, skipping absolutely positioned and hidden ones.

    - Read getClientRects() for each child. A block split across columns returns one rect per fragment.

    - The first fragment whose left edge is past the box's right edge sits in an overflow column. A fragment whose bottom is past the box's bottom is taller than a column. Either one means overflow.

  web/src/editor/pagination/measure.tsCopy
import type { EditorView } from '@tiptap/pm/view';
import type { PageRef } from './boundary';

export interface PageMeasure {
  box: DOMRect;                     // content box of .columnWrapper (padding excluded)
  columns: number;                  // computed column-count (themes and :has() rules can change it)
  overflow: boolean;
  first?: { index: number; el: HTMLElement; rect: DOMRect }; // first flow block with a fragment outside
  freeSpace: number;                // px free at the bottom of the last used column, plus empty columns
}

export const EPS = 0.5;

export function measurePage(view: EditorView, page: PageRef): PageMeasure {
  const pageEl = view.nodeDOM(page.pos) as HTMLElement;
  const wrap = pageEl.querySelector<HTMLElement>(':scope > .columnWrapper')!;
  const box = contentBox(wrap);
  const columns = Math.max(1, parseInt(getComputedStyle(wrap).columnCount) || 1);
  const colWidth = box.width / columns;
  let lastCol = 0, lastBottom = box.top;

  const blocks = Array.from(wrap.children) as HTMLElement[];
  for (let index = 0; index < blocks.length; index++) {
    const el = blocks[index];
    if (isOutOfFlow(el)) continue;                       // position:absolute/fixed, display:none
    for (const rect of Array.from(el.getClientRects())) { // one rect per column fragment
      const pastRight = rect.left >= box.right - EPS;     // landed in an overflow column (clipped)
      const pastBottom = rect.bottom > box.bottom + EPS;  // taller than the column itself
      if (pastRight || pastBottom) return { box, columns, overflow: true, first: { index, el, rect }, freeSpace: 0 };
      const col = Math.min(columns - 1, Math.floor((rect.left - box.left + EPS) / colWidth));
      if (col > lastCol) { lastCol = col; lastBottom = rect.bottom; }
      else if (col === lastCol) lastBottom = Math.max(lastBottom, rect.bottom);
    }
  }
  // Column-spanning (.wide) blocks make lower column rows shorter, so this over-estimates.
  // That is safe: an over-eager pull is cut again on the next pass.
  const freeSpace = (box.bottom - lastBottom) + (columns - 1 - lastCol) * box.height;
  return { box, columns, overflow: false, freeSpace };
}

// Height the first block of `next` needs on this page: two lines for a paragraph
// (orphans/widows default to 2), the whole block otherwise.
export function firstUnitHeight(view: EditorView, next: PageRef): number {
  const el = (view.nodeDOM(next.pos) as HTMLElement)
    .querySelector<HTMLElement>(':scope > .columnWrapper > *');
  if (!el) return Infinity;
  const cs = getComputedStyle(el);
  const margin = parseFloat(cs.marginTop) || 0;
  if (el.tagName === 'P') return margin + 2 * (parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2);
  return margin + el.getBoundingClientRect().height;
}

function contentBox(el: HTMLElement): DOMRect {
  const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
  const scale = r.width / el.offsetWidth || 1;          // canvas zoom uses transform: scale()
  const px = (v: string) => (parseFloat(v) || 0) * scale;
  return new DOMRect(
    r.left + px(cs.paddingLeft), r.top + px(cs.paddingTop),
    r.width - px(cs.paddingLeft) - px(cs.paddingRight),
    r.height - px(cs.paddingTop) - px(cs.paddingBottom));
}

function isOutOfFlow(el: HTMLElement) {
  const cs = getComputedStyle(el);
  return cs.position === 'absolute' || cs.position === 'fixed' || cs.display === 'none';
}

### 4.4 Choosing the cut

     |  | First overflowing block | Cut position | Reason

       | Paragraph whose first fragment fits | Start of its first line outside the box, found by binary search with coordsAtPos | Text flows line by line

       | Bullet, ordered or definition list | Before the first item outside the box | li is break-inside: avoid

       | Anything with a heading directly before the cut | Move the cut above the heading | Headings stay with their text

       | Theme block, table, blockquote, code, TOC, raw HTML | Before the block | These are break-inside: avoid

       | The cut would be at the page's first block | None: flag the page oversized | Moving it would loop forever

  RuleFind text positions with view.coordsAtPos, not posAtCoords. Overflow columns are clipped, and hit-testing APIs such as caretPositionFromPoint can't see clipped or offscreen content. coordsAtPos reads layout, so it works there.

  web/src/editor/pagination/cut.tsCopy
import type { EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { EPS, type PageMeasure } from './measure';
import type { PageRef } from './boundary';

// Where page i must end: a doc position, or null when nothing can move
// (the first block alone is taller than a column).
export function chooseCut(view: EditorView, page: PageRef, m: PageMeasure): number | null {
  const { index, el } = m.first!;
  const child = page.node.child(index);
  const childPos = page.contentStart + offsetOf(page.node, index);   // position before the block
  const firstFragment = el.getClientRects()[0];
  const startsInside = firstFragment.left < m.box.right - EPS && firstFragment.bottom <= m.box.bottom + EPS;

  let cut = childPos;                                                 // default: move the whole block
  if (startsInside && child.type.name === 'paragraph') {
    cut = firstPosOutside(view, childPos + 1, childPos + child.nodeSize - 1, m.box);
  } else if (startsInside && isSplittableList(child)) {
    cut = firstItemOutside(view, child, childPos, m.box);             // position before that li / dt
  }
  cut = keepWithNext(page.node, page.contentStart, cut);              // don't strand a heading at the bottom
  return cut <= page.contentStart ? null : cut;
}

// Binary search over text positions with coordsAtPos. It is layout-based, so it works on
// clipped overflow columns. posAtCoords would not: hit-testing ignores clipped content.
function firstPosOutside(view: EditorView, from: number, to: number, box: DOMRect): number {
  let lo = from, hi = to;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const c = view.coordsAtPos(mid, 1);
    if (c.left >= box.right - EPS || c.top >= box.bottom - EPS) hi = mid; else lo = mid + 1;
  }
  return lo;   // first character of the first line that doesn't fit = a line start
}

const isSplittableList = (n: PMNode) =>
  ['bulletList', 'orderedList', 'definitionList'].includes(n.type.name) && n.childCount > 1;

function firstItemOutside(view: EditorView, list: PMNode, listPos: number, box: DOMRect): number {
  let pos = listPos + 1;
  for (let i = 0; i < list.childCount; i++) {
    const r = (view.nodeDOM(pos) as HTMLElement).getBoundingClientRect();
    if (r.left >= box.right - EPS || r.bottom > box.bottom + EPS) return i === 0 ? listPos : pos;
    pos += list.child(i).nodeSize;
  }
  return listPos + list.nodeSize;   // unreachable when the list overflowed
}

// If the block right before the cut is a heading, move the cut above it.
function keepWithNext(page: PMNode, contentStart: number, cut: number): number {
  let pos = contentStart;
  for (let i = 0; i < page.childCount; i++) {
    const n = page.child(i), end = pos + n.nodeSize;
    if (end === cut && n.type.name === 'heading') return pos;
    if (end >= cut) break;
    pos = end;
  }
  return cut;
}

function offsetOf(parent: PMNode, index: number) {
  let off = 0;
  for (let i = 0; i < index; i++) off += parent.child(i).nodeSize;
  return off;
}

### 4.5 Moving the boundary

  Pagination changes the document in exactly two ways: it splits a page (creating an auto page), or it joins two pages and splits them again at a new position. Both are ProseMirror join and split steps.

  What moveBoundary does to the documentCopy
before   page 3        [ H · P · C(lines 1-9) ]       page 4 (auto) [ D · E ]
                                   lines 7-9 sit in the clipped overflow column

join     page 3        [ H · P · C(lines 1-9) · D · E ]                     tr.join(boundary)

split    page 3        [ H · P · C(lines 1-6) ]       page 4 (auto) [ C′(lines 7-9) · D · E ]
                                                      tr.split(cut, 2, [page, paragraph{continuation}])

pull     the same two steps with the cut placed later: join, then split after D

  RuleNever implement a page move as delete + insert. Join and split steps map every position continuously, so the caret stays in the text being moved. prosemirror-history rebases its undo stack through non-history steps, and a delete would mark the moved text as removed, so the user's undo steps for that text would be dropped.

  web/src/editor/pagination/boundary.tsCopy
import type { Transaction } from '@tiptap/pm/state';
import type { Node as PMNode, Attrs } from '@tiptap/pm/model';
import { canJoin } from '@tiptap/pm/transform';
import { SECTION_ATTRS } from '../schema/nodes/page';

// The only two ways pagination changes the document. Both are join/split steps, so the
// caret and the undo history map through them. A delete+insert "move" would make
// prosemirror-history drop the user's undo steps for the moved text.

export interface PageRef { node: PMNode; pos: number; contentStart: number; index: number }

export function pageAt(doc: PMNode, index: number): PageRef | null {
  if (index < 0 || index >= doc.childCount) return null;
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return { node: doc.child(index), pos, contentStart: pos + 1, index };
}

export const endOfFirstBlock = (p: PageRef) => p.contentStart + p.node.child(0).nodeSize;

// New auto page after page i, starting at `cut`.
export function insertAutoPageAt(tr: Transaction, i: number, cut: number) {
  const src = pageAt(tr.doc, i)!;
  splitToPage(tr, cut, autoPageAttrs(src.node.attrs));
}

// Make page i end at `cut` by joining page i+1 into it and splitting again.
//   before  page i [ A B C(1-9) ]    page i+1 auto [ D E ]
//   join    page i [ A B C(1-9) D E ]
//   split   page i [ A B C(1-6) ]    page i+1 auto [ C′(7-9) D E ]
export function moveBoundary(tr: Transaction, i: number, cut: number) {
  const a = pageAt(tr.doc, i)!, b = pageAt(tr.doc, i + 1)!;
  const keep = b.node.attrs;                        // pid, objects, section attrs of the second page
  const boundary = a.pos + a.node.nodeSize;
  const stepsBefore = tr.steps.length;
  tr.join(boundary);                                // </page><page> removed
  const seam = boundary - 1;                        // between A's last block and B's first block
  const after = tr.doc.resolve(seam).nodeAfter;
  if (after?.attrs.continuation && canJoin(tr.doc, seam)) tr.join(seam);   // C + C′ → one paragraph again
  const mapped = tr.mapping.slice(stepsBefore).map(cut);
  const joined = pageAt(tr.doc, i)!;
  if (mapped >= joined.pos + joined.node.nodeSize - 1) {
    // Everything now fits on page i. If the removed page carried objects, keep it alive
    // with an empty paragraph so images placed on it don't vanish.
    if (keep.objects.length) {
      const para = tr.doc.type.schema.nodes.paragraph.create();
      tr.insert(joined.pos + joined.node.nodeSize, tr.doc.type.schema.nodes.page.create(keep, para));
    }
    return;
  }
  splitToPage(tr, mapped, keep);
}

// Split every level from the cut up to the page. Outermost type first.
function splitToPage(tr: Transaction, cut: number, pageAttrs: Attrs) {
  const $cut = tr.doc.resolve(cut);
  const typesAfter = [{ type: $cut.node(1).type, attrs: pageAttrs }];
  for (let d = 2; d <= $cut.depth; d++) {
    const n = $cut.node(d);
    typesAfter.push({ type: n.type, attrs: continuationAttrs(n, $cut.index(d)) });
  }
  tr.split(cut, $cut.depth, typesAfter);
}

function continuationAttrs(n: PMNode, splitIndex: number): Attrs {
  if (n.type.name === 'orderedList') return { ...n.attrs, continuation: true, start: (n.attrs.start ?? 1) + splitIndex };
  return { ...n.attrs, continuation: true, id: null };   // ids stay on the first fragment
}

function autoPageAttrs(src: Attrs): Attrs {
  const inherited = Object.fromEntries(SECTION_ATTRS.map((k) => [k, src[k]]));
  return { ...inherited, kind: 'auto', pid: null, id: null, attributes: {}, markers: [], objects: [], oversized: false };
}

### 4.6 One step: overflow, underflow, settled

  Each step settles one page. On overflow it pushes content forward. On underflow it pulls the next auto page's first block back and re-measures. A pull that doesn't fit is cut again on the next step, so a wrong free-space estimate costs a little work or leaves a small gap, and never causes an endless loop.

  web/src/editor/pagination/step.tsCopy
import type { EditorView } from '@tiptap/pm/view';
import type { Transaction } from '@tiptap/pm/state';
import { measurePage, firstUnitHeight } from './measure';
import { chooseCut } from './cut';
import { pageAt, moveBoundary, insertAutoPageAt, endOfFirstBlock } from './boundary';
import { PAGINATE, type PaginationState } from './plugin';

// One unit of work: settle page i, then say which page to look at next.
export function paginatePage(view: EditorView, st: PaginationState): Transaction {
  const i = st.dirtyFrom!;
  const { state } = view;
  const tr = state.tr.setMeta('addToHistory', false);
  const done = (dirtyFrom: number | null, dirtyTo = st.dirtyTo) =>
    tr.setMeta(PAGINATE, { dirtyFrom, dirtyTo });

  const page = pageAt(state.doc, i);
  if (!page) return done(null);
  const next = pageAt(state.doc, i + 1);
  const m = measurePage(view, page);

  // 1. Overflow: push everything after the cut onto the next page.
  if (m.overflow) {
    const cut = chooseCut(view, page, m);
    if (cut === null) {                                   // one unsplittable block taller than a column
      if (!page.node.attrs.oversized) tr.setNodeAttribute(page.pos, 'oversized', true);
      return done(next ? i + 1 : null);
    }
    if (next?.node.attrs.kind === 'auto') moveBoundary(tr, i, cut);   // join i+1 into i, split at cut
    else insertAutoPageAt(tr, i, cut);                                 // new auto page after i
    return done(i + 1, Math.max(st.dirtyTo, i + 1));
  }
  if (page.node.attrs.oversized) tr.setNodeAttribute(page.pos, 'oversized', false);

  // 2. Underflow: pull the next auto page's first block back. The next pass re-measures
  //    page i; if the pulled block doesn't fit, step 1 cuts it and we move on, so this
  //    can't oscillate. A conservative estimate only costs a small gap, never a loop.
  if (next?.node.attrs.kind === 'auto' && m.freeSpace >= firstUnitHeight(view, next)) {
    moveBoundary(tr, i, endOfFirstBlock(next));
    return done(i);
  }

  // 3. Settled. Later pages only need work if user edits reached them.
  return done(i + 1 <= st.dirtyTo && next ? i + 1 : null);
}

### 4.7 Scheduling and triggers

  web/src/editor/pagination/plugin.tsCopy
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { paginatePage } from './step';

export interface PaginationState {
  dirtyFrom: number | null;   // next page index to check; null = settled
  dirtyTo: number;            // last page index touched by non-pagination changes
}
export const paginationKey = new PluginKey<PaginationState>('hbPagination');
export const PAGINATE = 'hbPaginate';          // meta on every pagination transaction
export const REPAGINATE = 'hbRepaginate';      // meta: force a check from page N (fonts, theme, CSS, images)

export const isSettled = (s: EditorView['state']) => paginationKey.getState(s)?.dirtyFrom === null;

export function paginationPlugin(opts: { budgetMs: number; isReady: () => boolean }) {
  return new Plugin<PaginationState>({
    key: paginationKey,
    state: {
      init: (_, state) => ({ dirtyFrom: 0, dirtyTo: state.doc.childCount - 1 }), // verify stored layout on load
      apply(tr, prev) {
        const own = tr.getMeta(PAGINATE) as PaginationState | undefined;
        if (own) return own;
        const forced = tr.getMeta(REPAGINATE) as number | undefined;
        if (!tr.docChanged && forced === undefined) return prev;
        const [a, b] = forced !== undefined ? [forced, tr.doc.childCount - 1] : changedPages(tr);
        const from = Math.max(0, a - 1);                            // the previous page may now underflow
        return {
          dirtyFrom: prev.dirtyFrom === null ? from : Math.min(prev.dirtyFrom, from),
          dirtyTo: Math.max(prev.dirtyTo, b),
        };
      },
    },
    view: (view) => new PaginationScheduler(view, opts),
  });
}

class PaginationScheduler {
  private raf = 0;
  constructor(private view: EditorView, private opts: { budgetMs: number; isReady: () => boolean }) {
    this.schedule();
  }
  update() { if (!isSettled(this.view.state)) this.schedule(); }
  destroy() { cancelAnimationFrame(this.raf); }

  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.run(); });
  }

  // Runs before paint, so a line that overflows while typing is moved before anyone sees it.
  private run() {
    const { view } = this;
    if (view.composing || !this.opts.isReady()) return this.schedule();   // IME, fonts not loaded
    const deadline = performance.now() + this.opts.budgetMs;              // ~8 ms
    for (let guard = 0; guard < 1000 && performance.now() < deadline; guard++) {
      const st = paginationKey.getState(view.state)!;
      if (st.dirtyFrom === null) return;
      view.dispatch(paginatePage(view, st));   // DOM updates synchronously; the next measure sees it
    }
    this.schedule();                            // budget spent: continue next frame
  }
}

// Page indexes (in the final doc) touched by a user transaction.
function changedPages(tr: Transaction): [number, number] {
  let min = Infinity, max = -Infinity;
  tr.mapping.maps.forEach((map, i) => map.forEach((_f, _t, newFrom, newTo) => {
    const rest = tr.mapping.slice(i + 1);
    min = Math.min(min, rest.map(newFrom, -1));
    max = Math.max(max, rest.map(newTo, 1));
  }));
  if (min === Infinity) return [0, 0];
  const size = tr.doc.content.size;
  return [tr.doc.resolve(Math.min(min, size)).index(0), tr.doc.resolve(Math.min(max, size)).index(0)];
}

     |  | Trigger | Re-check from

       | User transaction | The page before the first changed page

       | document.fonts.ready, then each loadingdone event | Page 0

       | Image load (capturing listener on the editor root) | That image's page

       | Theme change or user CSS change (debounced 300 ms) | Page 0

       | Section settings change (columns, footer, page number) | The section's first page

       | Page added or removed, with a theme that styles odd and even pages differently (Journal) | Continue to the last page

    - Pagination transactions carry addToHistory: false and the PAGINATE meta, so autosave's dirty flag ignores them.

    - Nothing is restructured while view.composing is true (IME input) or before fonts are ready.

    - Autosave waits for isSettled(state).

    - Configure TipTap with shouldRerenderOnTransaction: false and use selectors in React, so pagination transactions don't re-render the toolbar.

### 4.8 Editing across boundaries

  web/src/editor/commands/continuation.ts (behaviour spec)Copy
// A paragraph split by pagination is one paragraph to the author. Keyboard behaviour at
// the seam must match an unsplit paragraph. Pages are `isolating`, so these commands are
// the only way edits cross a page boundary.
//
// Backspace at the start of a continuation fragment
//   → delete the last character of the previous fragment (same as mid-paragraph).
// Delete at the end of a fragment whose next sibling is a continuation
//   → delete the first character of the continuation.
// ArrowRight at the end of a fragment / ArrowLeft at the start of a continuation
//   → skip the seam: land one character past it, so one key press moves one character.
// Enter at a seam → ordinary paragraph split; the new paragraph is not a continuation.
// Backspace at the start of the first block of an AUTO page (no continuation)
//   → join the two pages, then run joinBackward. Pagination re-splits afterwards.
// Backspace at the start of a MANUAL page
//   → set kind = 'auto' (removes the section break); pagination pulls content back.
// Selecting across pages and deleting: default ProseMirror behaviour, then pagination settles.

### 4.9 Page objects

  Absolutely positioned content lives in page.attrs.objects: cover art, .banner, .logo, .artist, watercolor stains, and images with position:absolute. PageView renders objects inside .page but outside .columnWrapper, so selectors such as .page .footnote and .page:has(.frontCover) .banner still match. Objects take no part in the flow, so the paginator never moves them.

    - Selecting and moving: click to select, drag to move (updates top/left in style), use handles to resize, and nudge with the arrow keys.

    - Editing: double-click a text object to edit it in place. The NodeView's stopEvent and ignoreMutation keep ProseMirror out of it, and changes commit with setNodeAttribute. Classes and style are edited in the inspector.

    - Section chrome: the page number and footer are section settings, rendered the same way on every page of the section.

    - Deletion: a page that carries objects is never deleted by a pull. If it empties, it keeps one empty paragraph.

### 4.10 Performance and limits

    - Each page costs one measurement. A page whose boundary moves also costs one dispatch with two steps. The budget is 8 ms per frame. The page being typed on is the first dirty page, so it settles in the same frame as the keystroke.

    - An edit near the start of a long section shifts every later boundary in that section, as in a word processor. The pass stops at the first unchanged page after dirtyTo. Manual breaks, such as chapters, limit how far the work spreads.

    - Targets for P8.1: typing latency on the visible page under 16 ms at p95, and typing on page 1 of a 50-page section settling within 1 s.

    - Real-time co-editing (Yjs) would conflict with every client repaginating the document. It would need a single paginating writer or a view-only pagination layer. It is out of scope.

### 4.11 Test matrix

     |  | Case | Expected

       | Type at the end of a full 2-column page | The last line moves to the next page before paint, and the caret follows it

       | Delete a paragraph on page 1 of a 3-page section | Content pulls back; empty auto pages disappear

       | Undo and redo after a split | Text is restored, and pages settle to the same layout as before

       | Edit the first half of a paragraph split across pages | The fragments re-join and re-split at the new line

       | Ordered list split across pages | The continuation list starts at the correct number

       | Heading on the last line of a page | The heading moves with the paragraph after it

       | Stat block taller than a column | Page flagged oversized, nothing moves, warning shown

       | 1-column section followed by a 2-column section | Content never crosses the manual boundary

       | Cover page (frontCover marker) | The theme switches the page to 1 column, and measurement follows the computed column count

       | .wide block in the middle of a 2-column page | Overflow is detected below the spanner; the block moves whole if it doesn't fit

       | IME composition at the end of a page | No restructuring until compositionend

       | Web font loads late | Full repagination after loadingdone, and no visible jump once settled

       | Canvas zoom at 50%, 100% and 200% | Same page boundaries at every zoom level

       | Fuzz: 1,000 random edits on a 20-page document | No page overflows, and no pass hits the loop guard

## §5Canvas, themes and CSS

    - DOM. The structure is div.hb-canvas[lang] › div.pages.ProseMirror › div.page. The ProseMirror root holds only page elements, so :nth-child(even) rules count correctly.

    - Static themes. The build emits style.css (used for export) and style.scoped.css, prefixed with .hb-canvas by postcss-prefix-selector. It rewrites :root, html and body to .hb-canvas, so theme variables and counter-reset: page-numbers land on the canvas.

    - User CSS and user themes are scoped at runtime with the CSSOM (below) and applied through document.adoptedStyleSheets, after the theme chain. Every change triggers repagination from page 0.

    - App chrome uses CSS modules only. No global element selectors, so nothing leaks into pages.

    - Zoom. Apply transform: scale(z) to .hb-canvas, with an outer sizer (ResizeObserver) that provides the scaled height. Don't use CSS zoom as upstream does (brewRenderer.jsx:309); it distorts caret coordinates. Pagination compares rects in one coordinate space, so scaling doesn't change page boundaries.

    - Spreads. Port the single, facing and flow layouts from legacy/client/homebrew/brewRenderer/brewRenderer.less:9-39.

    - Print. @media print hides the app chrome and removes the transform. Theme @page rules set the paper size. Wait for images before printing, as printCurrentBrew does (legacy/shared/helpers.js:117-147).

  web/src/editor/canvas/cssScope.tsCopy
// User CSS and user-theme CSS only apply inside the canvas. Static themes get the same
// rewrite at build time (web/vite/scopeThemes.ts, postcss-prefix-selector).
const ROOT = /^(:root|html|body)(?=$|[\s.:#[>+~])/;

export function scopeCss(css: string, baseURL: string, scope = '.hb-canvas'): CSSStyleSheet {
  const sheet = new CSSStyleSheet({ baseURL });   // relative url() resolve against the source
  sheet.replaceSync(css);                          // @import is ignored in constructed sheets
  rewrite(sheet.cssRules, scope);
  return sheet;                                    // attach via document.adoptedStyleSheets
}

function rewrite(rules: CSSRuleList, scope: string) {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSStyleRule) {
      // Naive comma split. Swap in postcss-selector-parser if users write :is(a, b).
      rule.selectorText = rule.selectorText.split(',').map((s) => s.trim())
        .map((s) => (ROOT.test(s) ? s.replace(ROOT, scope) : `${scope} ${s}`)).join(', ');
    } else if ('cssRules' in rule) {
      rewrite((rule as CSSGroupingRule).cssRules, scope);   // @media, @supports, @layer, @container
    }                                                       // @font-face, @page, @keyframes untouched
  }
}

## §6Editor features

### 6.1 Keyboard

  Carried over from legacy/client/components/codeEditor/extensions/customKeyMaps.js:235-273.

     |  | Keys | Today (markdown) | New command

       | Mod-B Mod-I Mod-U | ** * <u> | toggleBold, toggleItalic, toggleUnderline

       | Shift-Mod-= / Mod-= | ^sup^ / ^^sub^^ | toggleSuperscript / toggleSubscript

       | Mod-. | :> non-breaking space | insert U+00A0

       | Shift-Mod-. / Shift-Mod-, | add or remove spacing | widen or narrow an inlineBox spacer

       | Mod-M | {{class text}} | apply a span mark (class picker)

       | Shift-Mod-M | {{class block }} | wrap the selection in a themeBlock (class picker)

       | Mod-/ | HTML comment | none (the document model has no comments)

       | Mod-K | link | link dialog

       | Mod-L / Shift-Mod-L | bullet / numbered list | toggleBulletList / toggleOrderedList

       | Shift-Mod-1…6 | #…###### | toggleHeading(level)

       | Mod-Enter | \page | manual page break (starts a section)

       | Shift-Mod-Enter | \column | insert columnBreak

       | Mod-Z Mod-Shift-Z Mod-Y | undo / redo | undo / redo

       | Tab / Shift-Tab | indent | sink or lift a list item

       | Mod-S / Mod-P | save / print | save now / print

### 6.2 Toolbar and panels

    - Toolbar: block type, marks, alignment, lists, Insert menu, page break, column break, undo and redo, zoom, spread, save status.

    - Inspector (right):

        - For the selected node: classes (suggested from the class names in the active theme's stylesheets), style, id and attributes.

        - For a page: section settings (columns 1 or 2, page number, footer, classes), markers (cover type, skip or reset counting), and objects.

    - Outline (left): headings and pages from the document, with the labels from headerNav.jsx:20-37. Clicking scrolls to the item.

    - Style drawer: a CodeMirror 6 CSS editor with Prettier formatting (the cssKeymap from customKeyMaps.js).

### 6.3 Snippets

  web/src/editor/snippets/insertSnippet.tsCopy
// Theme snippet generators (themes/V3/*/snippets.js, *.gen.js) still return Homebrewery
// markdown. Render it with the same engine upstream uses and let the schema's parse rules
// turn the HTML into nodes. No generator has to change.
import { hbfm } from 'marked-hbfm';
import type { Editor } from '@tiptap/core';
import { sanitizeImportHtml } from '../import/sanitize';
import { hbfmToDoc } from '../import/hbfmToDoc';

export interface SnippetContext {
  brew: { shareId: string; title: string; theme: string; renderer: 'V3' };
  cursorPos: number;
}

export async function insertSnippet(
  editor: Editor, gen: string | ((ctx: SnippetContext) => string), ctx: SnippetContext,
) {
  const markdown = typeof gen === 'function' ? gen(ctx) : gen;
  if (/^\\page\b/m.test(markdown)) {
    // Cover pages and other multi-page snippets become new manual pages after the current page.
    const { doc } = await hbfmToDoc(markdown);
    return editor.commands.insertPagesAfterSelection(doc.content);
  }
  // Note: hbfm keeps module-level state (variables, heading slugs). Heading ids are
  // re-assigned by the headingIds plugin after insertion, so collisions don't matter.
  const html = sanitizeImportHtml(hbfm.render(markdown, 0));
  editor.chain().focus().insertContent(html).run();
}

    - The Insert menu is built from the same theme snippet arrays. Port compileSnippets from snippetbar.jsx:127-155 for parent-to-child merging.

    - Style-view snippets insert into the Style drawer.

    - Some snippets become native features:

        - Table of Contents → live toc node.

        - Page numbering → section setting.

        - Footer → section setting. The upstream footer generator is broken anyway (footer.gen.js:9 calls an undefined Markdown).

    - User snippets (\snippet name bodies) are HBFM and go through the same pipeline.

### 6.4 Theme blocks

  The themeBlock NodeView adds a small non-editable label (“Stat block”, “Note”, “Class table”) with toggles for wide and frame. The content stays ordinary nodes, so text editing works as usual. CSS that depends on structure, such as .monster hr ~ dl, keeps working while users edit inside the generated structure. A form-based stat block editor is optional later work.

### 6.5 Live table of contents

  The toc node:

    - collects headings in document order;

    - skips headings whose computed --TOC is exclude or whose level is deeper than depth;

    - takes page numbers from page indexes, with skip and reset counting;

    - renders the same div.block.toc › ul › li › a › span + span as upstream's generator, so the theme's dot leaders apply;

    - refreshes after pagination settles.

### 6.6 Images, tables, icons

    - Images are inline nodes that store their natural width and height, rendered with aspect-ratio so layout doesn't jump on load. They keep --HB_src for .wrapLeft and .wrapRight. “Place freely” converts an image into a page object.

    - Tables use the TipTap table extension with colspan, rowspan, column widths and header rows. Table classes (classTable, frame, decoration, wide) are set in the inspector.

    - Icons have a picker and : autocomplete, using the name maps in themes/fonts/iconFonts/*.js.

## §7Importing markdown brews

  Existing brews, pasted markdown and snippet output all enter through one converter. It uses marked-hbfm, the engine upstream renders with, and lets the schema's parse rules turn HTML into nodes.

    - Split metadata, CSS and body with a TypeScript port of splitTextStyleAndMetadata (legacy/shared/helpers.js:88-115).

    - Reject renderer: legacy.

    - Split pages with the V3 regex, and read \page {…} attributes with the hbfm lexer.

    - Render every page twice with hbfm.render. Cross-page variables resolve only on the second pass.

    - Sanitize with DOMPurify, then wrap each page in div.page › div.columnWrapper.

    - Mount the pages in a hidden probe canvas with the brew's theme and CSS, and wait for fonts.

    - Lift out the page-level pieces:

        - marker spans;

        - top-level footer and page-number spans;

        - positioned objects (computed position: absolute, with the page as containing block);

        - <style> tags.

    - Run generateJSON with the schema's parse rules.

    - Pages that came from \page become manual pages. Pagination then runs, so content that upstream clipped now flows onto new auto pages.

    - Show the import report.

  web/src/editor/import/hbfmToDoc.tsCopy
import { hbfm } from 'marked-hbfm';
import { generateJSON, type JSONContent } from '@tiptap/core';
import { splitTextStyleAndMetadata } from './brewText';   // TS port of legacy/shared/helpers.js:88
import { sanitizeImportHtml } from './sanitize';          // DOMPurify with the schema's allow-list
import { ImportReport } from './importReport';
import { extensions } from '../schema';
import { mountProbe } from '../canvas/probe';             // hidden .hb-canvas with the brew's theme

const PAGE_SPLIT = /^(?=\\page(?:break)?(?: *{[^\n{}]*})?$)/m;   // legacy brewRenderer.jsx:23
const MARKERS = ['frontCover', 'insideCover', 'partCover', 'backCover', 'skipCounting', 'resetCounting'];

export async function hbfmToDoc(raw: string) {
  const brew = splitTextStyleAndMetadata({ text: raw.replaceAll('\r\n', '\n') });
  if (brew.renderer === 'legacy') throw new Error('Legacy-renderer brews are not supported.');
  const report = new ImportReport(brew.text);
  const pages = brew.text.split(PAGE_SPLIT);

  // marked-variables resolves cross-page references only after every page has rendered
  // once (upstream force-renders pages with variables on load). Render twice.
  pages.forEach((p, i) => hbfm.render(stripPageLine(p), i));
  const html = pages.map((p, i) =>
    pageShell(pageLineTags(p), sanitizeImportHtml(hbfm.render(stripPageLine(p), i)))).join('');

  // Lay the pages out with the real theme CSS so computed styles decide what is an object.
  const probe = await mountProbe(brew.theme ?? '5ePHB', brew.style ?? '');
  probe.root.innerHTML = html;
  await document.fonts.ready;
  for (const pageEl of Array.from(probe.root.querySelectorAll<HTMLElement>('.page'))) {
    liftMarkers(pageEl, MARKERS, report);    // empty marker spans → data-markers
    liftPageChrome(pageEl, report);          // top-level .footnote / .pageNumber → data-footer / data-page-number
    liftObjects(pageEl, report);             // absolutely positioned, containing block = .page → data-objects
    liftStyleTags(pageEl, brew, report);     // <style> in the body → brew.style
  }
  const doc: JSONContent = generateJSON(probe.root.innerHTML, extensions);
  probe.dispose();
  report.inspect(doc);                       // rawHtml count, dropped comments, expanded variables
  return { doc, style: brew.style ?? '', meta: brew, report };
}

// `\page {classes,styles,attrs}` → the same injectedTags lexing upstream uses (brewRenderer.jsx:190-203).
function pageLineTags(pageText: string) {
  if (!pageText.startsWith('\\page')) return null;
  const tokens = hbfm.marked.lexer(pageText.split('\n', 1)[0])[0]?.tokens ?? [];
  return tokens.find((t: any) => t.injectedTags)?.injectedTags ?? null;
}
const stripPageLine = (p: string) =>
  p.startsWith('\\page') ? (p.includes('\n') ? p.slice(p.indexOf('\n') + 1) : '') : p;

### Parse rules

     |  | HTML from marked-hbfm | Becomes | Notes

       | div.page built from \page {…} | page (manual) | classes, style and attributes from the \page line

       | empty span.inline-block.frontCover and other markers | page.markers | removed from the flow

       | absolutely positioned element whose containing block is the page | page.objects | style and classes kept; text or src captured

       | top-level span.footnote, span.pageNumber | page.footer, page.pageNumber | footer text kept

       | div.columnSplit | columnBreak |

       | div.blank | spacer |

       | div.block.<cls> | themeBlock | block class dropped; re-added on render

       | span.inline-block with text | span mark |

       | span.inline-block without text | inlineBox |

       | i.df, .ei, .gi, .fas, .far, .fab | icon |

       | p[align], dl, table with spans | paragraph with align, definitionList, table |

       | svg.diagram (markdeep) | rawHtml | the ASCII source can't be recovered from HTML

       | <style> in the body | appended to the brew's CSS |

       | HTML comments | dropped | counted in the report

       | anything else | rawHtml (sanitized) | editable in a code popover

### Import report

  The report shows:

    - pages that previously clipped content, and how many pages they grew into;

    - variable definitions found (their values were inlined);

    - raw HTML nodes kept;

    - comments dropped;

    - unknown classes (not in the theme's stylesheets).

  The original text is stored in brews.source_markdown.

### Fidelity harness (S3)

    - A dev-only route, /dev/legacy-render?fixture=…, renders HBFM the upstream way (page split, hbfm.render, sanitize) with the same scoped theme CSS.

    - Playwright screenshots that route and the imported document in read-only mode, then diffs them page by page.

    - Fixtures:

        - welcome_msg.md;

        - every V3 snippet generator, with a seeded random so lodash output is stable;

        - the cases in tests/markdown.

## §8Backend (.NET 10)

### 8.1 Host

  src/Homebrewery.Api/Program.csCopy
using Homebrewery.Api.Endpoints;
using Homebrewery.Api.Infrastructure;
using Homebrewery.Core;
using Homebrewery.Data;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<AppDbContext>(o => o
    .UseNpgsql(builder.Configuration.GetConnectionString("Homebrewery"))
    .UseSnakeCaseNamingConvention());                       // EFCore.NamingConventions

builder.Services
    .AddIdentityApiEndpoints<AppUser>(o => o.User.RequireUniqueEmail = true)
    .AddRoles<IdentityRole<Guid>>()
    .AddEntityFrameworkStores<AppDbContext>();
builder.Services.ConfigureApplicationCookie(o =>
{
    o.Cookie.HttpOnly = true;          // upstream's session cookie was readable from JS; don't repeat that
    o.Cookie.SameSite = SameSiteMode.Lax;
    o.Events.OnRedirectToLogin = ctx => { ctx.Response.StatusCode = 401; return Task.CompletedTask; };
    o.Events.OnRedirectToAccessDenied = ctx => { ctx.Response.StatusCode = 403; return Task.CompletedTask; };
});
builder.Services.AddAuthorizationBuilder().AddPolicy("Admin", p => p.RequireRole("Admin"));

builder.WebHost.ConfigureKestrel(o => o.Limits.MaxRequestBodySize = 20 * 1024 * 1024);
builder.Services.AddRequestDecompression();                 // autosave sends gzip bodies
builder.Services.AddProblemDetails();
builder.Services.AddOpenApi();                              // web/ generates its client from this
builder.Services.AddRateLimiter(RateLimits.Configure);

builder.Services.AddSingleton<SchemaManifest>();            // shared/schema-manifest.json
builder.Services.AddSingleton<DocInspector>();
builder.Services.AddSingleton<ThemeCatalog>();              // wwwroot/themes/themes.json
builder.Services.AddScoped<BrewService>();
builder.Services.AddHttpClient<UpstreamImportClient>(c =>
    c.BaseAddress = new Uri("https://homebrewery.naturalcrit.com/"));

var app = builder.Build();

app.UseRequestDecompression();
app.UseDefaultFiles();
app.UseStaticFiles();                                       // Vite build output in wwwroot
app.UseAuthentication();
app.UseAuthorization();
app.UseRateLimiter();
app.UseMiddleware<SameOriginWriteGuard>();                  // 403 for POST/PUT/DELETE from another Origin

if (app.Environment.IsDevelopment()) app.MapOpenApi();

var api = app.MapGroup("/api");
api.MapGroup("/auth").MapIdentityApi<AppUser>();
api.MapAccountEndpoints();
api.MapBrewEndpoints();
api.MapThemeEndpoints();
api.MapVaultEndpoints();
api.MapUserEndpoints();
api.MapImportEndpoints();
api.MapNotificationEndpoints();
api.MapAdminEndpoints().RequireAuthorization("Admin");

app.MapGet("/share/{shareId}", ShareShell.RenderAsync);    // index.html + HTML-encoded og:* tags
app.MapFallbackToFile("index.html");

app.Run();

public partial class Program;                               // for WebApplicationFactory

### 8.2 Data model

    - Column names use snake_case via EFCore.NamingConventions.

    - Doc is a string mapped to jsonb. The server reads it only in DocInspector, which avoids a parse and re-serialize on every read.

    - Documents are compressed with lz4 TOAST compression.

    - SearchText is extracted on save and feeds a generated tsvector with the simple config, because brews are multilingual.

  src/Homebrewery.Core/Brew.cs and Data/Configurations/BrewConfiguration.csCopy
public sealed class Brew
{
    public Guid Id { get; set; } = Guid.CreateVersion7();
    public string ShareId { get; set; } = Nanoid.Generate(size: 12);   // public read link
    public string EditId { get; set; } = Nanoid.Generate(size: 12);    // edit URL id (still needs authz)
    public string Title { get; set; } = "";
    public string Description { get; set; } = "";
    public string Lang { get; set; } = "en";
    public string Theme { get; set; } = "5ePHB";            // static theme key, or a user-theme shareId
    public int DocSchemaVersion { get; set; } = 1;
    public string Doc { get; set; } = "";                   // jsonb; opaque except to DocInspector
    public string Style { get; set; } = "";                 // user CSS
    public string? Snippets { get; set; }                   // jsonb: [{ group, name, gen }]
    public string? SourceMarkdown { get; set; }             // original HBFM text when imported
    public string SearchText { get; set; } = "";            // plain text extracted from Doc, capped
    public NpgsqlTsVector SearchVector { get; set; } = null!;
    public string[] Tags { get; set; } = [];
    public int PageCount { get; set; } = 1;
    public bool Published { get; set; }
    public string? ThumbnailUrl { get; set; }
    public int Views { get; set; }
    public int Version { get; set; } = 1;                   // optimistic concurrency token
    public BrewLock? Lock { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? LastViewedAt { get; set; }
    public List<BrewAuthor> Authors { get; set; } = [];
}

public sealed class BrewAuthor
{
    public Guid BrewId { get; set; }
    public Guid UserId { get; set; }
    public AuthorRole Role { get; set; }                    // Owner, Author, Invited
    public short Position { get; set; }
}

public sealed class BrewLock
{
    public int Code { get; set; }
    public string EditMessage { get; set; } = "";
    public string ShareMessage { get; set; } = "";
    public DateTimeOffset Applied { get; set; }
    public DateTimeOffset? ReviewRequested { get; set; }
}

public sealed class BrewConfiguration : IEntityTypeConfiguration<Brew>
{
    public void Configure(EntityTypeBuilder<Brew> b)
    {
        b.HasIndex(x => x.ShareId).IsUnique();
        b.HasIndex(x => x.EditId).IsUnique();
        b.Property(x => x.Doc).HasColumnType("jsonb");
        b.Property(x => x.Snippets).HasColumnType("jsonb");
        b.Property(x => x.Version).IsConcurrencyToken();                 // UPDATE … WHERE version = @original
        b.OwnsOne(x => x.Lock, l => l.ToJson());                        // jsonb column
        b.HasIndex(x => x.Tags).HasMethod("gin");
        b.HasIndex(x => new { x.Published, x.UpdatedAt });
        b.HasGeneratedTsVectorColumn(x => x.SearchVector, "simple",
                x => new { x.Title, x.Description, x.SearchText })
         .HasIndex(x => x.SearchVector).HasMethod("gin");
        b.HasMany(x => x.Authors).WithOne().HasForeignKey(a => a.BrewId).OnDelete(DeleteBehavior.Cascade);
    }
}

  Schema the first migration should produce (review reference)Copy
CREATE TABLE brews (
  id                 uuid PRIMARY KEY,
  share_id           text NOT NULL UNIQUE,
  edit_id            text NOT NULL UNIQUE,
  title              text NOT NULL DEFAULT '',
  description        text NOT NULL DEFAULT '',
  lang               text NOT NULL DEFAULT 'en',
  theme              text NOT NULL DEFAULT '5ePHB',
  doc_schema_version int  NOT NULL DEFAULT 1,
  doc                jsonb NOT NULL,
  style              text NOT NULL DEFAULT '',
  snippets           jsonb,
  source_markdown    text,
  search_text        text NOT NULL DEFAULT '',
  search_vector      tsvector GENERATED ALWAYS AS (
                       to_tsvector('simple'::regconfig,
                         coalesce(title, '') || ' ' || coalesce(description, '') || ' ' || coalesce(search_text, ''))
                     ) STORED,
  tags               text[] NOT NULL DEFAULT '{}',
  page_count         int  NOT NULL DEFAULT 1,
  published          boolean NOT NULL DEFAULT false,
  thumbnail_url      text,
  views              int  NOT NULL DEFAULT 0,
  version            int  NOT NULL DEFAULT 1,
  lock               jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  last_viewed_at     timestamptz
);
ALTER TABLE brews ALTER COLUMN doc SET COMPRESSION lz4;      -- add via migrationBuilder.Sql(...)
CREATE INDEX ix_brews_tags             ON brews USING gin (tags);
CREATE INDEX ix_brews_search_vector    ON brews USING gin (search_vector);
CREATE INDEX ix_brews_published_updated ON brews (published, updated_at DESC);

CREATE TABLE brew_authors (
  brew_id  uuid NOT NULL REFERENCES brews(id) ON DELETE CASCADE,
  user_id  uuid NOT NULL REFERENCES asp_net_users(id) ON DELETE CASCADE,
  role     smallint NOT NULL,          -- 0 owner, 1 author, 2 invited
  position smallint NOT NULL,
  PRIMARY KEY (brew_id, user_id)
);
CREATE INDEX ix_brew_authors_user ON brew_authors (user_id);

CREATE TABLE notifications (
  id          uuid PRIMARY KEY,
  dismiss_key text NOT NULL UNIQUE,
  title       text NOT NULL,
  body        text NOT NULL,              -- plain text or a tiny doc JSON; not HBFM
  starts_at   timestamptz NOT NULL,
  stops_at    timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Later (P-later): server-side history
CREATE TABLE brew_snapshots (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brew_id    uuid NOT NULL REFERENCES brews(id) ON DELETE CASCADE,
  version    int NOT NULL,
  doc        jsonb NOT NULL,
  style      text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

### 8.3 Endpoints

     |  | Method | Path | Access | Purpose

       | POST | /api/auth/register, /login?useCookies=true, … | public | MapIdentityApi endpoints

       | POST | /api/account/logout | user | sign out (clears the cookie)

       | GET | /api/account/me | any | current user (id, handle, roles), or 204

       | PUT | /api/account/handle | user | set the public handle used in /user/{handle}

       | GET | /api/brews/edit/{editId} | author | full brew for the editor, including version

       | GET | /api/brews/share/{shareId} | public; a lock blocks it | read-only doc, style and metadata. Views increment atomically (SET views = views + 1), not for authors.

       | POST | /api/brews | user | create from /new or an import

       | PUT | /api/brews/{editId} | author | save with baseVersion; returns 409 when stale

       | DELETE | /api/brews/{editId} | author | remove yourself as author; delete the brew when no authors remain

       | POST | /api/brews/{shareId}/clone | user | copy into a new brew

       | GET | /api/users/{handle}/brews | public; the owner also sees unpublished brews | brew list

       | GET | /api/vault?q=&page=&pageSize=&sort= | public | published brews; websearch_to_tsquery('simple', q); page size ≤ 60; sort whitelist

       | GET | /api/themes | public | static themes, published user themes, and the caller's own

       | GET | /api/themes/{theme}/bundle | public | inheritance chain, root first: style URLs or CSS, and snippet keys

       | GET | /api/import/homebrewery/{shareId} | user; rate limited | server-side fetch of upstream /download/{id}. Fixed host, id regex ^[\w-]{10,14}$, 2 MB cap.

       | GET | /api/notifications/active | public | site notifications

       | * | /api/admin/… | Admin role | locks (set, unset, review queue), notifications CRUD, stats, user lookup

       | GET | /share/{shareId} | public | index.html with HTML-encoded og:* tags

### 8.4 Save protocol

    - Saves use optimistic concurrency. The client sends the baseVersion it loaded, the server compares it and increments Version, and a race inside EF Core also returns 409 via the concurrency token.

    - Bodies are gzip JSON (AddRequestDecompression) with a 20 MB request cap. Documents over 10 MB are rejected by the inspector.

    - No diff-match-patch. Upstream computes patches but only logs them, and every save sends the whole brew anyway (homebrew.api.js:406-429).

  src/Homebrewery.Core/BrewService.cs (save) and the endpointCopy
public sealed record SaveBrewRequest(
    int BaseVersion,                   // version the client last loaded or saved
    JsonElement Doc,
    string Style,
    JsonElement? Snippets,
    BrewMetaDto Meta);                 // title, description, tags, lang, theme, published, thumbnailUrl

public async Task<SaveResult> SaveAsync(string editId, SaveBrewRequest req, Guid userId, CancellationToken ct)
{
    var brew = await db.Brews.Include(b => b.Authors).SingleOrDefaultAsync(b => b.EditId == editId, ct);
    if (brew is null) return SaveResult.NotFound();
    if (!AccessPolicy.CanEdit(brew, userId)) return SaveResult.Forbidden();
    if (brew.Version != req.BaseVersion) return SaveResult.Conflict(brew.Version);

    var doc = inspector.Inspect(req.Doc);           // schema + attribute validation, sanitizes rawHtml
    if (!doc.IsValid) return SaveResult.Invalid(doc.Errors);

    // Explicit whitelist. Upstream did _.assign(serverBrew, clientBrew), which let a client
    // set authors, published, lock or createdAt.
    brew.Doc = doc.SanitizedJson;
    brew.Style = req.Style;
    brew.Snippets = req.Snippets?.GetRawText();
    brew.PageCount = doc.PageCount;
    brew.SearchText = doc.PlainText;
    req.Meta.ApplyTo(brew, fallbackTitle: doc.FirstHeading);
    AccessPolicy.PromoteInvited(brew, userId);      // an invited author becomes an author on first save
    brew.Version++;
    brew.UpdatedAt = DateTimeOffset.UtcNow;

    try { await db.SaveChangesAsync(ct); }
    catch (DbUpdateConcurrencyException) { return SaveResult.Conflict(await VersionOf(editId, ct)); }
    return SaveResult.Ok(brew.Version, brew.UpdatedAt);
}

// Endpoints/BrewEndpoints.cs
brews.MapPut("/{editId}", async (string editId, SaveBrewRequest req, BrewService svc,
                                 ClaimsPrincipal user, CancellationToken ct) =>
    await svc.SaveAsync(editId, req, user.GetUserId(), ct) switch
    {
        SaveResult.OkResult ok        => Results.Ok(new { ok.Version, ok.UpdatedAt }),
        SaveResult.ConflictResult c   => Results.Conflict(new { serverVersion = c.ServerVersion }),
        SaveResult.InvalidResult v    => Results.ValidationProblem(v.Errors),
        SaveResult.ForbiddenResult    => Results.Forbid(),
        _                             => Results.NotFound(),
    })
    .RequireAuthorization();

### 8.5 Validation

  src/Homebrewery.Core/DocInspector.cs (outline)Copy
public sealed class DocInspector(SchemaManifest manifest, IHtmlSanitizer sanitizer)   // Ganss.Xss.HtmlSanitizer
{
    const int MaxBytes = 10 * 1024 * 1024, MaxDepth = 64, MaxNodes = 250_000, MaxStyle = 4096;
    static readonly Regex SafeAttr = new(@"^(data-[\w-]+|aria-[\w-]+|title|lang|dir|role)$");
    static readonly Regex BadCss = new(@"expression\s*\(|javascript:|behavior\s*:|-moz-binding",
                                       RegexOptions.IgnoreCase);

    public InspectResult Inspect(JsonElement doc)
    {
        // 1. Limits: raw size, nesting depth, node count.
        // 2. Every node.type / mark.type must exist in manifest; attrs not in the manifest are dropped.
        // 3. attrs.attributes: keys must match SafeAttr (no on*, no style/class/id smuggling).
        // 4. href / src (links, images, page objects): http, https, mailto, relative, #anchor, data:image/*.
        // 5. style strings: ≤ MaxStyle chars, reject BadCss.
        // 6. rawHtml.html → sanitizer (allow class, style, svg; strip script, iframe, on*).
        // 7. Collect: PageCount = doc.content.length, PlainText (≤ 200 KB), FirstHeading.
        // Rebuild with System.Text.Json.Nodes and return the re-serialized JSON, so anything
        // dropped never reaches the database.
        throw new NotImplementedException();
    }
}

### 8.6 Auth

    - Use ASP.NET Core Identity with AddIdentityApiEndpoints and cookie sign-in (/api/auth/login?useCookies=true). The SPA and API share an origin, so no tokens live in the browser.

    - Handle: each user has a public handle for URLs, unique and case-insensitive, 3–32 characters from [a-z0-9_-].

    - Admin role: seeded from configuration (Admin:Emails).

    - External providers are optional later work: AddGoogle and AspNet.Security.OAuth.Discord.

    - SameOriginWriteGuard: for POST, PUT and DELETE, the Origin header (or Referer when Origin is absent) must match the request host.

    - Locks keep upstream's meaning: a lock blocks the share view with its share message, and the editor shows its edit message.

### 8.7 Themes

    - ThemeCatalog loads wwwroot/themes/themes.json at startup. The build generates it from each theme's settings.json.

    - User themes are published brews tagged meta:theme, plus the caller's own.

    - The bundle endpoint walks baseTheme (static themes) or the parent theme (user themes) and returns the chain root first, for example:

        - styles: [{kind:'url', href:'/themes/V3/Blank/style.scoped.css'}, {kind:'css', css:'…'}]

        - snippets: ['V3_Blank', 'V3_5ePHB', {name, snippets}]

    - A visited set detects cycles and returns 422; chains are limited to 8 levels. Upstream has no cycle check.

    - User-theme CSS is scoped on the client, like user CSS.

### 8.8 Share page and link previews

  ShareShell reads wwwroot/index.html once and caches it. For each request it loads title, description and thumbnail by shareId, HTML-encodes them with HtmlEncoder.Default, and injects og:* meta tags. No page props are injected; the SPA fetches /api/brews/share/{id}. Unknown ids fall through to the SPA's not-found page.

## §9Frontend app

     |  | Route | Page | Data

       | / | Home: the welcome brew, editable locally, never saved | bundled doc JSON (converted once from welcome_msg.md)

       | /new | New brew. Draft in IndexedDB; the first save POSTs, then navigates to /edit/:editId | —

       | /edit/:editId | Editor | GET /api/brews/edit/:editId

       | /share/:shareId | Read-only editor with pagination on; never saved | GET /api/brews/share/:shareId

       | /user/:handle | Brew list | GET /api/users/:handle/brews

       | /vault | Search | GET /api/vault

       | /import | Import from pasted text, a .txt file, or an upstream share link | converter (§7), then POST /api/brews

       | /account, /login, /register | Account | Identity endpoints

       | /admin | Locks, notifications, stats | /api/admin/*

    - State:

        - TanStack Query holds server data.

        - The TipTap editor owns the document.

        - A small zustand store holds UI state (zoom, spread, panels), persisted to localStorage. It replaces HB_renderer_toolbarState.

    - API client: openapi-typescript generates types from /openapi/v1.json, and openapi-fetch makes the calls.

    - Errors: 401 shows a sign-in prompt, 403 and 404 show error pages, 409 opens the conflict dialog, and anything else shows a toast with a retry.

  web/src/editor/save/useAutosave.ts (behaviour spec)Copy
// Dirty       = a transaction with docChanged && !tr.getMeta(PAGINATE), or a style/meta edit.
// Save when   = 3 s after the last change AND isSettled(state) (pagination idle),
//               or Mod-S, route change, visibilitychange → hidden.
// Request     = PUT /api/brews/{editId}
//               body { baseVersion, doc: editor.getJSON(), style, snippets, meta }
//               gzip with fflate; headers Content-Encoding: gzip, Content-Type: application/json
// 200         → baseVersion = response.version; clear the IndexedDB draft; status "Saved".
// 409         → stop autosave; ConflictDialog: [Load the saved version] [Overwrite with mine]
//               (re-PUT with baseVersion = serverVersion) [Save mine as a copy] (POST /api/brews).
// 401         → keep the draft, show "Sign in to save" (draft survives the login redirect).
// Drafts      = every change, throttled to 1 s, goes to IndexedDB drafts/{editId|'new'}
//               via idb-keyval. On load, if the draft's baseVersion == server version and the
//               draft differs, offer "Restore unsaved changes".
// Snapshots   = port legacy versionHistory.js: 5 rolling local snapshots per brew, JSON not text.

## §10What to reuse from this repository

     |  | From (after P0.1) | Action

       | themes/** (LESS, fonts, assets, settings.json) | Keep as is. Build with the ported asset plugin, adding scoped output.

       | themes/V3/*/snippets.js, snippets/*.gen.js | Keep. Insert through the import pipeline. Fix or drop footer.gen.js.

       | marked-hbfm (npm) | Dependency for import and snippet insertion only

       | legacy/vitePlugins/generateAssetsPlugin.js | Port to TypeScript; add style.scoped.css output

       | legacy/shared/helpers.js (splitTextStyleAndMetadata, brewSnippetsToJSON, yamlSnippetsToText) | Port to TypeScript in editor/import

       | legacy/client/homebrew/brewRenderer/toolBar/** | Port: zoom (switched to transform), spreads, page navigation

       | legacy/client/homebrew/brewRenderer/headerNav/** | Port as the Outline panel, reading the document instead of the DOM

       | legacy/client/homebrew/brewRenderer/brewRenderer.less | Port the page chrome: spreads, shadows, print

       | legacy/client/homebrew/brewRenderer/safeHTML.js | Replace with DOMPurify. It is a small blacklist.

       | legacy/client/homebrew/editor/metadataEditor/**, tagInput/** | Port to TypeScript function components

       | legacy/client/homebrew/editor/snippetbar/** | Becomes the Insert menu; keep the compileSnippets merge logic

       | legacy/client/homebrew/navbar/** | Port

       | legacy/client/homebrew/pages/basePages/listPage/** | Port for the user page and the vault

       | legacy/client/homebrew/utils/versionHistory.js, customIDBStore.js | Port; store JSON snapshots

       | legacy/client/components/codeEditor/** | Keep only for the Style drawer (CSS) and the raw-HTML popover

       | legacy/client/components/splitPane/**, the sync logic in editor.jsx, the CodeMirror markdown extensions | Drop

       | legacy/client/admin/** | Port in P7.4

       | legacy/server/** | Behaviour reference only; replaced by src/

       | tests/markdown/** | Keep as import fixtures; they document the dialect

## §11Phases and tasks

  Sizes: S is up to a few days, M is about a week, L is several weeks, for one developer working with a coding assistant.

### P0 · Foundation S

     |  | ID | Task | Done when

       | P0.1 | git mv client server shared server.js vitePlugins legacy/. Keep themes/ and tests/markdown at the root. | Nothing outside legacy/ imports from it; README describes the new layout

       | P0.2 | Create Homebrewery.sln with the Api, Core, Data and Api.Tests projects (.NET 10) | dotnet build and dotnet test pass with one smoke test

       | P0.3 | Scaffold web/: Vite, React 19, strict TypeScript, ESLint, Vitest, Playwright. Proxy /api and /share; build into src/Homebrewery.Api/wwwroot. | dotnet run serves the built SPA; npm run dev hot-reloads with working API calls

       | P0.4 | Port generateAssetsPlugin to web/vite/; add scopeThemes.ts (postcss-prefix-selector) | /themes/V3/5ePHB/style.css and style.scoped.css are served, along with fonts and assets

       | P0.5 | docker-compose.yml (postgres:18), user-secrets, and a GitHub Actions workflow (build, test, lint, typecheck, Playwright) | CI passes on the branch

### Spikes · go/no-go M

     |  | ID | Spike | Done when

       | S1 | Canvas. TipTap with doc › page+ and scoped 5ePHB CSS. A hand-built two-page document with h1 and drop cap, paragraphs, .note, .monster.frame, a .wide block, a table and a column break. |

          - Arrow keys move across columns and pages.

          - Drag selection works across pages.

          - IME input works (Japanese, Korean).

          - Paste from Word and Google Docs yields clean nodes.

          - Click-to-caret is accurate at 50–200% zoom.

          - A screenshot matches the old renderer.

       | S2 | Pagination prototype. Paragraphs and unsplittable blocks only: push, pull, continuation paragraphs, 1 and 2 columns. |

          - Typing at the end of a full page moves the line without flicker.

          - Deleting pulls text back.

          - Undo and redo behave.

          - A 30-page section settles in under 500 ms after an edit on page 1.

          - 1,000 fuzzed edits cause no loops.

       | S3 | Import fidelity harness (§7): legacy render route, import, read-only render, and Playwright pixel diff |

          - The report lists diff % and lossy constructs for each fixture.

          - At least 90% of fixtures are under 2% pixel difference. Tune the threshold after the first run.

### P2 · Backend core M

     |  | ID | Task | Done when

       | P2.1 | Entities, EF configurations and the first migration (brews, brew_authors, notifications, Identity tables); snake_case; lz4 on doc | Applies to an empty database; the schema matches §8.2

       | P2.2 | Identity: register, login, logout (cookie), /api/account/me, handle, admin seeding | Tests cover login, 401 on protected endpoints, and the Admin policy

       | P2.3 | Brew endpoints: create, get for edit, get for share (atomic views, lock), save, delete, clone | Authorization matrix tests pass: owner, author, invited, other and anonymous against each endpoint

       | P2.4 | DocInspector, SchemaManifest and HtmlSanitizer | Tests reject unknown node types, on* attributes, javascript: URLs and oversized docs, and check the extracted page count, text and title

       | P2.5 | ThemeCatalog, /api/themes and the bundle endpoint with cycle detection | 5eDMG → 5ePHB → Blank order verified; a cycle returns 422

       | P2.6 | Vault search and user brew lists | Tests cover search, paging, sorting and hidden unpublished brews

       | P2.7 | Notifications, ShareShell, SameOriginWriteGuard, rate limits, request limits, ProblemDetails | Integration tests for each; og values containing </script> and quotes come back encoded

       | P2.8 | Upstream import proxy | Returns text/plain for a public brew; rejects other hosts, bad ids and oversized responses

### P3 · Editor core L

     |  | ID | Task | Done when

       | P3.1 | Schema: HbDocument, Page, every node and mark in §3.1, HbAttributes, and the manifest step in the build | JSON → HTML → JSON round trip is stable for every node type; the manifest is generated in CI

       | P3.2 | PageView (vanilla NodeView): markers, objects, footer, page number, oversize badge; ignoreMutation and stopEvent for chrome | Covers, .pageNumber.auto counters and even/odd rules match the old renderer (S3 harness)

       | P3.3 | EditorCanvas: .hb-canvas, theme bundle loading, user CSS scoping, fonts gate, transform zoom, spreads | Switching theme or editing CSS restyles live and triggers repagination

       | P3.4 | Keymap and toolbar (§6.1), with the class picker fed from the theme stylesheets | Every shortcut has an e2e test

       | P3.5 | Inspector: node classes, style, id and attributes; page and section settings | Edits are undoable and validated before they apply

       | P3.6 | Style drawer (CodeMirror 6 CSS, Prettier) | CSS edits apply within 300 ms

       | P3.7 | Metadata dialog: port MetadataEditor and TagInput (title, description, tags, language, theme, thumbnail, authors and invites, publish, delete) | Every field saves; the theme list includes user themes

       | P3.8 | Autosave, conflict dialog, IndexedDB drafts and local snapshots (§9) | A killed tab recovers its draft; the 409 path is covered by tests

       | P3.9 | Outline panel and page navigation toolbar | Clicking a heading or page scrolls to it; the current page is tracked

### P4 · Pagination L

     |  | ID | Task | Done when

       | P4.1 | measure.ts (§4.3) | Playwright component tests with real theme CSS: overflow and free space are correct in 1 and 2 columns, with .wide, and at 50%, 100% and 200% zoom

       | P4.2 | cut.ts: paragraph binary search, list items, definition groups, keep-with-next, unsplittable blocks, oversized | Each rule in §4.4 has a test

       | P4.3 | boundary.ts: insertAutoPageAt, moveBoundary, continuation re-join, keeping pages that carry objects | Vitest (pure ProseMirror) asserts the exact resulting documents and the selection mapping for each case

       | P4.4 | Plugin state and scheduler: dirty range, frame budget, IME guard, fonts gate, isSettled | No pagination during composition; autosave waits for settle

       | P4.5 | Triggers (§4.7) | Each trigger has a test that shows repagination from the right page

       | P4.6 | Section commands: Mod-Enter, Backspace at a section start, columns per section, attribute propagation, pid assignment | Changing a section to 1 column reflows only that section

       | P4.7 | Seam editing (§4.8) | Backspace, Delete and arrow keys at a seam behave as in an unsplit paragraph

       | P4.8 | UX: oversize warning with actions (make wide, allow splitting, shrink image) and a “Laying out pages…” indicator for long passes | Warnings appear and clear as the layout changes

       | P4.9 | Test matrix (§4.11) and the fuzz test in CI | All cases pass in Chromium and Firefox

### P5 · Theme components and snippets L

     |  | ID | Task | Done when

       | P5.1 | Snippet pipeline and Insert menu (§6.3); page-producing snippets insert manual pages | Every V3 snippet inserts and renders like the S3 fixture

       | P5.2 | themeBlock NodeViews: labels and toggles for monster, note, descriptive, classTable, spellList, quote, artist | Toggling wide or frame is one undo step

       | P5.3 | Page objects: select, drag, resize, nudge, text edit, z-order; converting between inline and positioned images | A cover page can be built from scratch without the inspector

       | P5.4 | Live TOC node (§6.5) | Page numbers update after pagination settles; --TOC: exclude is respected

       | P5.5 | Icon picker and : autocomplete | All four icon fonts are searchable

       | P5.6 | Tables: colspan, rowspan, widths, header rows, table classes | The class table snippet imports and edits without losing spans

       | P5.7 | UI for definition lists, spacers, column breaks and rules | Each can be inserted and removed from the toolbar

### P6 · Import and export M

     |  | ID | Task | Done when

       | P6.1 | Import page: paste text, upload .txt, or an upstream share link (via P2.8) | All three sources create a brew

       | P6.2 | hbfmToDoc with parse rules, probe-based lifting, and style extraction (§7) | The S3 fidelity target is met on all fixtures

       | P6.3 | Import report UI | The counts in §7 are shown before the brew is saved

       | P6.4 | Print and HTML export (DOMSerializer with the theme CSS inlined) | Print preview has one brew page per sheet with no app chrome; the exported HTML opens offline

### P7 · App pages M

     |  | ID | Task | Done when

       | P7.1 | Share page: read-only editor, lock message, view count | Loads without an account; authors don't add views

       | P7.2 | Home page (bundled welcome doc) and New page (IndexedDB draft) | A draft survives a reload and the sign-in redirect

       | P7.3 | User page, vault and account page | Parity with upstream's list pages

       | P7.4 | Admin: locks, review queue, notifications, stats | Available only to the Admin role

### P8 · Hardening and deploy M

     |  | ID | Task | Done when

       | P8.1 | Performance with a 150-page brew fixture | Targets in §4.10 met; a full settle after a theme switch takes under 3 s

       | P8.2 | Accessibility: toolbar roles, focus management, keyboard access to the inspector and page objects | axe finds no serious violations; every action works from the keyboard

       | P8.3 | Security review against §14; CSP header (no inline scripts; fonts and images from https) | Review notes resolved

       | P8.4 | Dockerfile, /healthz (including the database), scheduled pg_dump backups, structured logging | The container runs against a managed Postgres; a restore from backup is tested

  Later, unscheduled: HBFM export, server-side PDF with Microsoft.Playwright for .NET, image uploads, server-side history (brew_snapshots), a form-based stat block editor, and real-time collaboration (see §4.10).

## §12Testing

     |  | Layer | Tool | Covers

       | Schema and import | Vitest | JSON ↔ HTML round trips for every node; parse rules on the tests/markdown fixtures

       | Pagination logic | Vitest, pure ProseMirror with no DOM | boundary.ts steps: resulting documents and selection mapping

       | Pagination layout | Playwright (Chromium, Firefox) | The §4.11 matrix with real theme CSS, plus the fuzz test

       | Visual fidelity | Playwright screenshots | The S3 harness, then regression checks when themes change

       | API | xUnit, WebApplicationFactory, Testcontainers.PostgreSql | Authorization matrix, 409s, validation, search, share shell encoding

       | End to end | Playwright | Sign up → new brew → type → autosave → reload → share → print preview

## §13Risks

     |  | Risk | Why | Mitigation

       | Caret and selection inside CSS columns | contenteditable in multi-column layout gets less browser testing | S1 is a go/no-go. If arrow keys misbehave, handle ArrowUp and ArrowDown with coordsAtPos and posAtCoords between columns.

       | Pagination never settling | Measure-and-move loops can oscillate | Every step advances or re-measures once; guard counters; the fuzz test in CI

       | Long sections are slow | An early edit shifts every later boundary | Frame budget, stop at unchanged pages, visible pages first, manual breaks for chapters

       | Coordinates under zoom | Transforms affect caret and hit-testing maths | S1 checks click-to-caret at several zoom levels. Fallback: a few fixed zoom steps.

       | Late fonts change line breaks | Theme fonts load asynchronously | Gate on document.fonts.ready; repaginate on loadingdone

       | Theme CSS relies on markdown quirks | For example bare spans outside <p> and p + p | The CSS contract (§3.2) and the S3 diff

       | User CSS breaks the editor, or app CSS leaks into pages | Both share one document | CSSOM scoping, CSS modules for the app, and the iframe fallback

       | TipTap Pro temptation | The paid Pages extension targets Word-style pages | Build pagination in-house; it has to follow the theme's columns and break-inside rules anyway

       | Future collaboration | The client-side paginator edits the document | Decide on a single paginating writer or a view-only layer before adding Yjs

## §14Upstream behaviour to drop

  Found while surveying server/. Treat each as a requirement for the new code, not a behaviour to reproduce.

    - /admin/compress/:id and /admin/clean/script/:id have no admin check (server/admin.api.js:139, 174).

    - Saves copy every client field onto the stored brew with _.assign (server/homebrew.api.js:431). A client can set authors, published or lock.

    - og meta values and the page props JSON are written into HTML unescaped (server/app.js:268-285).

    - The whole session token, including Google OAuth tokens, is sent to the browser, and the cookie is not HttpOnly.

    - Admin credentials default to admin / password3 (server/admin.api.js:18-19).

    - Google Drive brews are shared with anyone as writer (server/googleActions.js:251-252).

    - The /stream endpoint broadcasts every save to every listener and never removes listeners.

    - View counts are read, modified and saved, not incremented atomically.

    - Theme inheritance has no cycle detection.

    - safeHTML is a blacklist. Use DOMPurify on the client and HtmlSanitizer on the server.

