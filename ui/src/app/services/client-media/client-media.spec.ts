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

import {TestBed} from '@angular/core/testing';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ClientMediaService} from './client-media';

// Note: convertImage / convertVideoToImage / canvasFromMedia draw to a real
// canvas 2D context and wait for <img>/<video> load events, which jsdom does not
// implement. Those are exercised in a real browser (and via the higher-level
// composition specs); here we cover the pure/FileReader-backed helpers.
describe('ClientMediaService', () => {
  let service: ClientMediaService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [ClientMediaService],
    });
    service = TestBed.inject(ClientMediaService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('toFile', () => {
    it('derives the file name and type from the blob type by default', () => {
      const file = service.toFile(new Blob(['x'], {type: 'image/png'}));
      expect(file).toBeInstanceOf(File);
      expect(file.type).toBe('image/png');
      expect(file.name).toBe('thumbnail.png');
    });

    it('falls back to image/jpeg when the blob has no type', () => {
      const file = service.toFile(new Blob(['x']));
      expect(file.type).toBe('image/jpeg');
      expect(file.name).toBe('thumbnail.jpeg');
    });

    it('honors an explicit file name and mime type', () => {
      const file = service.toFile(new Blob(['x'], {type: 'image/png'}), {
        fileName: 'custom.webp',
        mimeType: 'image/webp',
      });
      expect(file.name).toBe('custom.webp');
      expect(file.type).toBe('image/webp');
    });
  });

  describe('toBase64', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('encodes a blob as a data: URL carrying its mime type', async () => {
      const result = await service.toBase64(
        new Blob(['hello'], {type: 'text/plain'}),
      );
      expect(result.startsWith('data:text/plain;base64,')).toBe(true);
      // base64 of "hello".
      expect(result).toContain('aGVsbG8=');
    });

    it('rejects (does not hang) when the reader yields a non-string result', async () => {
      // A FileReader whose result is null must reject the promise, not throw
      // inside the async callback where the error would be swallowed and the
      // awaiting caller would hang forever.
      class NullResultFileReader {
        result: string | null = null;
        onloadend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL(): void {
          // Fire the load callback asynchronously, as the real reader does.
          queueMicrotask(() => this.onloadend?.());
        }
      }
      vi.stubGlobal('FileReader', NullResultFileReader);

      await expect(
        service.toBase64(new Blob(['x'], {type: 'image/png'})),
      ).rejects.toThrow('Failed to convert blob to base64');
    });
  });
});
