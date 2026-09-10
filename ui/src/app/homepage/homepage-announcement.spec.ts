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

import {provideHttpClient} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {MatDialog} from '@angular/material/dialog';
import {firstValueFrom} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {HomepageAnnouncement} from './homepage-announcement';

describe('HomepageAnnouncement', () => {
  let fixture: ComponentFixture<HomepageAnnouncement>;
  let http: HttpTestingController;
  let previousStorage: Storage;
  let storage: Storage;

  beforeEach(async () => {
    previousStorage = globalThis.localStorage;
    const values = new Map<string, string>();
    storage = {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: key => values.delete(key),
      clear: () => values.clear(),
      key: index => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    } as Storage;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: storage,
    });
    await TestBed.configureTestingModule({
      imports: [HomepageAnnouncement],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    fixture = TestBed.createComponent(HomepageAnnouncement);
    fixture.detectChanges();
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    fixture.destroy();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: previousStorage,
    });
  });

  it('renders the restricted inline Markdown from the announcement endpoint', () => {
    http.expectOne('/api/announcement').flush({
      announcement: {
        id: 'welcome-v1',
        markdown: 'Welcome **here** [help **center**](https://example.com).',
        emoji: '🛠️',
      },
    });
    fixture.detectChanges();

    const region = fixture.nativeElement.querySelector('[role="region"]');
    expect(region.textContent).toContain('Welcome here help center.');
    expect(region.querySelector('.announcement-emoji')?.textContent).toBe('🛠️');
    expect(region.querySelector('strong')?.textContent).toBe('here');
    expect(region.querySelector('a')?.getAttribute('href')).toBe(
      'https://example.com',
    );
    expect(region.querySelector('a')?.getAttribute('target')).toBe('_blank');
    expect(region.querySelector('a')?.getAttribute('rel')).toBe(
      'noopener noreferrer',
    );
    expect(region.querySelector('a')?.getAttribute('aria-label')).toContain(
      'help center (opens in new tab)',
    );
  });

  it('opens the full wrapping announcement dialog from a keyboard-accessible button', async () => {
    const expectedText = 'A long announcement '.repeat(10).trim();
    http.expectOne('/api/announcement').flush({
      announcement: {
        id: 'long-v1',
        markdown: `${expectedText} [read more](https://example.com)`,
        emoji: '',
      },
    });
    fixture.detectChanges();

    const region = fixture.nativeElement.querySelector('[role="region"]');
    const moreButton = region.querySelector(
      'button[aria-label="Read full announcement"]',
    ) as HTMLButtonElement;
    expect(moreButton).not.toBeNull();
    expect(moreButton.tabIndex).toBe(0);
    moreButton.focus();
    expect(document.activeElement).toBe(moreButton);
    moreButton.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const dialog = document.querySelector('[role="dialog"]');
    expect(
      dialog?.querySelector('.announcement-dialog-content')?.textContent,
    ).toContain(expectedText);
    expect(
      dialog
        ?.querySelector('.announcement-dialog-content a')
        ?.getAttribute('href'),
    ).toBe('https://example.com');
    const closeButton = [...(dialog?.querySelectorAll('button') ?? [])].find(
      button => button.textContent?.trim() === 'Close',
    ) as HTMLButtonElement;
    expect(closeButton).not.toBeUndefined();
    const dialogRef = TestBed.inject(MatDialog).openDialogs[0];
    const closed = firstValueFrom(dialogRef.afterClosed());
    closeButton.click();
    await closed;
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('filters emoji clusters, preserves complex clusters, and caps at three', () => {
    http.expectOne('/api/announcement').flush({
      announcement: {
        id: 'emoji-v1',
        markdown: 'Welcome',
        emoji: 'text 👩🏽‍💻🇩🇪1️⃣🚀',
      },
    });
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.announcement-emoji')?.textContent,
    ).toBe('👩🏽‍💻🇩🇪1️⃣');

    fixture.destroy();
    fixture = TestBed.createComponent(HomepageAnnouncement);
    fixture.detectChanges();
    http.expectOne('/api/announcement').flush({
      announcement: {id: 'emoji-v2', markdown: 'Welcome', emoji: 'plain text'},
    });
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('.announcement-emoji')?.textContent,
    ).toBe('⚠️');
  });

  it.each([undefined, null, 42])(
    'falls back for missing or non-string emoji values: %s',
    emoji => {
      http.expectOne('/api/announcement').flush({
        announcement: {id: 'emoji-fallback', markdown: 'Welcome', emoji},
      });
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('.announcement-emoji')?.textContent,
      ).toBe('⚠️');
    },
  );

  it.each(['', '   '])(
    'hides an empty emoji while preserving the banner: %j',
    emoji => {
      http.expectOne('/api/announcement').flush({
        announcement: {id: 'emoji-empty', markdown: 'Welcome', emoji},
      });
      fixture.detectChanges();

      const region = fixture.nativeElement.querySelector('[role="region"]');
      expect(region.querySelector('.announcement-emoji')).toBeNull();
      expect(region.textContent).toContain('Welcome');
      expect(region.querySelector('button')).not.toBeNull();
    },
  );

  it('normalizes Markdown line breaks for the single-row strip', () => {
    http.expectOne('/api/announcement').flush({
      announcement: {
        id: 'line-break-v1',
        markdown: 'First  \nsecond',
      },
    });
    fixture.detectChanges();

    const region = fixture.nativeElement.querySelector('[role="region"]');
    expect(region.querySelector('br')).toBeNull();
    expect(region.textContent).toContain('First second');
  });

  it('does not render raw HTML, images, or non-http links', () => {
    http.expectOne('/api/announcement').flush({
      announcement: {
        id: 'unsafe-v1',
        markdown:
          '<img src="https://evil.test/x" onerror="alert(1)"> [bad](javascript:alert(1)) [data](data:text/html,x) **safe**',
      },
    });
    fixture.detectChanges();

    const region = fixture.nativeElement.querySelector('[role="region"]');
    expect(region.querySelector('img')).toBeNull();
    expect(region.querySelector('[onerror]')).toBeNull();
    expect(region.querySelector('a')).toBeNull();
    expect(region.textContent).toContain('safe');
  });

  it('rejects backticks and autolinks and accepts exactly 255 Unicode characters', () => {
    const withinLimit = '😀'.repeat(255);
    http.expectOne('/api/announcement').flush({
      announcement: {
        id: 'unicode-v1',
        markdown: withinLimit,
      },
    });
    fixture.detectChanges();
    const region = fixture.nativeElement.querySelector('[role="region"]');
    expect(region.textContent).toContain(withinLimit);

    fixture.destroy();
    fixture = TestBed.createComponent(HomepageAnnouncement);
    fixture.detectChanges();
    http.expectOne('/api/announcement').flush({
      announcement: {
        id: 'syntax-v1',
        markdown: '`not code` <https://example.com>',
      },
    });
    fixture.detectChanges();
    const syntaxRegion = fixture.nativeElement.querySelector('[role="region"]');
    expect(syntaxRegion.querySelector('code')).toBeNull();
    expect(syntaxRegion.querySelector('a')).toBeNull();
    expect(syntaxRegion.textContent).toContain('`not code`');

    fixture.destroy();
    fixture = TestBed.createComponent(HomepageAnnouncement);
    fixture.detectChanges();
    http.expectOne('/api/announcement').flush({
      announcement: {id: 'unicode-v2', markdown: '😀'.repeat(256)},
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="region"]')).toBeNull();
  });

  it.each([
    {announcement: null},
    {announcement: {id: 'bad id', markdown: 'not valid'}},
  ])('renders nothing for an empty or invalid response', response => {
    http.expectOne('/api/announcement').flush(response);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="region"]')).toBeNull();
  });

  it('keeps the homepage quiet when the announcement request fails', () => {
    http.expectOne('/api/announcement').flush('unavailable', {
      status: 503,
      statusText: 'Unavailable',
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="region"]')).toBeNull();
  });

  it('dismisses the current ID and shows a different ID later', () => {
    const welcomeId = 'a'.repeat(64);
    const releaseId = 'b'.repeat(64);
    http.expectOne('/api/announcement').flush({
      announcement: {id: welcomeId, markdown: 'Welcome'},
    });
    fixture.detectChanges();
    fixture.nativeElement
      .querySelector('button[aria-label="Dismiss this announcement"]')
      .click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="region"]')).toBeNull();
    expect(storage.getItem('scene-machine:last-dismissed-announcement')).toBe(
      welcomeId,
    );

    fixture.destroy();
    fixture = TestBed.createComponent(HomepageAnnouncement);
    fixture.detectChanges();
    http.expectOne('/api/announcement').flush({
      announcement: {id: releaseId, markdown: 'New release'},
    });
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[role="region"]'),
    ).not.toBeNull();
  });

  it('keeps unchanged dismissed content hidden after reload', () => {
    const welcomeId = 'a'.repeat(64);
    http.expectOne('/api/announcement').flush({
      announcement: {id: welcomeId, markdown: 'Welcome'},
    });
    fixture.detectChanges();
    fixture.nativeElement
      .querySelector('button[aria-label="Dismiss this announcement"]')
      .click();
    fixture.destroy();

    fixture = TestBed.createComponent(HomepageAnnouncement);
    fixture.detectChanges();
    http.expectOne('/api/announcement').flush({
      announcement: {id: welcomeId, markdown: 'Welcome'},
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="region"]')).toBeNull();
  });

  it('still dismisses when localStorage write fails', () => {
    storage.setItem = () => {
      throw new Error('storage blocked');
    };
    http.expectOne('/api/announcement').flush({
      announcement: {id: 'blocked-write', markdown: 'Welcome'},
    });
    fixture.detectChanges();
    fixture.nativeElement
      .querySelector('button[aria-label="Dismiss this announcement"]')
      .click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="region"]')).toBeNull();
  });

  it('shows a valid message when localStorage read fails', () => {
    http.expectOne('/api/announcement');
    fixture.destroy();
    storage.getItem = () => {
      throw new Error('storage blocked');
    };
    fixture = TestBed.createComponent(HomepageAnnouncement);
    fixture.detectChanges();
    const request = http.expectOne('/api/announcement');
    request.flush({
      announcement: {id: 'blocked-read', markdown: 'Welcome'},
    });
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('[role="region"]'),
    ).not.toBeNull();
  });

  it('cancels a pending request when destroyed', () => {
    const request = http.expectOne('/api/announcement');
    fixture.destroy();
    expect(request.cancelled).toBe(true);
  });
});
