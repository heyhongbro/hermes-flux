import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { extractMessageAttachments, formatAttachmentPromptText } from '../../dist/index.js';

const safeNameArb = fc
  .stringMatching(/^[a-zA-Z0-9_-]{1,14}\.(png|jpg|pdf|md|txt)$/);

test('INV-MSG-01: formatAttachmentPromptText -> extractMessageAttachments 在任意文本与附件组合下往返无损', () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 60 }).filter((s) => !s.startsWith('[附件列表]') && !s.startsWith('[Attachment List]')),
      fc.array(
        fc.record({
          id: fc.stringMatching(/^a[0-9]{1,4}$/),
          name: safeNameArb,
          type: fc.constantFrom('image', 'file', 'pdf'),
        }),
        { minLength: 1, maxLength: 5 },
      ),
      fc.constantFrom('附件列表', 'Attachment List'),
      (rawText, attachments, header) => {
        const encoded = formatAttachmentPromptText(rawText, attachments, header);
        const decoded = extractMessageAttachments(encoded);
        assert.equal(decoded.cleanText, rawText.trim());
        assert.equal(decoded.attachments.length, attachments.length);
        for (let i = 0; i < attachments.length; i++) {
          assert.equal(decoded.attachments[i].name, attachments[i].name);
        }
      },
    ),
    { numRuns: 80 },
  );
});
