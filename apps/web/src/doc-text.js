import { inflateSync } from 'node:zlib';

/**
 * Text out of the files a patient imported, so "Ask AI" can read them.
 * Dependency-free and best effort: plain text, HTML, XML (CDA), JSON, CSV and
 * PDFs with real text (Flate streams, ToUnicode maps, object streams).
 * Scanned PDFs and images have no text layer: they come back unread.
 */

const MAX_TEXT = 200_000;

/** { text } or { text: null, reason } */
export function extractText(data, contentType = '', title = '') {
  const type = String(contentType || '').toLowerCase();
  const name = String(title || '').toLowerCase();
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data ?? []);
  if (!buf.length) return { text: null, reason: 'empty file' };
  if (type.startsWith('image/') || type.includes('dicom') || /\.(png|jpe?g|gif|webp|heic|tiff?|dcm|bmp)$/.test(name))
    return { text: null, reason: 'image (not read)' };
  try {
    if (type.includes('pdf') || name.endsWith('.pdf') || buf.subarray(0, 5).toString('latin1') === '%PDF-') {
      const text = clean(pdfText(buf));
      return readable(text) ? { text: text.slice(0, MAX_TEXT) } : { text: null, reason: 'PDF without readable text (scanned or unsupported encoding)' };
    }
    if (type.includes('html') || /\.html?$/.test(name)) return ok(htmlText(buf.toString('utf8')));
    if (type.includes('xml') || name.endsWith('.xml')) return ok(htmlText(buf.toString('utf8')));
    if (type.includes('json') || name.endsWith('.json')) return ok(jsonText(buf.toString('utf8')));
    if (type.includes('rtf') || name.endsWith('.rtf')) return ok(buf.toString('latin1').replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^}]*\}|\\[a-z]+-?\d* ?|[{}]/g, ''));
    if (type.startsWith('text/') || /\.(txt|csv|tsv|md)$/.test(name)) return ok(buf.toString('utf8'));
  } catch {
    return { text: null, reason: 'could not be read' };
  }
  return { text: null, reason: `${type || 'this file type'} (not read)` };
}

function ok(raw) {
  const text = clean(raw);
  return readable(text) ? { text: text.slice(0, MAX_TEXT) } : { text: null, reason: 'no readable text' };
}

const clean = (s) =>
  String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** Mostly letters, digits and punctuation, and some words: not a font's glyph soup. */
