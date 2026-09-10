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

import {HttpClient} from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {MatButtonModule} from '@angular/material/button';
import {MatIconModule} from '@angular/material/icon';
import MarkdownIt from 'markdown-it';

interface Announcement {
  id: string;
  markdown: string;
  emoji?: unknown;
}

interface AnnouncementResponse {
  announcement?: unknown;
}

const DISMISSED_KEY = 'scene-machine:last-dismissed-announcement';
const ANNOUNCEMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_MARKDOWN_LENGTH = 255;
const DEFAULT_ANNOUNCEMENT_EMOJI = '⚠️';
const MAX_ANNOUNCEMENT_EMOJI = 3;
const announcementEmojiSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});
const emojiCluster =
  /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u;

function displayAnnouncementEmoji(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_ANNOUNCEMENT_EMOJI;
  }
  if (value.trim().length === 0) {
    return '';
  }
  const clusters: string[] = [];
  for (const part of announcementEmojiSegmenter.segment(value)) {
    if (emojiCluster.test(part.segment)) {
      clusters.push(part.segment);
      if (clusters.length === MAX_ANNOUNCEMENT_EMOJI) {
        break;
      }
    }
  }
  return clusters.join('') || DEFAULT_ANNOUNCEMENT_EMOJI;
}

const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
}).disable([
  'image',
  'heading',
  'lheading',
  'list',
  'table',
  'blockquote',
  'backticks',
  'autolink',
  'fence',
  'hr',
  'html_block',
  'html_inline',
  'strikethrough',
]);
markdown.validateLink = (url: string) => /^https?:\/\//i.test(url);
const defaultLinkOpen = markdown.renderer.rules['link_open'];
markdown.renderer.rules['link_open'] = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank');
  tokens[index].attrSet('rel', 'noopener noreferrer');
  let depth = 0;
  let label = '';
  for (let tokenIndex = index + 1; tokenIndex < tokens.length; tokenIndex++) {
    const token = tokens[tokenIndex];
    if (token.type === 'link_open') {
      depth++;
    } else if (token.type === 'link_close') {
      if (depth === 0) break;
      depth--;
    } else if (token.type === 'text') {
      label += token.content;
    }
  }
  tokens[index].attrSet(
    'aria-label',
    `${label.trim() || 'External link'} (opens in new tab)`,
  );
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options);
};

/** Displays the optional administrator-authored homepage announcement. */
@Component({
  selector: 'app-homepage-announcement',
  imports: [MatButtonModule, MatIconModule],
  templateUrl: './homepage-announcement.html',
  styleUrl: './homepage-announcement.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HomepageAnnouncement {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dismissedId = signal(this.readDismissedId());
  readonly announcement = signal<Announcement | null>(null);
  readonly visible = computed(() => {
    const message = this.announcement();
    return message !== null && message.id !== this.dismissedId();
  });
  readonly displayedEmoji = computed(() =>
    displayAnnouncementEmoji(this.announcement()?.emoji),
  );
  readonly renderedMarkdown = computed(() => {
    const message = this.announcement();
    return message
      ? markdown.renderInline(
          message.markdown.replace(/[ \t]*(?:\r\n?|\n)/g, ' '),
        )
      : '';
  });

  constructor() {
    this.http
      .get<AnnouncementResponse>('/api/announcement')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: response => {
          const value = response?.announcement;
          if (this.isAnnouncement(value)) {
            this.announcement.set(value);
          }
        },
        error: () => this.announcement.set(null),
      });
  }

  dismiss() {
    const message = this.announcement();
    if (!message) {
      return;
    }
    this.dismissedId.set(message.id);
    try {
      localStorage.setItem(DISMISSED_KEY, message.id);
    } catch {
      // Storage is best-effort; the current page is already dismissed.
    }
  }

  private readDismissedId(): string | null {
    try {
      return localStorage.getItem(DISMISSED_KEY);
    } catch {
      return null;
    }
  }

  private isAnnouncement(value: unknown): value is Announcement {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const candidate = value as Partial<Announcement>;
    return (
      typeof candidate.id === 'string' &&
      ANNOUNCEMENT_ID.test(candidate.id) &&
      typeof candidate.markdown === 'string' &&
      candidate.markdown.length > 0 &&
      Array.from(candidate.markdown).length <= MAX_MARKDOWN_LENGTH
    );
  }
}
