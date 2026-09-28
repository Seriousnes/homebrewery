// "From markdown…" in the source dialog: Homebrewery markdown converted to source HTML
// (editor/source/markdown.ts), inserted at the source editor's selection. One way only: the
// document has no markdown form.
import type { Schema } from '@tiptap/pm/model';
import { useState } from 'react';
import { markdownToSource } from '@/editor/source/markdown';
import { Button, Dialog, TextArea } from '@/ui';

export interface MarkdownDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schema: Schema;
  /** `\page` lines start sections (the section and whole-brew scopes). */
  sections: boolean;
  onInsert: (source: string) => void;
}

export function MarkdownDialog({ open, onOpenChange, schema, sections, onInsert }: MarkdownDialogProps) {
  const [markdown, setMarkdown] = useState('');
  const [error, setError] = useState<string | null>(null);
  const convert = () => {
    try {
      onInsert(markdownToSource(schema, markdown, sections).text);
      setMarkdown('');
      setError(null);
      onOpenChange(false);
    } catch (e) {
      setError(`The markdown could not be converted: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Insert from markdown"
      description={
        sections
          ? 'Homebrewery markdown becomes HTML at the cursor; every \\page starts a section.'
          : 'Homebrewery markdown becomes HTML at the cursor.'
      }
      size="md"
      data-testid="source-markdown"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={convert} disabled={markdown.trim() === ''} data-testid="source-markdown-insert">
            Insert
          </Button>
        </>
      }
    >
      <TextArea
        label="Markdown"
        value={markdown}
        onChange={(event) => setMarkdown(event.target.value)}
        rows={10}
        spellCheck={false}
        error={error ?? undefined}
        data-autofocus=""
      />
    </Dialog>
  );
}
