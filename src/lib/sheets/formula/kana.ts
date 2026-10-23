// ASC and JIS (R341): full-width and half-width characters, both ways.
//
// Excel's pages say what the two do in Japanese, ASC for any double-byte
// language: ASCII and katakana change width, other characters stay.
// They give no table. OpenOffice's specification of the two, written to
// match Japanese Excel's, does, and this follows it entry by entry
// (wiki.openoffice.org, Calc/Features/JIS_and_ASC_functions): the ASCII
// block, the katakana with their voiced (゛) and semi-voiced (゜) marks
// joined or split, and seven punctuation marks.

/** JIS's exceptions to the ASCII block. */
const TO_FULL: Record<number, number> = { 0x22: 0x201d, 0x5c: 0xffe5, 0x60: 0x2018, 0x27: 0x2019 };
/** One half-width katakana or mark → its full-width form. */
const KANA_FULL: Record<number, number> = {
  0xff66: 0x30f2,
  0xff6f: 0x30c3,
  0xff9c: 0x30ef,
  0xff9d: 0x30f3,
  0xff9e: 0x309b,
  0xff9f: 0x309c,
  0xff70: 0x30fc,
  0xff61: 0x3002,
  0xff62: 0x300c,
  0xff63: 0x300d,
  0xff64: 0x3001,
  0xff65: 0x30fb,
};

/** JIS(text): half-width ASCII and katakana to full-width; a mark after a kana joins it. */
export function toFullWidth(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const next = text.charCodeAt(i + 1);
    const voiced = next === 0xff9e;
    const semi = next === 0xff9f;
    let to: number | undefined;
    let joined = false;
    if (TO_FULL[c] !== undefined) to = TO_FULL[c];
    else if (c >= 0x21 && c <= 0x7e) to = c - 0x21 + 0xff01;
    else if (c >= 0xff67 && c <= 0xff6b) to = (c - 0xff67) * 2 + 0x30a1;
    else if (c >= 0xff6c && c <= 0xff6e) to = (c - 0xff6c) * 2 + 0x30e3;
    else if (c >= 0xff71 && c <= 0xff75) to = (c - 0xff71) * 2 + 0x30a2;
    else if (c >= 0xff76 && c <= 0xff81) {
      to = (c - 0xff76) * 2 + (voiced ? 0x30ac : 0x30ab);
      joined = voiced;
    } else if (c >= 0xff82 && c <= 0xff84) {
      to = (c - 0xff82) * 2 + (voiced ? 0x30c5 : 0x30c4);
      joined = voiced;
    } else if (c >= 0xff85 && c <= 0xff89) to = c - 0xff85 + 0x30ca;
    else if (c >= 0xff8a && c <= 0xff8e) {
      to = (c - 0xff8a) * 3 + (voiced ? 0x30d0 : semi ? 0x30d1 : 0x30cf);
      joined = voiced || semi;
    } else if (c >= 0xff8f && c <= 0xff93) to = c - 0xff8f + 0x30de;
    else if (c >= 0xff94 && c <= 0xff96) to = (c - 0xff94) * 2 + 0x30e4;
    else if (c >= 0xff97 && c <= 0xff9b) to = c - 0xff97 + 0x30e9;
    else to = KANA_FULL[c];
    out += to === undefined ? text[i] : String.fromCharCode(to);
    if (joined) i++;
  }
  return out;
}

/** One full-width character → its half-width form, when the specification has one. */
const TO_HALF: Record<number, number> = {
  0x30c3: 0xff6f,
  0x30ef: 0xff9c,
  0x30f2: 0xff66,
  0x30f3: 0xff9d,
  0x2015: 0xff70,
  0x2018: 0x60,
  0x2019: 0x27,
  0x201d: 0x22,
  0x3001: 0xff64,
  0x3002: 0xff61,
  0x300c: 0xff62,
  0x300d: 0xff63,
  0x309b: 0xff9e,
  0x309c: 0xff9f,
  0x30fb: 0xff65,
  0x30fc: 0xff70,
  0xffe5: 0x5c,
};

/** ASC(text): full-width ASCII and katakana to half-width; a voiced kana becomes kana and mark. */
export function toHalfWidth(text: string): string {
  let out = "";
  const ch = (...cs: number[]) => String.fromCharCode(...cs);
  for (const s of text) {
    const c = s.charCodeAt(0);
    if (c >= 0xff01 && c <= 0xff5e) out += ch(c - 0xff01 + 0x21);
    else if (c >= 0x30a1 && c <= 0x30aa)
      out += ch(c % 2 === 0 ? (c - 0x30a2) / 2 + 0xff71 : (c - 0x30a1) / 2 + 0xff67);
    else if (c >= 0x30ab && c <= 0x30c2)
      out += c % 2 === 1 ? ch((c - 0x30ab) / 2 + 0xff76) : ch((c - 0x30ac) / 2 + 0xff76, 0xff9e);
    else if (c >= 0x30c4 && c <= 0x30c9)
      out += c % 2 === 0 ? ch((c - 0x30c4) / 2 + 0xff82) : ch((c - 0x30c5) / 2 + 0xff82, 0xff9e);
    else if (c >= 0x30ca && c <= 0x30ce) out += ch(c - 0x30ca + 0xff85);
    else if (c >= 0x30cf && c <= 0x30dd) {
      const k = c % 3;
      const base = Math.floor((c - 0x30cf) / 3) + 0xff8a;
      out += k === 0 ? ch(base) : ch(base, k === 1 ? 0xff9e : 0xff9f);
    } else if (c >= 0x30de && c <= 0x30e2) out += ch(c - 0x30de + 0xff8f);
    else if (c >= 0x30e3 && c <= 0x30e8)
      out += ch(c % 2 === 0 ? (c - 0x30e4) / 2 + 0xff94 : (c - 0x30e3) / 2 + 0xff6c);
    else if (c >= 0x30e9 && c <= 0x30ed) out += ch(c - 0x30e9 + 0xff97);
    else out += TO_HALF[c] !== undefined ? ch(TO_HALF[c]) : s;
  }
  return out;
}
