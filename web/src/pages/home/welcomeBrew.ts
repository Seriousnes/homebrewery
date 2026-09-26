// The home page's welcome brew (plan §9): upstream's welcome_msg.md, converted once with the import
// pipeline by web/scripts/welcome-doc.ts into welcome.doc.json and bundled with the page. The home
// page is editable locally and never saved.
import type { JSONContent } from '@tiptap/core';
import { appBrewForNew, defaultMeta, docForEditor, type EditorAppBrew } from '@/editor/EditorApp/editorAppModel';
import welcome from './welcome.doc.json';

/** The generated file (see scripts/welcome-doc.ts). */
export interface WelcomeDocFile {
  source: string;
  generator: string;
  docSchemaVersion: number;
  theme: string;
  lang: string;
  title: string;
  style: string;
  doc: JSONContent;
}

export const WELCOME: WelcomeDocFile = welcome;

/** The editor's initial content and brew for the home page. */
export function welcomeBrew(file: WelcomeDocFile = WELCOME): { content: JSONContent; brew: EditorAppBrew } {
  return {
    content: docForEditor(file.doc, file.docSchemaVersion),
    brew: {
      ...appBrewForNew(null),
      meta: defaultMeta({ title: file.title, theme: file.theme, lang: file.lang }),
      style: file.style,
    },
  };
}
