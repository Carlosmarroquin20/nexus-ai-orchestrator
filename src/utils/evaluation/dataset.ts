/**
 * Evaluation dataset format and its defensive parser (ADR 0010).
 *
 * A dataset is a versioned list of cases. Each case supplies the run input and a
 * list of checks; each check names the node whose output it inspects and how to
 * score it. Datasets are authored as JSON under version control, so the parser
 * treats them like any other untrusted document: it validates structure, rejects
 * unknown schema versions instead of guessing, and reports the first problem with
 * enough context (case id, check index) to fix the file.
 *
 * Node ids are not checked here, since a dataset is written against a pipeline it
 * does not contain; `findUnknownNodeIds` performs that check against a graph.
 * Pure and framework-agnostic.
 */

import { isRecord, isString } from '../guards';

import { normalizeOutput } from './normalize';
import { compileSafeRegex } from './safeRegex';

export const EVAL_DATASET_SCHEMA_VERSION = 1 as const;

/** Bounds that keep a dataset within what one evaluation request can carry. */
export const MAX_EVAL_CASES = 100;
export const MAX_CHECKS_PER_CASE = 20;
export const MAX_CASE_INPUT_LENGTH = 20_000;
/**
 * Regex checks run on the server through a linear-time engine (`safeRegex.ts`),
 * so pattern length bounds compile cost and keeps datasets readable rather than
 * guarding against backtracking.
 */
export const MAX_REGEX_PATTERN_LENGTH = 200;
/** Bound on the grading criteria of an LLM judge check; they become part of the judge prompt. */
export const MAX_JUDGE_CRITERIA_LENGTH = 2_000;
/** The LLM judge grades on an integer scale from 1 (fails) to 5 (fully meets the criteria). */
export const JUDGE_SCALE = { min: 1, max: 5 } as const;
const DEFAULT_JUDGE_MIN_SCORE = 4;

interface CheckBase {
  /** Node whose output the check inspects. */
  readonly nodeId: string;
}

/** Normalized output equals `expected` (trimmed, collapsed whitespace, case-insensitive). */
export interface EqualsCheck extends CheckBase {
  readonly scorer: 'equals';
  readonly expected: string;
}

/** Normalized output contains `expected`. */
export interface ContainsCheck extends CheckBase {
  readonly scorer: 'contains';
  readonly expected: string;
}

/** Raw output matches `pattern`. */
export interface RegexCheck extends CheckBase {
  readonly scorer: 'regex';
  readonly pattern: string;
  readonly flags: string;
}

/** Normalized output equals any of `expected`. */
export interface OneOfCheck extends CheckBase {
  readonly scorer: 'oneOf';
  readonly expected: readonly string[];
}

/**
 * Free-text output graded by an LLM judge against `criteria`, on `JUDGE_SCALE`.
 * Passes when the grade is at least `minScore`.
 */
export interface LlmJudgeCheck extends CheckBase {
  readonly scorer: 'llm_judge';
  readonly criteria: string;
  readonly minScore: number;
}

/** Checks scored by pure functions, without a model. */
export type DeterministicCheck = EqualsCheck | ContainsCheck | RegexCheck | OneOfCheck;
export type EvalCheck = DeterministicCheck | LlmJudgeCheck;
export type ScorerKind = EvalCheck['scorer'];

export interface EvalCase {
  /** Stable id, unique within the dataset; used to compare evaluations case by case. */
  readonly id: string;
  readonly input: string;
  readonly description?: string;
  readonly checks: readonly EvalCheck[];
}

export interface EvalDataset {
  readonly version: typeof EVAL_DATASET_SCHEMA_VERSION;
  readonly name: string;
  readonly description?: string;
  readonly cases: readonly EvalCase[];
}

export type EvalDatasetParseResult =
  | { readonly ok: true; readonly dataset: EvalDataset }
  | { readonly ok: false; readonly error: string };

/** Thrown internally to abort parsing with a located message; never escapes. */
class DatasetError extends Error {}

const nonEmptyString = (value: unknown, what: string): string => {
  if (!isString(value) || value.trim().length === 0) {
    throw new DatasetError(`${what} must be a non-empty string.`);
  }
  return value;
};

/**
 * An expected value for a text comparison. It must keep some content once
 * normalized: one made only of punctuation would normalize to nothing, and
 * `contains` would then pass for any output.
 */
const expectedText = (value: unknown, what: string): string => {
  const text = nonEmptyString(value, what);
  if (normalizeOutput(text) === '') {
    throw new DatasetError(`${what} has no comparable content (only punctuation or whitespace).`);
  }
  return text;
};

const optionalString = (value: unknown, what: string): string | undefined => {
  if (value === undefined) return undefined;
  if (!isString(value)) throw new DatasetError(`${what} must be a string.`);
  return value;
};

