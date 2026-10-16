import { fail } from '../../core/errors.mjs';

// Match platform 098ba4034b80c1d704cf96398a41da94f2b879af:
// src/managed-mail/headers.ts:3-8,21-40,44-50 and src/platform/mail.ts:20.
const atom = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const dotAtom = atom + '(?:\\.' + atom + ')*';
const word = atom + '|"(?:[\\x20-\\x21\\x23-\\x5b\\x5d-\\x7e]|\\\\[\\x20-\\x7e])*"';
const listIdPattern = new RegExp('^[ \\t]*(?:(?:' + word + ')(?:[ \\t]+(?:' + word + '))*[ \\t]*)?<(' + atom + '(?:\\.' + atom + ')+)>[ \\t]*$');
const messageIdPattern = new RegExp('^<' + dotAtom + '@(?:' + dotAtom + '|\\[[\\x21-\\x5a\\x5e-\\x7e]*\\])>$');
const controls = /[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const listEntries = /^[ \t]*<([^<>\s]+)>[ \t]*(?:,[ \t]*<([^<>\s]+)>[ \t]*)?$/;
const mailbox = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const fields = new Map([
  ['list-id', ['listId', 'invalid_list_id']],
  ['list-archive', ['listArchive', 'invalid_list_archive']],
  ['list-help', ['listHelp', 'invalid_list_help']],
  ['in-reply-to', ['inReplyTo', 'invalid_in_reply_to']],
  ['references', ['references', 'invalid_references']],
]);

/** The relay's Message-ID, when its 202 body carries one in the grammar it accepts back as In-Reply-To/References. */
export function rerMessageId(value) {
  return typeof value === 'string' && value.length <= 2000 && messageIdPattern.test(value) ? value : null;
}

/** Validate a supported list/thread header and return its relay field, or null. */
export function rerListHeaderField(name, value) {
  const mapping = fields.get(name.toLowerCase());
  if (!mapping) return null;
  const [field, code] = mapping;
  if (typeof value !== 'string' || value.length > 2000 || controls.test(value)) fail(code);
  if (field === 'listId') {
    const match = listIdPattern.exec(value);
    if (!match || match[1].length > 255) fail(code);
  } else if (field === 'listArchive' || field === 'listHelp') {
    const entries = value.match(listEntries);
    if (!entries) fail(code);
    for (const entry of entries.slice(1).filter(Boolean)) {
      let url;
      try { url = new URL(entry); } catch { fail(code); }
      if (/^https:\/\//i.test(entry) && url.protocol === 'https:' && url.hostname && !entry.includes('\\')) continue;
      if (url.protocol !== 'mailto:' || !mailbox.test(url.pathname)) fail(code);
    }
  } else {
    const ids = field === 'references' ? value.split(/ +/) : [value];
    if (!value || ids.length > (field === 'references' ? 20 : 1) || ids.some(id => !messageIdPattern.test(id))) fail(code);
  }
  return field;
}
