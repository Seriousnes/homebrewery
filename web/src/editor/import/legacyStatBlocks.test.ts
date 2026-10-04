// Oracle: the HBFM renderer's HTML for the V3 monster snippet's markdown (monsterblock.gen.js).
import { describe, expect, it } from 'vitest';
import { mountInlineProbe } from '../canvas/probe';
import { createHbfmRenderer } from './hbfm/renderer';
import { hbfmToDoc } from './hbfmToDoc';
import { convertLegacyStatBlocks } from './legacyStatBlocks';

const LEGACY = [
  '> ## Hillock',
  '>*Large undead, neutral evil*',
  '> ___',
  '> - **Armor Class** 8',
  '> - **Speed** 15 ft.',
  '>___',
  '>|STR|DEX|',
  '>|:---:|:---:|',
  '>|19 (+4)|6 (-2)|',
  '>___',
  '> ***Sassiness.*** Talks back.',
  '>',
  '> ***Onion Stench.*** Onion rings.',
  '> ### Actions',
  '> ***Team Foot.*** *Melee Weapon Attack:* +4 to hit.',
  '>',
  '> ***Dual Throw.*** *Melee Weapon Attack:* +4 to hit.',
].join('\n');

const V3 = (classes: string) =>
  [
    `{{${classes}`,
    '## Hillock',
    '*Large undead, neutral evil*',
    '___',
    '**Armor Class** :: 8',
    '**Speed** :: 15 ft.',
    '___',
    '|STR|DEX|',
    '|:---:|:---:|',
    '|19 (+4)|6 (-2)|',
    '___',
    '***Sassiness.*** Talks back.',
    ':',
    '***Onion Stench.*** Onion rings.',
    '### Actions',
    '***Team Foot.*** *Melee Weapon Attack:* +4 to hit.',
    ':',
    '***Dual Throw.*** *Melee Weapon Attack:* +4 to hit.',
    '}}',
  ].join('\n');

function render(markdown: string): HTMLTemplateElement {
  const template = document.createElement('template');
  template.innerHTML = createHbfmRenderer().render(markdown, 0);
  return template;
}

function convert(markdown: string): { html: string; count: number } {
  const template = render(markdown);
  const count = convertLegacyStatBlocks(template.content, document);
  return { html: shape(template.content), count };
}

/** Tags, classes and text, whitespace-insensitive. */
function shape(root: ParentNode): string {
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) out.push(JSON.stringify(text));
      return;
    }
    if (!(node instanceof Element)) return;
    out.push(`<${node.tagName.toLowerCase()}${node.classList.length ? `.${[...node.classList].join('.')}` : ''}>`);
    node.childNodes.forEach(walk);
    out.push(`</${node.tagName.toLowerCase()}>`);
  };
  root.childNodes.forEach(walk);
  return out.join('');
}

describe('convertLegacyStatBlocks', () => {
  it('turns `___ ___ > ## …` into a wide monster frame, as the V3 snippet writes it', () => {
    const { html, count } = convert(`___\n___\n${LEGACY}`);
    expect(count).toBe(1);
    expect(html).toBe(shape(render(V3('monster,frame,wide')).content));
  });

  it('one rule: a column-wide monster frame', () => {
    const { html, count } = convert(`___\n${LEGACY}`);
    expect(count).toBe(1);
    expect(html).toBe(shape(render(V3('monster,frame')).content));
  });

  it('leaves quotes alone without a rule before them or a heading first', () => {
    for (const markdown of [LEGACY, '___\n> Just a quote.\n>\n> - **Bold** item', 'Text\n\n> ## Name\n> body']) {
      const before = shape(render(markdown).content);
      expect(convert(markdown)).toEqual({ html: before, count: 0 });
    }
  });

  it('keeps lists that are not `**Label** value` lines', () => {
    const { html } = convert('___\n> ## Name\n> - plain item\n> - **Bold** item');
    expect(html).toContain('<ul>');
    expect(html).not.toContain('<dl>');
  });
});

describe('hbfmToDoc with a legacy stat block', () => {
  it('imports a wide monster frame with a definition list, and says so in the report', async () => {
    const { doc, report } = await hbfmToDoc(`___\n___\n${LEGACY}`, { probe: () => Promise.resolve(mountInlineProbe()) });
    document.body.innerHTML = '';
    const blocks = doc.content?.[0]?.content ?? [];
    expect(blocks.map((n) => n.type)).toEqual(['themeBlock']);
    expect(blocks[0]?.attrs?.classes).toEqual(['monster', 'frame', 'wide']);
    expect((blocks[0]?.content ?? []).map((n) => n.type)).toContain('definitionList');
    expect(report.warnings).toContainEqual(expect.stringMatching(/legacy renderer.*monster frame/));
  });
});
