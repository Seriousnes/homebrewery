// The one-way markdown helper of the source dialog: HBFM → source HTML, as the import renders it.
import { describe, expect, it } from 'vitest';
import { schema } from '../schema/testing';
import { markdownToSource } from './markdown';

describe('markdownToSource', () => {
  it('blocks: headings (generated slugs dropped), marks, lists, definition lists, mustache blocks', () => {
    const { text, problems } = markdownToSource(
      schema,
      '# The Inn\n\n## Rooms\n\nSome **bold** and *italic* text\ncontinued.\n\n- one\n- two\n\nArmor Class :: 15\n\n{{note\n##### Rumours\nThe stew is warm.\n}}\n',
      false,
    );
    expect(problems).toEqual([]);
    expect(text.split('\n')).toEqual([
      '<h1>The Inn</h1>',
      '<h2>Rooms</h2>',
      '<p>Some <strong>bold</strong> and <em>italic</em> text continued.</p>',
      '<ul>',
      '  <li><p>one</p></li>',
      '  <li><p>two</p></li>',
      '</ul>',
      '<dl><dt>Armor Class</dt><dd>15</dd></dl>',
      '<div class="block note">',
      '  <h5>Rumours</h5>',
      '  <p>The stew is warm.</p>',
      '</div>',
    ]);
  });

  it('sections: every \\page starts a div.page with its classes; \\column is a column break', () => {
    const { text } = markdownToSource(schema, 'First\n\\column\nSecond\n\\page {wide,color:red}\nThird', true);
    expect(text).toBe(
      ['<div class="page">', '  <p>First</p>', '  <div class="columnSplit"></div>', '  <p>Second</p>', '</div>', '', '<div class="page wide" style="color: red;">', '  <p>Third</p>', '</div>'].join(
        '\n',
      ),
    );
  });
});
