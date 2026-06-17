/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {describe, expect, it} from 'vitest';
import {ImageImportService} from './image-import';

// A minimal valid base64 image payload: PNG magic bytes padded to 12 bytes
// (16 base64 chars, the minimum the raw-base64 path accepts).
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);
const PNG_B64 = btoa(String.fromCharCode(...PNG_BYTES));

// Builds a DataTransfer-like object with only the fields the service reads.
function dataTransfer(parts: {
  items?: Array<{kind: string; type: string; getAsFile: () => File | null}>;
  files?: File[];
  data?: Record<string, string>;
}): DataTransfer {
  return {
    items: parts.items,
    files: parts.files,
    getData: (type: string) => parts.data?.[type] ?? '',
  } as unknown as DataTransfer;
}

describe('ImageImportService', () => {
  const service = new ImageImportService();

  describe('base64ToFile', () => {
    it('decodes a data: URI image into a typed File', () => {
      const file = service.base64ToFile(`data:image/png;base64,${PNG_B64}`);
      expect(file).toBeInstanceOf(File);
      expect(file!.type).toBe('image/png');
      expect(file!.name).toBe('pasted-image.png');
    });

    it('sniffs the type of a raw base64 image with no data: prefix', () => {
      const file = service.base64ToFile(PNG_B64);
      expect(file).toBeInstanceOf(File);
      expect(file!.type).toBe('image/png');
    });

    it('rejects a non-image data: URI type', () => {
      // text/plain is not in the allowed image set, and the raw-base64 fallback
      // rejects the ':' '/' ';' ',' characters, so this is not an image.
      expect(
        service.base64ToFile(`data:text/plain;base64,${PNG_B64}`),
      ).toBeNull();
    });

    it('rejects text that is too short or not base64', () => {
      expect(service.base64ToFile('short')).toBeNull();
      expect(service.base64ToFile('not valid base64 !!')).toBeNull();
    });

    it('rejects raw base64 whose bytes are not a known image format', () => {
      const notImage = btoa('this is plainly not an image header at all');
      expect(service.base64ToFile(notImage)).toBeNull();
    });
  });

  describe('isEditableTarget', () => {
    it('is true for form fields and contentEditable, false otherwise', () => {
      expect(
        service.isEditableTarget({tagName: 'INPUT'} as unknown as Element),
      ).toBe(true);
      expect(
        service.isEditableTarget({tagName: 'TEXTAREA'} as unknown as Element),
      ).toBe(true);
      expect(
        service.isEditableTarget({tagName: 'SELECT'} as unknown as Element),
      ).toBe(true);
      expect(
        service.isEditableTarget({
          tagName: 'DIV',
          isContentEditable: true,
        } as unknown as Element),
      ).toBe(true);
      expect(
        service.isEditableTarget({
          tagName: 'DIV',
          isContentEditable: false,
        } as unknown as Element),
      ).toBe(false);
      expect(service.isEditableTarget(null)).toBe(false);
    });
  });

  describe('imageUrlFromDataTransfer', () => {
    it('prefers the uri-list, skipping comment lines', () => {
      const dt = dataTransfer({
        data: {'text/uri-list': '# a comment\r\nhttps://example.com/a.png'},
      });
      expect(service.imageUrlFromDataTransfer(dt)).toBe(
        'https://example.com/a.png',
      );
    });

    it('falls back to an <img> src in dragged HTML', () => {
      const dt = dataTransfer({
        data: {'text/html': '<p><img src="https://example.com/b.jpg"></p>'},
      });
      expect(service.imageUrlFromDataTransfer(dt)).toBe(
        'https://example.com/b.jpg',
      );
    });

    it('falls back to plain text only when it looks like an image source', () => {
      expect(
        service.imageUrlFromDataTransfer(
          dataTransfer({data: {'text/plain': 'https://example.com/c.gif'}}),
        ),
      ).toBe('https://example.com/c.gif');
      expect(
        service.imageUrlFromDataTransfer(
          dataTransfer({data: {'text/plain': 'just some words'}}),
        ),
      ).toBeNull();
    });

    it('returns null for a missing DataTransfer', () => {
      expect(service.imageUrlFromDataTransfer(null)).toBeNull();
    });
  });

  describe('imageFilesFromDataTransfer', () => {
    it('keeps only image files from the drop', () => {
      const png = new File([PNG_BYTES], 'a.png', {type: 'image/png'});
      const txt = new File(['x'], 'b.txt', {type: 'text/plain'});
      const files = service.imageFilesFromDataTransfer(
        dataTransfer({files: [png, txt]}),
      );
      expect(files).toEqual([png]);
    });

    it('extracts a pasted screenshot from items', () => {
      const png = new File([PNG_BYTES], 'shot.png', {type: 'image/png'});
      const files = service.imageFilesFromDataTransfer(
        dataTransfer({
          items: [{kind: 'file', type: 'image/png', getAsFile: () => png}],
          files: [],
        }),
      );
      expect(files).toEqual([png]);
    });

    it('returns an empty array for no DataTransfer', () => {
      expect(service.imageFilesFromDataTransfer(null)).toEqual([]);
    });
  });

  describe('importText', () => {
    it('resolves base64 tokens to files and reports the rest as failures', async () => {
      const {files, failures} = await service.importText(
        `${PNG_B64} not-an-image!!`,
      );
      expect(files).toHaveLength(1);
      expect(files[0]).toBeInstanceOf(File);
      expect(failures).toHaveLength(1);
      expect(failures[0].reason).toContain('not a valid image');
    });

    it('reassembles a newline-wrapped raw base64 image into one file', async () => {
      // A longer PNG payload so it actually spans several wrapped lines.
      const longBytes = new Uint8Array(120);
      longBytes.set([0x89, 0x50, 0x4e, 0x47]); // PNG magic so the sniff passes.
      const longB64 = btoa(String.fromCharCode(...longBytes));
      // Hard-wrap every 16 chars, as a mail/text client would on paste.
      const wrapped = longB64.replace(/(.{16})/g, '$1\n');
      expect(wrapped).toContain('\n');

      const {files, failures} = await service.importText(wrapped);
      expect(failures).toHaveLength(0);
      expect(files).toHaveLength(1);
      expect(files[0].type).toBe('image/png');
    });

    it('reassembles a newline-wrapped data: URI image into one file', async () => {
      const dataUri = `data:image/png;base64,${PNG_B64}`;
      const wrapped = dataUri.replace(/(.{12})/g, '$1\n');
      expect(wrapped).toContain('\n');

      const {files, failures} = await service.importText(wrapped);
      expect(failures).toHaveLength(0);
      expect(files).toHaveLength(1);
      expect(files[0].type).toBe('image/png');
    });

    it('keeps a one-URL-per-line list as separate entries', async () => {
      // Both URLs fail to fetch in jsdom, but each must be reported on its own
      // (not joined into a single token).
      const {failures} = await service.importText(
        'https://example.com/a.png\nhttps://example.com/b.png',
      );
      expect(failures).toHaveLength(2);
      expect(failures.map(f => f.source)).toEqual([
        'https://example.com/a.png',
        'https://example.com/b.png',
      ]);
    });
  });
});