const parseCheck = (raw: unknown, where: string): EvalCheck => {
  if (!isRecord(raw)) throw new DatasetError(`${where} must be an object.`);
  const nodeId = nonEmptyString(raw['nodeId'], `${where}.nodeId`);
  const scorer = raw['scorer'];

  switch (scorer) {
    case 'equals':
    case 'contains':
      return { scorer, nodeId, expected: expectedText(raw['expected'], `${where}.expected`) };
    case 'oneOf': {
      const expected = raw['expected'];
      if (!Array.isArray(expected) || expected.length === 0) {
        throw new DatasetError(`${where}.expected must be a non-empty array of strings.`);
      }
      return {
        scorer,
        nodeId,
        expected: expected.map((value, index) => expectedText(value, `${where}.expected[${index}]`)),
      };
    }
    case 'regex': {
      const pattern = nonEmptyString(raw['pattern'], `${where}.pattern`);
      if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
        throw new DatasetError(
          `${where}.pattern exceeds ${MAX_REGEX_PATTERN_LENGTH} characters.`,
        );
      }
      const flags = optionalString(raw['flags'], `${where}.flags`) ?? '';
      const compiled = compileSafeRegex(pattern, flags);
      if (!compiled.ok) throw new DatasetError(`${where}.${compiled.field} ${compiled.error}`);
      return { scorer, nodeId, pattern, flags };
    }
    case 'llm_judge': {
      const criteria = nonEmptyString(raw['criteria'], `${where}.criteria`);
      if (criteria.length > MAX_JUDGE_CRITERIA_LENGTH) {
        throw new DatasetError(
          `${where}.criteria exceeds ${MAX_JUDGE_CRITERIA_LENGTH} characters.`,
        );
      }
      // Only an absent field means the default; an explicit null is malformed.
      const rawMinScore = raw['minScore'] === undefined ? DEFAULT_JUDGE_MIN_SCORE : raw['minScore'];
      if (
        typeof rawMinScore !== 'number' ||
        !Number.isInteger(rawMinScore) ||
        rawMinScore < JUDGE_SCALE.min ||
        rawMinScore > JUDGE_SCALE.max
      ) {
        throw new DatasetError(
          `${where}.minScore must be an integer from ${JUDGE_SCALE.min} to ${JUDGE_SCALE.max}.`,
        );
      }
      return { scorer, nodeId, criteria, minScore: rawMinScore };
    }
    default:
      throw new DatasetError(
        `${where}.scorer must be one of equals, contains, regex, oneOf, llm_judge.`,
      );
  }
};

const parseCase = (raw: unknown, index: number): EvalCase => {
  const where = `cases[${index}]`;
  if (!isRecord(raw)) throw new DatasetError(`${where} must be an object.`);
  const id = nonEmptyString(raw['id'], `${where}.id`);
  const caseWhere = `case "${id}"`;

  const input = raw['input'];
  if (!isString(input) || input.length > MAX_CASE_INPUT_LENGTH) {
    throw new DatasetError(
      `${caseWhere}: input must be a string of at most ${MAX_CASE_INPUT_LENGTH} characters.`,
    );
  }
  const description = optionalString(raw['description'], `${caseWhere}: description`);

  const checks = raw['checks'];
  if (!Array.isArray(checks) || checks.length === 0) {
    throw new DatasetError(`${caseWhere}: checks must be a non-empty array.`);
  }
  if (checks.length > MAX_CHECKS_PER_CASE) {
    throw new DatasetError(`${caseWhere}: at most ${MAX_CHECKS_PER_CASE} checks are allowed.`);
  }

  return {
    id,
    input,
    ...(description !== undefined ? { description } : {}),
    checks: checks.map((check, checkIndex) => parseCheck(check, `${caseWhere}: checks[${checkIndex}]`)),
  };
};

/** Narrows arbitrary JSON into a validated dataset, or a located error message. */
export const parseEvalDataset = (raw: unknown): EvalDatasetParseResult => {
  try {
    if (!isRecord(raw)) throw new DatasetError('Dataset must be a JSON object.');
    if (raw['version'] !== EVAL_DATASET_SCHEMA_VERSION) {
      throw new DatasetError(
        `Unsupported dataset version (expected ${EVAL_DATASET_SCHEMA_VERSION}).`,
      );
    }
    const name = nonEmptyString(raw['name'], 'name');
    const description = optionalString(raw['description'], 'description');

    const rawCases = raw['cases'];
    if (!Array.isArray(rawCases) || rawCases.length === 0) {
      throw new DatasetError('cases must be a non-empty array.');
    }
    if (rawCases.length > MAX_EVAL_CASES) {
      throw new DatasetError(`At most ${MAX_EVAL_CASES} cases are allowed.`);
    }

    const cases = rawCases.map(parseCase);
    const seen = new Set<string>();
    for (const evalCase of cases) {
      if (seen.has(evalCase.id)) throw new DatasetError(`Duplicate case id "${evalCase.id}".`);
      seen.add(evalCase.id);
    }

    return {
      ok: true,
      dataset: {
        version: EVAL_DATASET_SCHEMA_VERSION,
        name,
        ...(description !== undefined ? { description } : {}),
        cases,
      },
    };
  } catch (error) {
    if (error instanceof DatasetError) return { ok: false, error: error.message };
    throw error;
  }
};

/**
 * Node ids referenced by the dataset's checks that the pipeline does not contain,
 * in first-reference order. Empty when the dataset fits the pipeline.
 */
export const findUnknownNodeIds = (
  dataset: EvalDataset,
  pipelineNodeIds: ReadonlySet<string>,
): string[] => {
  const unknown = new Set<string>();
  for (const evalCase of dataset.cases) {
    for (const check of evalCase.checks) {
      if (!pipelineNodeIds.has(check.nodeId)) unknown.add(check.nodeId);
    }
  }
  return [...unknown];
};
