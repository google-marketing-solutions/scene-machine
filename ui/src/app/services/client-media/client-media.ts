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

import {Injectable} from '@angular/core';

/**
 * Service for transforming media using canvas, e.g. for generating thumbnails.
 */
@Injectable({
  providedIn: 'root',
})
export class ClientMediaService {
  constructor() {}

  private readonly defaultMimeType = 'image/jpeg';

  private canvasFromMedia(
    src: HTMLImageElement | HTMLVideoElement,
    options: {
      maxWidth?: number;
      maxHeight?: number;
      blur?: number;
    },
  ): HTMLCanvasElement {
    const {maxWidth, maxHeight, blur} = options;
    let targetWidth;
    let targetHeight;
    if (src instanceof HTMLVideoElement) {
      targetWidth = src.videoWidth;
      targetHeight = src.videoHeight;
    } else if (src instanceof HTMLImageElement) {
      targetWidth = src.naturalWidth;
      targetHeight = src.naturalHeight;
    }
    if (!targetWidth || !targetHeight) {
      throw new Error('Failed to get target width or height');
    }

    if (maxWidth || maxHeight) {
      const scaleW = maxWidth ? maxWidth / targetWidth : 1;
      const scaleH = maxHeight ? maxHeight / targetHeight : 1;
      // Use the smaller scale factor to ensure both boundaries are respected
      const scale = Math.min(scaleW, scaleH);

      // Only scale down, never scale up
      if (scale < 1) {
        targetWidth = Math.floor(targetWidth * scale);
        targetHeight = Math.floor(targetHeight * scale);
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Could not get canvas context');
    }

    if (blur) {
      ctx.filter = `blur(${blur}px)`;
    }
    ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  convertVideoToImage(
    videoSource: string | File | Blob,
    options: {
      seekTimeSeconds: number;
      mimeType?: string;
      quality?: number;
      maxWidth?: number;
      maxHeight?: number;
      blur?: number;
    } = {seekTimeSeconds: 1},
  ): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.crossOrigin = 'anonymous';
      let objectUrl: string | null = null;
      if (typeof videoSource === 'string') {
        video.src = videoSource;
      } else {
        objectUrl = URL.createObjectURL(videoSource);
        video.src = objectUrl;
      }

      video.preload = 'metadata';
      video.muted = true;

      video.onloadedmetadata = () => {
        video.currentTime = options.seekTimeSeconds;
      };

      video.onseeked = () => {
        try {
          const canvas = this.canvasFromMedia(video, options);
          canvas.toBlob(
            blob => {
              if (!blob) {
                throw new Error('Failed to generate thumbnail');
              }
              resolve(blob);
            },
            options.mimeType || this.defaultMimeType,
            options.quality,
          );
        } catch (error) {
          reject(error);
        } finally {
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
          }
        }
      };

      video.onerror = () => {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
        reject(
          new Error(
            `Failed to load video. Error code: ${video.error?.code}, Message: ${video.error?.message}`,
          ),
        );
      };
    });
  }

  convertImage(
    imageSrc: string | File | Blob,
    options: {
      mimeType?: string;
      quality?: number;
      maxWidth?: number;
      maxHeight?: number;
      blur?: number;
    } = {},
  ): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      const imageElement = document.createElement('img');
      imageElement.crossOrigin = 'anonymous';
      let objectUrl: string | null = null;

      if (typeof imageSrc === 'string') {
        imageElement.src = imageSrc;
      } else {
        objectUrl = URL.createObjectURL(imageSrc);
        imageElement.src = objectUrl;
      }

      imageElement.onload = () => {
        try {
          const canvas = this.canvasFromMedia(imageElement, {
            maxWidth: options.maxWidth,
            maxHeight: options.maxHeight,
            blur: options.blur,
          });

          canvas.toBlob(
            blob => {
              if (!blob) {
                throw new Error('Failed to convert image');
              }
              resolve(blob);
            },
            options.mimeType || this.defaultMimeType,
            options.quality,
          );
        } catch (error) {
          reject(error);
        } finally {
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
          }
        }
      };

      imageElement.onerror = () => {
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
        reject(new Error('Failed to load image'));
      };
    });
  }

  toBase64(blob: Blob): Promise<string> {
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    return new Promise((resolve, reject) => {
      reader.onloadend = () => {
        if (!reader.result || typeof reader.result !== 'string') {
          throw new Error('Failed to convert blob to base64');
        }
        resolve(reader.result);
      };
      reader.onerror = reject;
    });
  }

  toFile(
    blob: Blob,
    options: {mimeType?: string; fileName?: string} = {},
  ): File {
    const mimeType = options.mimeType || blob.type || this.defaultMimeType;
    let fileName = options.fileName;

    if (!fileName) {
      const extension = mimeType.split('/')[1];
      fileName = `thumbnail.${extension}`;
    }

    return new File([blob], fileName, {type: mimeType});
  }

  generateLowQualityThumbnail(
    src: string | File | Blob,
    type: 'video' | 'image',
  ) {
    if (type === 'video') {
      return this.convertVideoToImage(src, {
        seekTimeSeconds: 1,
        maxWidth: 20,
        maxHeight: 20,
        blur: 2,
      });
    } else if (type === 'image') {
      return this.convertImage(src, {
        maxWidth: 20,
        maxHeight: 20,
        blur: 2,
      });
    } else {
      throw new Error(`Unknown thumbnail type: ${type}`);
    }
  }

  generateHighQualityThumbnail(
    src: string | File | Blob,
    type: 'video' | 'image',
  ) {
    if (type === 'video') {
      return this.convertVideoToImage(src, {
        seekTimeSeconds: 1,
        maxWidth: 500,
        maxHeight: 500,
      });
    }
    if (type === 'image') {
      return this.convertImage(src, {
        maxWidth: 500,
        maxHeight: 500,
      });
    } else {
      throw new Error(`Unknown thumbnail type: ${type}`);
    }
  }
}
