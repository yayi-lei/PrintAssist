import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../../styles.css', import.meta.url), 'utf8');

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS rule: ${selector}`);
  return match[1].replace(/\s+/g, ' ').trim();
}

describe('文件队列滚动布局', () => {
  it('滚动容器可在主工作区内收缩并预留滚动条空间', () => {
    const rule = ruleBody('.queue-content-wrap');
    expect(rule).toContain('min-height: 0');
    expect(rule).toContain('overflow-y: auto');
    expect(rule).toContain('scrollbar-gutter: stable');
  });

  it('完整表格不被 flex 压缩裁切，超出部分由父容器滚动', () => {
    const rule = ruleBody('.queue-table-card');
    expect(rule).toContain('flex-shrink: 0');
    expect(rule).toContain('overflow: hidden');
  });
});
