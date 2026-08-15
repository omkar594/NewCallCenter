import axios from 'axios';

// Free-form Hinglish -> native-script transliteration via Google Input Tools' transliteration
// endpoint (the same engine behind Gboard's Hindi/Marathi transliteration keyboard) - chosen
// because rule-based schemes (ITRANS/Harvard-Kyoto) require the typist to already know a strict
// phonetic convention, which defeats the point for a client who just wants to type "namaste"
// naturally. This is an UNOFFICIAL, undocumented Google endpoint (no API key, no SLA) - it could
// change or go away without notice, hence the per-token try/catch fallback below. Only ever
// called on flow-authoring text (a tenant admin composing a script), never on live caller data.
const ENDPOINT = 'https://inputtools.google.com/request';

// Google's own itc (input tool code) per language - the '-t-i0-und' transliteration variant is
// the same one Gboard uses for phonetic typing, as opposed to a fixed keyboard layout.
const ITC_BY_LANGUAGE = {
  'hi-IN': 'hi-t-i0-und',
  'mr-IN': 'mr-t-i0-und'
};

// Splits into alternating word/non-word tokens so punctuation and spacing pass through
// unchanged - only actual Latin-letter word tokens get sent for transliteration.
function tokenize(text) {
  return text.match(/[A-Za-z]+|[^A-Za-z]+/g) || [];
}

export function supportsTransliteration(languageCode) {
  return Boolean(ITC_BY_LANGUAGE[languageCode]);
}

export async function transliterateToNativeScript(text, languageCode) {
  const itc = ITC_BY_LANGUAGE[languageCode];
  if (!itc) {
    throw new Error(`Transliteration not supported for language "${languageCode}"`);
  }
  const tokens = tokenize(text);
  const results = await Promise.all(
    tokens.map(async (token) => {
      if (!/[A-Za-z]/.test(token)) return token; // punctuation/whitespace passes through as-is
      try {
        const { data } = await axios.get(ENDPOINT, {
          params: { text: token, itc, num: 1, cp: 0, cs: 1, ie: 'utf-8', oe: 'utf-8' },
          timeout: 5000
        });
        const suggestion = data?.[1]?.[0]?.[1]?.[0];
        return suggestion || token;
      } catch (err) {
        console.warn(`[Transliteration] Failed for token "${token}": ${err.message} - leaving as-is`);
        return token;
      }
    })
  );
  return results.join('');
}
