"""Adapt the inspected upstream ComicSource without executing server JavaScript."""
from pathlib import Path

root = Path(__file__).resolve().parent
upstream = (root / 'vendor/mangabz.js').read_text(encoding='utf-8')
start = upstream.index('  static unpackImages(body) {')
end = upstream.index('  static parseList(document)', start)
decoder = r'''  static unpackImages(body) {
    if (!body || body.length > 1000000) throw new Error("图片目录格式无效");
    const match = /\}\('((?:\\.|[^'\\])*)',(\d+),(\d+),'((?:\\.|[^'\\])*)'\.split\('\|'\)/.exec(body);
    if (!match) throw new Error("图片目录格式已变化");
    const literal = s => s.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, c) => {
      if (c[0] === 'u' || c[0] === 'x') return String.fromCharCode(parseInt(c.slice(1), 16));
      return ({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v'})[c] ?? c;
    });
    const radix = Number(match[2]), count = Number(match[3]);
    if (radix < 2 || radix > 62 || count > 10000) throw new Error("图片目录编码无效");
    const words = literal(match[4]).split('|'), map = new Map();
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const token = number => number < radix ? alphabet[number] : token(Math.floor(number / radix)) + alphabet[number % radix];
    for (let i = 0; i < count; i++) if (words[i]) map.set(token(i), words[i]);
    const decoded = literal(match[1]).replace(/\b\w+\b/g, word => map.get(word) ?? word);
    const prefix = /\bpix\s*=\s*(["'])(.*?)\1/.exec(decoded);
    const paths = /\bpvalue\s*=\s*(\[[\s\S]*?\])/.exec(decoded);
    const suffix = /(["'])(\?cid=[^"']+)\1/.exec(decoded);
    if (!prefix || !paths || !suffix) throw new Error("图片地址格式已变化");
    const values = JSON.parse(paths[1]);
    if (!Array.isArray(values) || values.some(p => typeof p !== 'string' || !p.startsWith('/'))) throw new Error("图片地址无效");
    return values.map(p => (prefix[2] + p + suffix[2]).replace(/^http:/, 'https:'));
  }
'''
prefix = '''// Parser adapted from YHQY-Dev/venera-sources/mangabz.js, inspected 2026-11-01.
// Local changes: DOM selectors, browser API adapter, data-only packed-response decoder.
class ComicSource {}
class Comic { constructor(data) { Object.assign(this, data); } }
class ComicDetails { constructor(data) { Object.assign(this, data); } }
'''
adapted = prefix + upstream[:start] + decoder + upstream[end:]
adapted = adapted.replace('if (images.length < 1) throw "No images";',
    'if (images.length !== imageCount) throw "章节图片暂未完整加载，请重试";')
(root / 'assets/source.js').write_text(adapted, encoding='utf-8')
print('Prepared source.js (server scripts are decoded as data, never evaluated)')
