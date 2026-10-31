/**
 * The past tense, end to end inside the engine: read before, compare after.
 *
 * These drive `captureBaselines` and `evaluatePredicate` together, because the two halves are only
 * correct with respect to each other — a capture keyed differently from the lookup produces a
 * predicate that parses, evaluates, and silently never compares anything.
 */

import { describe, expect, it } from 'vitest';
import { MeasureOp } from 'open-verification';
import { ReticleCommand, type CommandResult } from '@reticlehq/core';
import { captureBaselines, needsBaseline } from './baseline.js';
import { readsDomState } from './already-true.js';
import { evaluatePredicate } from '@/question/predicate/predicate.js';
import { parsePredicate } from '@/question/predicate/predicate-parse.js';
import type { PredicateSession } from '@/question/predicate/predicate-session.js';

/** A store whose value the test moves between the two readings. */
function storeHolding(readings: unknown[]): PredicateSession {
  let look = 0;
  return {
    id: 's1',
    url: 'http://localhost/',
    elapsed: () => 0,
    eventsSince: () => [],
    command: (name: string): Promise<CommandResult> => {
      const value = readings[Math.min(look, readings.length - 1)];
      if (name === ReticleCommand.STATE_READ) look++;
      return Promise.resolve({
        kind: 'command_result',
        id: 'c',
        ok: true,
        result: name === ReticleCommand.STATE_READ ? { found: true, value } : {},
      } as CommandResult);
    },
  } as unknown as PredicateSession;
}

const total = (satisfies: Record<string, unknown>): ReturnType<typeof parsePredicate> =>
  parsePredicate({ kind: 'state', store: 'app', path: 'cart.total', satisfies });

describe('captureBaselines', () => {
  it('reads nothing when nothing asked for a comparison', async () => {
    const predicate = total({ property: 'nonEmpty' });
    expect(needsBaseline(predicate)).toBe(false);
    expect((await captureBaselines(storeHolding([1]), predicate)).size).toBe(0);
  });

  it('finds a comparing leaf nested inside a composite', () => {
    const predicate = parsePredicate({
      kind: 'allOf',
      predicates: [
        { kind: 'signal', name: 'cart:updated' },
        { kind: 'state', store: 'app', path: 'cart.total', satisfies: { property: 'decreased' } },
      ],
    });
    expect(needsBaseline(predicate)).toBe(true);
  });
});

describe('a relative assertion, before and after', () => {
  it('the balance decreased by exactly the amount charged', async () => {
    const session = storeHolding([100, 88]);
    const predicate = total({
      property: 'decreased',
      by: { op: MeasureOp.EQUALS, value: 12 },
    });
    const baselines = await captureBaselines(session, predicate);
    expect((await evaluatePredicate(session, predicate, 0, false, baselines)).pass).toBe(true);
  });

  // The whole point: it goes RED when the app charges the right amount and shows the wrong one.
  it('goes red when the displayed total moved by the wrong amount', async () => {
    const session = storeHolding([100, 90]);
    const predicate = total({
      property: 'decreased',
      by: { op: MeasureOp.EQUALS, value: 12 },
    });
    const baselines = await captureBaselines(session, predicate);
    const result = await evaluatePredicate(session, predicate, 0, false, baselines);
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeUndefined();
  });

  /*
   * A comparison nobody took a reading for is UNEVALUATED, never a failure. Without this the
   * relative properties would parse, evaluate, and report every app as broken.
   */
  it('is inconclusive with no baseline, not a failure', async () => {
    const session = storeHolding([100, 88]);
    const result = await evaluatePredicate(session, total({ property: 'decreased' }), 0, false);
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toContain('before the action');
  });
});

/*
 * `unchanged` is true against a baseline taken a microsecond earlier, ALWAYS. Pre-checking it would
 * report `already_true` — and so UNKNOWN — for the one assertion whose entire purpose is that the
 * value survives what happens next.
 */
describe('the pre-action check skips a relative leaf', () => {
  it('does not pre-check state carrying a relative property', () => {
    expect(readsDomState(total({ property: 'unchanged' }))).toBe(false);
    expect(readsDomState(total({ property: 'nonEmpty' }))).toBe(true);
  });

  it('still pre-checks a plain state predicate', () => {
    expect(readsDomState(parsePredicate({ kind: 'state', path: 'view', equals: 'compose' }))).toBe(
      true,
    );
  });
});

/*
 * A page whose SDK predates `matchCase` (or reports no version) refuses the whole query for that
 * key. The baseline read used to give up on that refusal, so a `changed` text check had nothing to
 * compare against and never graded. It now asks again without the key, like the verdict does.
 */
describe('a text baseline on an SDK that refuses matchCase', () => {
  const REFUSAL = "Unrecognized key(s) in object: 'matchCase'";

  function oldPage(texts: string[], refusal = REFUSAL): PredicateSession {
    let reads = 0;
    return {
      id: 's1',
      url: 'http://localhost/',
      elapsed: () => 0,
      eventsSince: () => [],
      command: (_name: string, args: unknown): Promise<CommandResult> => {
        const query = (args as { query: Record<string, unknown> }).query;
        if ('matchCase' in query) {
          return Promise.resolve({ kind: 'command_result', id: 'c', ok: false, error: refusal });
        }
        const text = texts[Math.min(reads++, texts.length - 1)] ?? '';
        const elements = [
          { ref: 'e0', role: 'paragraph', name: '', text, states: [], visible: true },
        ];
        return Promise.resolve({
          kind: 'command_result',
          id: 'c',
          ok: true,
          result: { matched: true, count: 1, elements, fullText: true },
        });
      },
    } as unknown as PredicateSession;
  }

  const changed = parsePredicate({
    kind: 'text',
    contains: 'Total',
    satisfies: { property: 'changed' },
  });

  it('still takes the baseline, so a changed text grades yes', async () => {
    const page = oldPage(['Total 10', 'Total 12']);
    const baselines = await captureBaselines(page, changed);
    expect(baselines.size).toBe(1);
    expect((await evaluatePredicate(page, changed, 0, false, baselines)).pass).toBe(true);
  });

  it('grades an unchanged text no', async () => {
    const page = oldPage(['Total 10', 'Total 10']);
    const baselines = await captureBaselines(page, changed);
    const result = await evaluatePredicate(page, changed, 0, false, baselines);
    expect(result.pass).toBe(false);
    expect(result.inconclusive).toBeUndefined();
  });

  it('still gives no baseline when the refusal is about something else', async () => {
    const page = oldPage(['Total 10'], 'the matcher threw: boom');
    expect((await captureBaselines(page, changed)).size).toBe(0);
  });
});
