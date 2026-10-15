import { AuthError } from './errors.mjs';

// Canonical_Combining_Class=9 (Virama), Unicode 16. JavaScript regular
// expressions have no combining-class property, so the scalars are listed.
const VIRAMA = '\\u{94d}\\u{9cd}\\u{a4d}\\u{acd}\\u{b4d}\\u{bcd}\\u{c4d}\\u{ccd}\\u{d3b}-\\u{d3c}\\u{d4d}\\u{dca}\\u{e3a}\\u{eba}\\u{f84}'
  + '\\u{1039}-\\u{103a}\\u{1714}-\\u{1715}\\u{1734}\\u{17d2}\\u{1a60}\\u{1b44}\\u{1baa}-\\u{1bab}\\u{1bf2}-\\u{1bf3}\\u{2d7f}\\u{a806}\\u{a82c}'
  + '\\u{a8c4}\\u{a953}\\u{a9c0}\\u{aaf6}\\u{abed}\\u{10a3f}\\u{11046}\\u{11070}\\u{1107f}\\u{110b9}\\u{11133}-\\u{11134}\\u{111c0}'
  + '\\u{11235}\\u{112ea}\\u{1134d}\\u{113ce}-\\u{113d0}\\u{11442}\\u{114c2}\\u{115bf}\\u{1163f}\\u{116b6}\\u{1172b}\\u{11839}'
  + '\\u{1193d}-\\u{1193e}\\u{119e0}\\u{11a34}\\u{11a47}\\u{11a99}\\u{11c3f}\\u{11d44}-\\u{11d45}\\u{11d97}\\u{11f41}-\\u{11f42}\\u{1612f}';
const ZWJ_AFTER_VIRAMA = new RegExp(`(?<=\\p{L}\\p{M}*[${VIRAMA}])\\u200d`, 'gu');

function validProductName(name) {
  // Lone surrogates are not text; U+FFFC is a placeholder for an absent object.
  if (typeof name !== 'string' || name.length > 80 || !name.isWellFormed()) return false;
  // Braille blank is a symbol by category, but cannot make a name visible.
  if (!/(?!\u2800)[\p{L}\p{N}\p{P}\p{S}]/u.test(name)) return false;
  // Inspect a copy: retain script shaping and emoji presentation in the name
  // returned to callers, while rejecting every other default-ignorable scalar.
  const inspected = name
    // ZWNJ after a letter, before a letter or digit, optionally across spaces (Persian "کتاب‌ ها").
    .replace(/(?<=\p{L}\p{M}*)\u200c(?=\s*[\p{L}\p{Nd}])/gu, '')
    .replace(/(?<=\p{L}\p{M}*)\u200d(?=\p{L})/gu, '')
    // ZWJ after a virama forms explicit half forms and Malayalam chillu, also word-final.
    .replace(ZWJ_AFTER_VIRAMA, '')
    .replace(/(?<=\p{Extended_Pictographic}\ufe0f?\p{Emoji_Modifier}?)\u200d(?=\p{Extended_Pictographic})/gu, '')
    // U+FE0F selects emoji presentation of a pictograph, or of a keycap base only inside its keycap.
    .replace(/(?<=\p{Extended_Pictographic})\ufe0f/gu, '')
    .replace(/(?<=[0-9#*])\ufe0f(?=\u20e3)/gu, '');
  return !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffc\p{Default_Ignorable_Code_Point}]/u.test(inspected);
}

export function configureBranding(input = {}) {
  const invalid = () => { throw new AuthError('invalid_configuration', 503); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const { productName = 'your workspace', accentColor = '#334155', signInPath = '/signin', theme } = input;
  if (!validProductName(productName)) invalid();
  if (typeof accentColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(accentColor)) invalid();
  if (typeof signInPath !== 'string' || !signInPath.startsWith('/') || signInPath.startsWith('//') || /[\\\u0000-\u0020\u007f-\u009f]/u.test(signInPath)) invalid();
  if (signInPath.length > 2048) invalid();
  // Only the configured encoding must be well formed. Decoding %25 can produce
  // literal percent data, so subsequent inspection must tolerate it while still
  // revealing nested separators/control characters elsewhere in the route.
  let decoded;
  try { decoded = decodeURIComponent(signInPath); } catch { invalid(); }
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  for (;;) {
    if (decoded.startsWith('//') || /[\\\u0000-\u001f\u007f-\u009f]/u.test(decoded)) invalid();
    // Replacement characters for non-UTF-8 byte sequences are inspection-only;
    // no decoded or repaired value is ever returned to the consumer.
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/giu, (encoded) =>
      decoder.decode(Uint8Array.from(encoded.match(/[0-9a-f]{2}/giu), (byte) => parseInt(byte, 16))));
    if (next === decoded) break;
    decoded = next;
  }
  // A seed theme is its own served rer-theme.css; Base onboarding validates its contents.
  if (theme !== undefined && (typeof theme !== 'string' || !/^\/(?!\/)[A-Za-z0-9._~/-]{1,200}\.css$/.test(theme) || theme.includes('//') || theme.includes('/.'))) invalid();
  return Object.freeze({ productName: productName.trim(), accentColor, signInPath, ...(theme ? { theme } : {}) });
}

/** WCAG relative luminance chooses readable text for any permitted brand color. */
export function accentInk(color) {
  const channels = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.179 ? '#000000' : '#ffffff';
}
