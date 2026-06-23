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

/** Give up on a single image download after this long so one bad link cannot
 * stall the whole import. */
const FETCH_TIMEOUT_MS = 20000;
/** Single source of truth for the image upload size cap, in MB. The setup
 * page's file picker and this service's URL/base64 import both enforce it. */
export const MAX_IMAGE_UPLOAD_MB = 30;
/** Reject images larger than this before they are downloaded/decoded into
 * memory. */
const MAX_IMAGE_BYTES = MAX_IMAGE_UPLOAD_MB * 1024 * 1024;

/** A single source string that could not be turned into an image. */
export interface ImportFailure {
  /** The link or pasted text that failed (clipped for display). */
  source: string;
  /** Plain-language reason it failed. */
  reason: string;
}

/**
 * Turns alternative image sources — a pasted/dropped image, a base64 string,
 * or a remote image URL — into ordinary {@link File} objects so they can flow
 * through the app's existing upload path unchanged.
 *
 * URL fetching happens in the browser (not on the server): a link the browser
 * cannot read (because the host blocks cross-site downloads, or it is missing)
 * simply becomes a reported failure, which is the behaviour we want for the
 * "tell me which links did not work" experience.
 */
@Injectable({providedIn: 'root'})
export class ImageImportService {
  /**
   * Extracts image files from a paste or drop event's clipboard/data transfer.
   * Returns an empty array when the clipboard holds only text (so callers can
   * let a normal text paste proceed).
   */
  imageFilesFromDataTransfer(dt: DataTransfer | null | undefined): File[] {
    if (!dt) {
      return [];
    }
    const files: File[] = [];
    // Items cover pasted screenshots, which arrive as items rather than files.
    if (dt.items && dt.items.length > 0) {
      for (const item of Array.from(dt.items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            files.push(file);
          }
        }
      }
    }
    if (files.length === 0 && dt.files) {
      for (const file of Array.from(dt.files)) {
        if (file.type.startsWith('image/')) {
          files.push(file);
        }
      }
    }
    return files;
  }

  /**
   * A web image dragged from another browser tab carries no File — only its
   * URL (or a data: URI). Pull the first usable image source out of a drop's
   * DataTransfer so the caller can fetch/decode it like a pasted link.
   */
  imageUrlFromDataTransfer(dt: DataTransfer | null | undefined): string | null {
    if (!dt) {
      return null;
    }
    // The standard channel for a dragged link/image; skip comment lines.
    const uriList = dt.getData('text/uri-list');
    if (uriList) {
      const url = uriList
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => line && !line.startsWith('#'));
      if (url) {
        return url;
      }
    }
    // Fall back to the src of an <img> in the dragged HTML.
    const html = dt.getData('text/html');
    if (html) {
      const match = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
      if (match) {
        return match[1];
      }
    }
    // Last resort: plain text that is itself an image URL or data URI.
    const text = dt.getData('text/plain').trim();
    if (/^(https?:\/\/|data:image\/)/i.test(text)) {
      return text;
    }
    return null;
  }

  /**
   * True when focus is in a text field the user could be typing into, so an
   * image paste should be left alone rather than redirected to an image area.
   */
  isEditableTarget(el: Element | null): boolean {
    if (!el) {
      return false;
    }
    const tag = el.tagName;
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      (el as HTMLElement).isContentEditable === true
    );
  }

  /**
   * True when a `dragleave` means the pointer actually left the drop zone,
   * rather than moving onto a child element still inside it.
   */
  hasLeftDropZone(event: DragEvent): boolean {
    const current = event.currentTarget as HTMLElement;
    const next = event.relatedTarget as Node | null;
    return !next || !current.contains(next);
  }

  /**
   * Shared single-image drop handler for the storyboard and overlay drop zones.
   * Uses a dropped/pasted image file when present, otherwise fetches an image
   * dragged from another tab. Calls `onFile` with the first resolved File, or
   * `onFailure` with a plain-language reason when a dragged URL yielded nothing.
   */
  async importFromDrop(
    dt: DataTransfer | null | undefined,
    onFile: (file: File) => void,
    onFailure?: (reason: string) => void,
  ): Promise<void> {
    const files = this.imageFilesFromDataTransfer(dt);
    if (files.length > 0) {
      onFile(files[0]);
      return;
    }
    // Dragged from another tab: only the image's URL came across — fetch it.
    const url = this.imageUrlFromDataTransfer(dt);
    if (!url) {
      return;
    }
    const {files: urlFiles, failures} = await this.importText(url);
    if (urlFiles.length > 0) {
      onFile(urlFiles[0]);
    } else if (failures.length > 0) {
      onFailure?.(failures[0].reason);
    }
  }

  /** User-facing message for an image source that produced no usable image. */
  importFailureMessage(reason: string): string {
    return `Couldn't add that image — it ${reason}.`;
  }

  /**
   * Decodes a `data:image/...;base64,...` string, or a raw base64 image, into a
   * File. Returns null when the text is not a recognisable image.
   */
  base64ToFile(text: string, baseName = 'pasted-image'): File | null {
    const trimmed = text.trim();
    let mime: string | null = null;
    let base64: string;

    // Restrict to the formats we can actually recognise, and require the
    // payload to be pure base64 (no stray whitespace/commas) so a contaminated
    // token cannot slip through with a spoofed type.
    const dataUri =
      /^data:(image\/(?:png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=_-]+)$/.exec(
        trimmed,
      );
    if (dataUri) {
      mime = dataUri[1];
      base64 = dataUri[2];
    } else {
      // A raw base64 blob: only base64 characters, and long enough to be real.
      if (trimmed.length < 16 || !/^[A-Za-z0-9+/=_-]+$/.test(trimmed)) {
        return null;
      }
      base64 = trimmed;
    }

    // Cap the decoded size before allocating: a very large base64 token must
    // not be expanded into memory just to be rejected by the MIME sniff below
    // (base64 decodes to roughly 3/4 of its length).
    if ((base64.length * 3) / 4 > MAX_IMAGE_BYTES) {
      return null;
    }

    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = this.decodeBase64(base64);
    } catch {
      return null;
    }

    if (!mime) {
      mime = this.sniffImageMime(bytes);
      if (!mime) {
        return null;
      }
    }

    const extension = mime.split('/')[1] || 'png';
    return new File([bytes], `${baseName}.${extension}`, {type: mime});
  }

  /**
   * Fetches a remote image URL in the browser and returns it as a File.
   * Throws an Error with a plain-language message on any failure.
   */
  async fetchImageAsFile(url: string): Promise<File> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await fetch(url, {signal: controller.signal});
      } catch {
        throw new Error(
          controller.signal.aborted
            ? 'could not be downloaded (timed out)'
            : 'could not be downloaded (the site may block it)',
        );
      }
      if (!response.ok) {
        throw new Error(`could not be downloaded (HTTP ${response.status})`);
      }
      // Reject obviously-oversized downloads up front when the server reports a
      // size, rather than pulling the whole thing into memory first.
      const declaredSize = Number(
        response.headers.get('content-length') ?? '0',
      );
      if (declaredSize > MAX_IMAGE_BYTES) {
        throw new Error('image is too large');
      }
      let blob: Blob;
      try {
        blob = await this.readCappedBlob(response);
      } catch (error) {
        // Let the size rejection through; map everything else to a download
        // failure (a network error or the abort timer firing mid-stream).
        if ((error as Error).message === 'image is too large') {
          throw error;
        }
        throw new Error(
          controller.signal.aborted
            ? 'could not be downloaded (timed out)'
            : 'could not be downloaded',
        );
      }
      if (!blob.type.startsWith('image/')) {
        throw new Error('is not an image');
      }
      return new File([blob], this.fileNameFromUrl(url, blob.type), {
        type: blob.type,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Reads a response body into a Blob, aborting once the running byte count
   * exceeds MAX_IMAGE_BYTES — so a response with no (or an understated)
   * Content-Length header cannot buffer an unbounded body into memory before
   * the cap is applied. Falls back to response.blob() if the body is not a
   * readable stream.
   */
  private async readCappedBlob(response: Response): Promise<Blob> {
    const type = response.headers.get('content-type') ?? '';
    const reader = response.body?.getReader();
    if (!reader) {
      const blob = await response.blob();
      if (blob.size > MAX_IMAGE_BYTES) {
        throw new Error('image is too large');
      }
      return blob;
    }
    const chunks: BlobPart[] = [];
    let received = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done || !value) {
        break;
      }
      received += value.byteLength;
      if (received > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error('image is too large');
      }
      chunks.push(value);
    }
    return new Blob(chunks, {type});
  }

  /**
   * Parses pasted text (image links and/or base64, one per line) and resolves
   * each entry to a File, collecting the ones that could not be turned into an
   * image so the caller can report them.
   */
  async importText(
    text: string,
  ): Promise<{files: File[]; failures: ImportFailure[]}> {
    const tokens = this.tokenizeImportText(text);

    // Resolve every entry concurrently so a slow link does not hold up the
    // rest; the input order is preserved by the map.
    const results = await Promise.all(
      tokens.map(async (token): Promise<File | ImportFailure> => {
        if (/^https?:\/\//i.test(token)) {
          try {
            return await this.fetchImageAsFile(token);
          } catch (error) {
            // Show the full link so the user can find it in their list.
            return {source: token, reason: (error as Error).message};
          }
        }
        const file = this.base64ToFile(token);
        return (
          file ?? {
            // base64 blobs are huge, so keep those clipped.
            source: this.clip(token),
            reason: 'is not a valid image link or base64',
          }
        );
      }),
    );

    const files = results.filter((r): r is File => r instanceof File);
    const failures = results.filter(
      (r): r is ImportFailure => !(r instanceof File),
    );

    return {files, failures};
  }

  /**
   * Splits pasted text into the entries `importText` resolves.
   *
   * A line that holds more than one whitespace-separated token (a list of URLs,
   * or a URL/base64 mix) is taken token-by-token, as before. A line that is a
   * single token is, if it is not a URL, joined onto the preceding single-token
   * lines: a raw or data: base64 image that a mail/text client hard-wrapped
   * every ~76 chars arrives as one such token per line, so this reassembles it
   * into the one base64 string `base64ToFile` can decode instead of shattering
   * it into fragments that each fail to validate. A blank line, a URL, or a
   * multi-token line ends the current run, keeping several pasted images apart.
   */
  private tokenizeImportText(text: string): string[] {
    const tokens: string[] = [];
    let base64Parts: string[] = [];

    const flushBase64 = () => {
      if (base64Parts.length > 0) {
        tokens.push(base64Parts.join(''));
        base64Parts = [];
      }
    };

    for (const rawLine of text.split(/\r?\n/)) {
      const parts = rawLine.split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        // A blank line separates entries (e.g. two pasted images).
        flushBase64();
        continue;
      }
      // A multi-token line is a URL list / mix, never a wrapped base64 blob:
      // flush any pending blob and take each token on its own.
      if (parts.length > 1) {
        flushBase64();
        tokens.push(...parts);
        continue;
      }
      const token = parts[0];
      // A bare URL is its own entry and ends any base64 run in progress.
      if (/^https?:\/\//i.test(token)) {
        flushBase64();
        tokens.push(token);
        continue;
      }
      // A data: image URI begins a fresh blob (so a wrapped one is rejoined).
      if (/^data:image\//i.test(token)) {
        flushBase64();
      }
      // Otherwise this single token is a base64 fragment: accumulate it so the
      // full blob is rejoined across the lines the wrap split it onto.
      base64Parts.push(token);
    }
    flushBase64();
    return tokens;
  }

  private decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
    // Accept URL-safe base64 (-_), and restore any stripped padding.
    let normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
    while (normalized.length % 4 !== 0) {
      normalized += '=';
    }
    const binary = atob(normalized);
    const buffer = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  private sniffImageMime(bytes: Uint8Array): string | null {
    if (
      bytes.length >= 4 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      return 'image/png';
    }
    if (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    ) {
      return 'image/jpeg';
    }
    if (
      bytes.length >= 4 &&
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38
    ) {
      return 'image/gif';
    }
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return 'image/webp';
    }
    return null;
  }

  private fileNameFromUrl(url: string, mime: string): string {
    try {
      const path = new URL(url).pathname;
      const base = path.substring(path.lastIndexOf('/') + 1);
      if (base) {
        return decodeURIComponent(base);
      }
    } catch {
      // Fall through to a generated name.
    }
    const extension = mime.split('/')[1] || 'img';
    return `image.${extension}`;
  }

  private clip(token: string): string {
    return token.length > 40 ? `${token.slice(0, 40)}...` : token;
  }
}
