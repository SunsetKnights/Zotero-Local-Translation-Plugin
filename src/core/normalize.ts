// Conservative text cleanup for the model input. The raw selection is preserved
// by the caller; only line endings, NUL, soft hyphens and runs of inline
// whitespace are touched. Numbers, signs, units, citations and blank lines stay.

export const MAX_INPUT_CODE_POINTS = 8000;

export interface NormalizedText {
  text: string;
  inputLength: number;
  removedNul: boolean;
  removedSoftHyphen: boolean;
}

const SOFT_HYPHEN = '\u00AD';

export function normalizeText(raw: string): NormalizedText {
  if (typeof raw !== 'string') {
    throw new TypeError('raw text must be a string');
  }

  let text = raw.replace(/\r\n?/g, '\n');

  const removedNul = text.includes('\u0000');
  if (removedNul) {
    text = text.split('\u0000').join('');
  }

  const removedSoftHyphen = text.includes(SOFT_HYPHEN);
  if (removedSoftHyphen) {
    text = text.split(SOFT_HYPHEN).join('');
  }

  // collapse spaces and tabs inside a line, keep line structure and blank lines
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n');

  // trim leading/trailing blank lines but keep internal paragraph breaks
  text = text.replace(/^\n+/, '').replace(/\n+$/, '');

  return {
    text,
    inputLength: [...text].length,
    removedNul,
    removedSoftHyphen,
  };
}

export function isBlank(text: string): boolean {
  return text.trim().length === 0;
}
