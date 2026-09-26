// Language suggestions, ported from metadataEditor.jsx renderLanguageDropdown: the codes upstream
// offers, each with its own name (Intl.DisplayNames) as detail and the English name as a keyword.
// Any other code matching LANG_PATTERN can still be typed.
import type { ComboboxOption } from '@/ported/tagInput/comboboxModel';

export const LANG_CODES = ['de', 'de-ch', 'en', 'es', 'fr', 'it', 'ja', 'ru', 'sv', 'zh-Hans', 'zh-Hant'] as const;

function displayName(code: string, locale: string): string | undefined {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code);
  } catch {
    return undefined;
  }
}

export function languageOptions(codes: readonly string[] = LANG_CODES): ComboboxOption[] {
  return codes.map((code) => {
    const own = displayName(code, code);
    const english = displayName(code, 'en');
    return {
      value: code,
      label: code,
      ...(own ? { detail: own } : {}),
      ...(english ? { keywords: [english] } : {}),
    };
  });
}
