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
import {ClientMediaService} from '../client-media/client-media';
import {RemixEngineService} from '../remix-engine/remix-engine';
import {ImagePreviewService} from './image-preview';

describe('ImagePreviewService', () => {
  let service: ImagePreviewService;
  let clientMedia: {
    generateHighQualityThumbnail: ReturnType<typeof vi.fn>;
    convertImage: ReturnType<typeof vi.fn>;
    toFile: ReturnType<typeof vi.fn>;
  };
  let remix: {uploadThumbnail: ReturnType<typeof vi.fn>};

  beforeEach(() => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:source');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    clientMedia = {
      generateHighQualityThumbnail: vi.fn(),
      convertImage: vi.fn(),
      toFile: vi.fn(
        (blob: Blob) => new File([blob], 'preview.jpg', {type: 'image/jpeg'}),
      ),
    };
    remix = {uploadThumbnail: vi.fn()};
    TestBed.configureTestingModule({
      providers: [
        ImagePreviewService,
        {provide: ClientMediaService, useValue: clientMedia},
        {provide: RemixEngineService, useValue: remix},
      ],
    });
    service = TestBed.inject(ImagePreviewService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubImageDimensions(width = 1600, height = 900): void {
    class FakeImage {
      naturalWidth = width;
      naturalHeight = height;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal('Image', FakeImage);
  }

  it('uploads a bounded preview while returning original dimensions separately', async () => {
    clientMedia.generateHighQualityThumbnail.mockResolvedValue(
      new Blob(['small'], {type: 'image/jpeg'}),
    );
    remix.uploadThumbnail.mockResolvedValue({
      path: 'thumbnail/source-preview-hash.jpg',
      url: 'https://signed.test/preview',
    });
    stubImageDimensions();

    const result = await service.create(
      new File(['original'], 'source.png', {type: 'image/png'}),
    );

    expect(result).toEqual({
      preview: {
        path: 'thumbnail/source-preview-hash.jpg',
        url: 'https://signed.test/preview',
      },
      widthPixels: 1600,
      heightPixels: 900,
    });
    expect(clientMedia.generateHighQualityThumbnail).toHaveBeenCalledWith(
      expect.any(File),
      'image',
    );
    expect(remix.uploadThumbnail).toHaveBeenCalledOnce();
  });

  it('recompresses an oversized thumbnail before upload', async () => {
    clientMedia.generateHighQualityThumbnail.mockResolvedValue(
      new Blob([new Uint8Array(1024 * 1024 + 1)], {type: 'image/jpeg'}),
    );
    clientMedia.convertImage.mockResolvedValue(
      new Blob(['compressed'], {type: 'image/jpeg'}),
    );
    remix.uploadThumbnail.mockResolvedValue({
      path: 'thumbnail/p.jpg',
      url: 'p',
    });
    stubImageDimensions(1200, 800);

    await service.create(
      new File(['original'], 'source.png', {type: 'image/png'}),
    );

    expect(clientMedia.convertImage).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({maxWidth: 400, maxHeight: 400, quality: 0.8}),
    );
    expect(remix.uploadThumbnail).toHaveBeenCalledOnce();
  });

  it('returns no preview on a decode or upload failure so callers can keep the original', async () => {
    class BrokenImage {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;

      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    }
    vi.stubGlobal('Image', BrokenImage);

    await expect(
      service.create(new File(['original'], 'source.png', {type: 'image/png'})),
    ).resolves.toBeUndefined();
    expect(remix.uploadThumbnail).not.toHaveBeenCalled();
  });
});
