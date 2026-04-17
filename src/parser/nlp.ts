import * as chrono from "chrono-node";

export interface ParsedDate {
  date: Date;
  hasTime: boolean;
  text: string; // The matched text that was parsed
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DATE_SHORTHANDS: [RegExp, string][] = [
  // Multi-word shorthands first (longer matches before shorter)
  [/\bnxt\s+wk\b/gi, "next week"],
  [/\bnxt\s+mon\b/gi, "next Monday"],
  [/\bnxt\s+tue\b/gi, "next Tuesday"],
  [/\bnxt\s+wed\b/gi, "next Wednesday"],
  [/\bnxt\s+thu\b/gi, "next Thursday"],
  [/\bnxt\s+fri\b/gi, "next Friday"],
  [/\bnxt\s+sat\b/gi, "next Saturday"],
  [/\bnxt\s+sun\b/gi, "next Sunday"],
  // Single-word shorthands
  [/\btod\b/gi, "today"],
  [/\btom\b/gi, "tomorrow"],
  [/\byd\b/gi, "yesterday"],
  [/\bnw\b/gi, "now"],
  [/\bmon\b/gi, "Monday"],
  [/\btue\b/gi, "Tuesday"],
  [/\bwed\b/gi, "Wednesday"],
  [/\bthu\b/gi, "Thursday"],
  [/\bfri\b/gi, "Friday"],
  [/\bsat\b/gi, "Saturday"],
  [/\bsun\b/gi, "Sunday"],
  [/\beod\b/gi, "end of day"],
  [/\beow\b/gi, "end of week"],
  [/\beom\b/gi, "end of month"],
];

const SINGLE_TOKEN_DATE_KEYWORDS = [
  "tod",
  "tom",
  "yd",
  "nw",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
  "today",
  "tomorrow",
  "yesterday",
  "now",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "eod",
  "eow",
  "eom",
  "end of day",
  "end of week",
  "end of month",
] as const;

const SINGLE_TOKEN_DATE_SHORTHANDS = [
  "tod",
  "tom",
  "yd",
  "nw",
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
  "eod",
  "eow",
  "eom",
] as const;

function trimOvermatchedTrailingLetter(parsedText: string): string {
  const trimmed = parsedText.trim();
  const match = trimmed.match(/^(.+?)\s+([A-Za-z])$/);
  if (!match) return trimmed;

  const keyword = match[1].toLowerCase();
  if (SINGLE_TOKEN_DATE_KEYWORDS.includes(keyword as (typeof SINGLE_TOKEN_DATE_KEYWORDS)[number])) {
    return match[1];
  }

  return trimmed;
}

function collapseSingleTokenShorthandMatch(parsedText: string): string {
  const trimmed = parsedText.trim();
  const [firstWord, ...restWords] = trimmed.split(/\s+/);
  if (!firstWord) return trimmed;

  const remainder = restWords.join(" ");

  const lowered = firstWord.toLowerCase();
  if (
    SINGLE_TOKEN_DATE_SHORTHANDS.includes(lowered as (typeof SINGLE_TOKEN_DATE_SHORTHANDS)[number])
  ) {
    if (looksLikeDateContinuation(remainder)) {
      return trimmed;
    }
    return firstWord;
  }

  return trimmed;
}

function looksLikeDateContinuation(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  return (
    /^(?:at|by|before|on)\b/i.test(trimmed) ||
    /^\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i.test(trimmed) ||
    /^(?:noon|midnight|morning|afternoon|evening|tonight)\b/i.test(trimmed)
  );
}

/** Expand shorthand date abbreviations (tod, tom, mon, etc.) to full words for chrono-node. */
export function expandDateShorthands(input: string): string {
  let result = input;
  for (const [pattern, replacement] of DATE_SHORTHANDS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Extract date/time from natural language input.
 * Uses chrono-node for parsing.
 *
 * Examples:
 *  "tomorrow at 3pm" → { date: <tomorrow 15:00>, hasTime: true }
 *  "next Friday" → { date: <next Friday>, hasTime: false }
 *  "in 2 hours" → { date: <now + 2h>, hasTime: true }
 *  "tod" → { date: <today>, hasTime: false }
 *  "tom" → { date: <tomorrow>, hasTime: false }
 */
export function parseDate(input: string, referenceDate?: Date): ParsedDate | null {
  const expanded = expandDateShorthands(input);
  const results = chrono.parse(expanded, referenceDate ?? new Date());
  if (results.length === 0) return null;

  const result = results[0];
  const hasTime = result.start.isCertain("hour");

  // Map the matched range back to the original input (shorthands may differ in length)
  const originalText = input.substring(
    result.index,
    result.index + findOriginalLength(input, expanded, result.index, result.text.length),
  );

  const matchedText = collapseSingleTokenShorthandMatch(
    trimOvermatchedTrailingLetter(originalText || result.text),
  );

  return {
    date: result.start.date(),
    hasTime,
    text: matchedText,
  };
}

/** Find the length of the original text that corresponds to an expanded match. */
function findOriginalLength(
  original: string,
  expanded: string,
  expandedStart: number,
  expandedLen: number,
): number {
  // If no expansion happened, lengths match directly
  if (original === expanded) return expandedLen;

  // Build a character mapping from expanded positions back to original positions
  let origPos = 0;
  let expPos = 0;
  const origPositions: number[] = [];

  while (expPos < expanded.length && origPos <= original.length) {
    origPositions[expPos] = origPos;
    // Check if a shorthand expansion starts here by comparing divergence
    if (original[origPos] === expanded[expPos]) {
      origPos++;
      expPos++;
    } else {
      // Find which shorthand was expanded at this position
      let matched = false;
      for (const [pattern, replacement] of DATE_SHORTHANDS) {
        const origSlice = original.substring(origPos);
        const m = origSlice.match(new RegExp("^" + pattern.source, "i"));
        if (m && expanded.substring(expPos, expPos + replacement.length) === replacement) {
          // Map all expanded positions to the original shorthand range
          for (let i = 0; i < replacement.length; i++) {
            origPositions[expPos + i] = origPos;
          }
          origPos += m[0].length;
          expPos += replacement.length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        origPos++;
        expPos++;
      }
    }
  }
  origPositions[expanded.length] = original.length;

  const origStart = origPositions[expandedStart] ?? expandedStart;
  const origEnd = origPositions[expandedStart + expandedLen] ?? origStart + expandedLen;
  return origEnd - origStart;
}

/** Remove the date/time portion from input text, returning the remaining string. */
export function removeDateText(input: string, parsedText: string): string {
  const escapedDateText = escapeRegExp(parsedText.trim());
  const connectorDatePattern = new RegExp(`\\b(?:by|on|at|before)\\s+${escapedDateText}\\b`, "i");

  let result = input.replace(connectorDatePattern, "");
  if (result === input) {
    result = input.replace(parsedText, "");
  }

  return result
    .replace(/\s+/g, " ")
    .replace(/\b(by|on|at|before)\s*$/i, "")
    .trim();
}
