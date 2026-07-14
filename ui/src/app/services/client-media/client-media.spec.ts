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

  describe('canvas conversion failures', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('rejects convertImage when canvas encoding returns no blob', async () => {
      const image = document.createElement('img');
      Object.defineProperties(image, {
        naturalWidth: {value: 16},
        naturalHeight: {value: 9},
      });
      const canvas = document.createElement('canvas');
      vi.spyOn(canvas, 'getContext').mockReturnValue({
        drawImage: vi.fn(),
        filter: '',
      } as unknown as CanvasRenderingContext2D);
      let encode: BlobCallback | undefined;
      vi.spyOn(canvas, 'toBlob').mockImplementation(callback => {
        encode = callback;
      });
      const createElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation(((
        tagName: string,
        options?: ElementCreationOptions,
      ) => {
        if (tagName === 'img') return image;
        if (tagName === 'canvas') return canvas;
        return createElement(tagName, options);
      }) as typeof document.createElement);

      const conversion = service.convertImage('https://example.com/image');
      image.onload?.(new Event('load'));

      expect(encode).toBeDefined();
      expect(() => encode?.(null)).not.toThrow();
      await expect(conversion).rejects.toThrow('Failed to convert image');
    });

    it('rejects convertVideoToImage when thumbnail encoding returns no blob', async () => {
      const video = document.createElement('video');
      Object.defineProperties(video, {
        videoWidth: {value: 16},
        videoHeight: {value: 9},
      });
      const canvas = document.createElement('canvas');
      vi.spyOn(canvas, 'getContext').mockReturnValue({
        drawImage: vi.fn(),
        filter: '',
      } as unknown as CanvasRenderingContext2D);
      let encode: BlobCallback | undefined;
      vi.spyOn(canvas, 'toBlob').mockImplementation(callback => {
        encode = callback;
      });
      const createElement = document.createElement.bind(document);
      vi.spyOn(document, 'createElement').mockImplementation(((
        tagName: string,
        options?: ElementCreationOptions,
      ) => {
        if (tagName === 'video') return video;
        if (tagName === 'canvas') return canvas;
        return createElement(tagName, options);
      }) as typeof document.createElement);

      const conversion = service.convertVideoToImage(
        'https://example.com/video',
      );
      video.onseeked?.(new Event('seeked'));

      expect(encode).toBeDefined();
      expect(() => encode?.(null)).not.toThrow();
      await expect(conversion).rejects.toThrow('Failed to generate thumbnail');
    });
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