function readable(text) {
  if (!text || text.length < 3) return false;
  const sample = text.slice(0, 20_000);
  let good = 0;
  for (const ch of sample) if (/[\p{L}\p{N}\s.,:;%()\-/+'"#&*<>=]/u.test(ch)) good++;
  return good / sample.length > 0.85 && /[A-Za-z]{3,}/.test(sample);
}

export function htmlText(html) {
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d|paragraph|item|section|title)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function jsonText(s) {
  const j = JSON.parse(s);
  const out = [];
  const walk = (v, key = '') => {
    if (out.length > 5000) return;
    if (v == null) return;
    if (typeof v === 'string') {
      if (key === 'data' && v.length > 200) return; // base64 payloads
      if (/^(reference|system|url|fullUrl|id|resourceType)$/.test(key)) return;
      out.push(key === 'div' ? htmlText(v) : v);
    } else if (typeof v === 'number' || typeof v === 'boolean') out.push(`${key}: ${v}`);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(j);
  return out.join('\n');
}

/* ------------------------------------------------------------------ PDF -- */

function decodeStream(dict, raw) {
  if (/\/FlateDecode|\/Fl\b/.test(dict)) {
    try {
      return inflateSync(raw);
    } catch {
      try {
        return inflateSync(raw, { finishFlush: 2 }); // Z_SYNC_FLUSH: tolerate a truncated stream
      } catch {
        return null;
      }
    }
  }
  if (/\/Filter/.test(dict)) return null; // DCT, JBIG2, LZW...: not text we can use
  return raw;
}

/** Every object: { dict, stream?: Buffer } by object number, including objects inside object streams. */
function objects(buf) {
  const s = buf.toString('latin1');
  const out = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    let end = s.indexOf('endobj', start);
    if (end < 0) break;
    const sm = /stream\r?\n/.exec(s.slice(start, end));
    const dict = sm ? s.slice(start, start + sm.index) : '';
    if (sm && /^[\s\S]*>>\s*$/.test(dict)) {
      const dataStart = start + sm.index + sm[0].length;
      const len = dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      let dataEnd = len ? dataStart + Number(len[1]) : s.indexOf('endstream', dataStart);
      if (dataEnd < dataStart || dataEnd > buf.length) dataEnd = s.indexOf('endstream', dataStart);
      if (dataEnd < 0) break;
      end = s.indexOf('endobj', dataEnd);
      if (end < 0) end = s.length;
      out.set(Number(m[1]), { dict, stream: decodeStream(dict, buf.subarray(dataStart, dataEnd)) });
    } else out.set(Number(m[1]), { dict: s.slice(start, end) });
    re.lastIndex = end;
  }
  // PDF 1.5 object streams: "n offset" pairs, then the objects.
  for (const o of [...out.values()]) {
    if (!/\/Type\s*\/ObjStm/.test(o.dict) || !o.stream) continue;
    const first = Number(o.dict.match(/\/First\s+(\d+)/)?.[1]);
    const n = Number(o.dict.match(/\/N\s+(\d+)/)?.[1]);
    if (!Number.isFinite(first) || !Number.isFinite(n)) continue;
    const text = o.stream.toString('latin1');
    const nums = text.slice(0, first).trim().split(/\s+/).map(Number);
    for (let i = 0; i < n; i++) {
      const num = nums[2 * i];
      const off = nums[2 * i + 1];
      const next = i + 1 < n ? nums[2 * i + 3] : text.length - first;
      if (!out.has(num)) out.set(num, { dict: text.slice(first + off, first + next) });
    }
  }
  return out;
}

const ref = (dict, key) => {
  const m = dict.match(new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`));
  return m ? Number(m[1]) : null;
};

/** A ToUnicode CMap: code -> string, and how many bytes a code takes. */
function parseCMap(text) {
  const map = new Map();
  let bytes = 1;
  const cs = text.match(/begincodespacerange\s*<([0-9a-fA-F]+)>/);
  if (cs) bytes = Math.max(1, cs[1].length / 2);
  const uni = (hex) => {
    let r = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) r += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    if (hex.length % 4 === 2) r += String.fromCharCode(parseInt(hex.slice(-2), 16));
    return r;
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g))
    for (const [, a, b] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(a, 16), uni(b));
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const [, lo, hi, rest] of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const l = parseInt(lo, 16);
      const h = Math.min(parseInt(hi, 16), l + 65535);
      if (rest.startsWith('[')) {
        const items = [...rest.matchAll(/<([0-9a-fA-F]*)>/g)].map((x) => x[1]);
        for (let c = l; c <= h && c - l < items.length; c++) map.set(c, uni(items[c - l]));
      } else {
        const start = parseInt(rest.slice(1, -1), 16);
        const width = rest.length - 2;
        for (let c = l; c <= h; c++) map.set(c, uni((start + c - l).toString(16).padStart(width, '0')));
      }
    }
  }
  return { map, bytes };
}

/** Font resource name (/F1) -> its CMap, gathered from every /Font dictionary in the file. */
function fontMaps(objs) {
  const cmaps = new Map();
  const cmapOf = (fontNum) => {
    if (cmaps.has(fontNum)) return cmaps.get(fontNum);
    const font = objs.get(fontNum);
    let cm = null;
    const tu = font && ref(font.dict, 'ToUnicode');
    const stream = tu != null && objs.get(tu)?.stream;
    if (stream) cm = parseCMap(stream.toString('latin1'));
    else if (font && /\/Subtype\s*\/Type0/.test(font.dict)) cm = { map: null, bytes: 2 };
    cmaps.set(fontNum, cm);
    return cm;
  };
  const byName = new Map();
  const addDict = (d) => {
    for (const [, name, num] of d.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) if (!byName.has(name)) byName.set(name, cmapOf(Number(num)));
  };
  for (const o of objs.values()) {
    const inline = o.dict.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (inline) addDict(inline[1]);
    const indirect = ref(o.dict, 'Font');
    if (indirect != null && objs.get(indirect)) addDict(objs.get(indirect).dict);
  }
  return byName;
}

/** Literal (...) string bytes, with escapes. Returns [bytes, nextIndex]. */
function literal(s, i) {
  const out = [];
  let depth = 1;
  for (i++; i < s.length && depth > 0; i++) {
    const c = s[i];
    if (c === '\\') {
      const n = s[++i];
      const esc = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 }[n];
      if (esc !== undefined) out.push(esc);
      else if (/[0-7]/.test(n)) {
        let oct = n;
        while (oct.length < 3 && /[0-7]/.test(s[i + 1])) oct += s[++i];
        out.push(parseInt(oct, 8) & 255);
      } else if (n === '\r' || n === '\n') {
        if (n === '\r' && s[i + 1] === '\n') i++;
      } else out.push(n.charCodeAt(0));
    } else if (c === '(') {
      depth++;
      out.push(40);
    } else if (c === ')') {
      depth--;
      if (depth > 0) out.push(41);
    } else out.push(c.charCodeAt(0) & 255);
  }
  return [out, i];
}

function decodeBytes(bytes, cm) {
  if (!cm) return String.fromCharCode(...bytes.filter((b) => b >= 9));
  let r = '';
  for (let i = 0; i + cm.bytes <= bytes.length; i += cm.bytes) {
    let code = 0;
    for (let k = 0; k < cm.bytes; k++) code = code * 256 + bytes[i + k];
    r += cm.map?.get(code) ?? (cm.bytes === 1 ? String.fromCharCode(code) : '');
  }
  return r;
}

/** The text operators of one content stream. */
function contentText(s, fonts) {
  let out = '';
  let cm = null;
  const stack = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '(') {
      const [bytes, next] = literal(s, i);
      stack.push({ str: decodeBytes(bytes, cm) });
      i = next;
    } else if (c === '<' && s[i + 1] !== '<') {
      const end = s.indexOf('>', i);
      const hex = s.slice(i + 1, end < 0 ? n : end).replace(/\s+/g, '');
      const bytes = [];
      for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      stack.push({ str: decodeBytes(bytes, cm) });
      i = end < 0 ? n : end + 1;
    } else if (c === '[') {
      stack.push({ arrayStart: true });
      i++;
    } else if (c === ']') {
      const parts = [];
      while (stack.length && !stack[stack.length - 1].arrayStart) parts.unshift(stack.pop());
      stack.pop();
      stack.push({ array: parts });
      i++;
    } else if (c === '%') {
      while (i < n && s[i] !== '\n' && s[i] !== '\r') i++;
    } else if (/\s/.test(c) || c === '>' || c === '{' || c === '}') {
      i++;
    } else {
      let j = i;
      while (j < n && !/[\s()<>[\]/%{}]/.test(s[j])) j++;
      if (c === '/') {
        j = i + 1;
        while (j < n && !/[\s()<>[\]/%{}]/.test(s[j])) j++;
        stack.push({ name: s.slice(i + 1, j) });
        i = j;
        continue;
      }
      const tok = s.slice(i, j || i + 1);
      i = j > i ? j : i + 1;
      if (/^[-+.\d]+$/.test(tok)) {
        stack.push({ num: Number(tok) });
        continue;
      }
      switch (tok) {
        case 'Tf': {
          const name = stack[stack.length - 2]?.name;
          cm = name && fonts.has(name) ? fonts.get(name) : null;
          break;
        }
        case 'Tj':
        case "'":
        case '"':
          if (tok !== 'Tj') out += '\n';
          out += stack[stack.length - 1]?.str ?? '';
          break;
        case 'TJ':
          for (const p of stack[stack.length - 1]?.array ?? []) {
            if (p.str !== undefined) out += p.str;
            else if (p.num !== undefined && p.num < -180) out += ' ';
          }
          break;
        case 'Td':
        case 'TD': {
          const ty = stack[stack.length - 1]?.num ?? 0;
          const tx = stack[stack.length - 2]?.num ?? 0;
          out += Math.abs(ty) > 0.5 ? '\n' : tx > 40 ? ' ' : '';
          break;
        }
        case 'T*':
        case 'ET':
          out += '\n';
          break;
        case 'Tm':
          out += '\n';
          break;
        default:
          break;
      }
      stack.length = 0;
    }
  }
  return out;
}

export function pdfText(buf) {
  const objs = objects(buf);
  const fonts = fontMaps(objs);
  const parts = [];
  for (const o of objs.values()) {
    if (!o.stream) continue;
    if (/\/Subtype\s*\/(Image|Form\b(?![\s\S]*\/Resources))|\/Type\s*\/(ObjStm|XRef|Metadata|EmbeddedFile)|\/Length1|\/FontFile|CMapName|\/Subtype\s*\/(Type1C|CIDFontType0C|OpenType)/.test(o.dict)) continue;
    const text = o.stream.toString('latin1');
    if (!/\bBT\b/.test(text) || !/T[jJ]\b/.test(text)) continue;
    parts.push(contentText(text, fonts));
  }
  return parts.join('\n');
}
