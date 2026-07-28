import { Fr } from '@aztec/foundation/curves/bn254';

import {
  FEEDBACK_FIELDS,
  MAX_FEEDBACK_TEXT_CHARS,
  openFeedbackBlob,
  sealFeedbackBlob,
} from './feedback.js';

const SECRET = new Fr(987654321n);

describe('sealFeedbackBlob / openFeedbackBlob', () => {
  it('round-trips a rating with text', async () => {
    const blob = await sealFeedbackBlob({ rating: 4, text: 'Fast shipping, as described.' }, SECRET);
    expect(blob).toHaveLength(FEEDBACK_FIELDS);
    expect(blob[0]!.isZero()).toBe(false); // the contract's non-empty check
    const doc = await openFeedbackBlob(blob, SECRET);
    expect(doc.rating).toBe(4);
    expect(doc.text).toBe('Fast shipping, as described.');
  });

  it('round-trips a rating-only review and the longest allowed text', async () => {
    const bare = await openFeedbackBlob(await sealFeedbackBlob({ rating: 5, text: '' }, SECRET), SECRET);
    expect(bare).toEqual({ schemaVersion: 1, rating: 5, text: '' });

    const long = 'x'.repeat(MAX_FEEDBACK_TEXT_CHARS);
    const doc = await openFeedbackBlob(await sealFeedbackBlob({ rating: 1, text: long }, SECRET), SECRET);
    expect(doc.text).toBe(long);
  });

  it('rejects invalid ratings and overlong text at sealing time', async () => {
    await expect(sealFeedbackBlob({ rating: 0, text: 'x' }, SECRET)).rejects.toThrow('feedback.rating');
    await expect(sealFeedbackBlob({ rating: 6, text: 'x' }, SECRET)).rejects.toThrow('feedback.rating');
    await expect(sealFeedbackBlob({ rating: 2.5, text: 'x' }, SECRET)).rejects.toThrow('feedback.rating');
    await expect(
      sealFeedbackBlob({ rating: 3, text: 'x'.repeat(MAX_FEEDBACK_TEXT_CHARS + 1) }, SECRET),
    ).rejects.toThrow('feedback.text');
  });

  it('rejects a wrong secret and garbage chunks (adversarial input is skippable)', async () => {
    const blob = await sealFeedbackBlob({ rating: 3, text: 'ok' }, SECRET);
    await expect(openFeedbackBlob(blob, new Fr(42n))).rejects.toThrow(
      'wrong access secret or tampered blob',
    );

    // A hostile buyer can store anything; readers must be able to detect it.
    const garbage = Array.from({ length: FEEDBACK_FIELDS }, (_, i) => new Fr(BigInt(i + 1)));
    await expect(openFeedbackBlob(garbage, SECRET)).rejects.toThrow();

    const zeroLen = [...blob];
    zeroLen[0] = new Fr(0n);
    await expect(openFeedbackBlob(zeroLen, SECRET)).rejects.toThrow();
  });
});
