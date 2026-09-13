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

import {inject, Injectable} from '@angular/core';
import {ClientMediaService} from '../client-media/client-media';
import {ImagePreviewRef} from '../config/config';
import {RemixEngineService} from '../remix-engine/remix-engine';

const MAX_PREVIEW_BYTES = 1 * 1024 * 1024;

export interface ImagePreviewResult {
  preview: ImagePreviewRef;
  widthPixels: number;
  heightPixels: number;
}

/** Creates content-addressed, bounded display previews for uploaded images. */
@Injectable({providedIn: 'root'})
export class ImagePreviewService {
  private readonly clientMediaService = inject(ClientMediaService);
  private readonly remixEngineService = inject(RemixEngineService);

  async create(file: File): Promise<ImagePreviewResult | undefined> {
    try {
      const dimensions = await this.readImageDimensions(file);
      let blob = await this.clientMediaService.generateHighQualityThumbnail(
        file,
        'image',
      );
      if (blob.size > MAX_PREVIEW_BYTES) {
        blob = await this.clientMediaService.convertImage(file, {
          maxWidth: 400,
          maxHeight: 400,
          mimeType: 'image/jpeg',
          quality: 0.8,
        });
      }
      if (blob.size > MAX_PREVIEW_BYTES) return undefined;

      const uploaded = await this.remixEngineService.uploadThumbnail(
        this.clientMediaService.toFile(blob, {
          mimeType: 'image/jpeg',
          fileName: 'preview.jpg',
        }),
      );
      return {
        preview: uploaded,
        ...dimensions,
      };
    } catch {
      // A preview is an optimization. Callers retain the original ref when
      // decoding, compression, or upload is unavailable.
      return undefined;
    }
  }

  private readImageDimensions(
    file: File,
  ): Promise<{widthPixels: number; heightPixels: number}> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const objectUrl = URL.createObjectURL(file);
      const cleanup = () => URL.revokeObjectURL(objectUrl);
      image.onload = () => {
        cleanup();
        if (!image.naturalWidth || !image.naturalHeight) {
          reject(new Error('Image has no dimensions'));
          return;
        }
        resolve({
          widthPixels: image.naturalWidth,
          heightPixels: image.naturalHeight,
        });
      };
      image.onerror = () => {
        cleanup();
        reject(new Error('Failed to decode image'));
      };
      image.src = objectUrl;
    });
  }
}
