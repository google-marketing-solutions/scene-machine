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
import {inject, Injectable, resource} from '@angular/core';
import {firstValueFrom} from 'rxjs';

/**
 * Represents a creative template.
 */
export interface Template {
  id: string;
  name: string;
  description: string;
  prompt: string;
  readOnly: boolean;
  tags: string[];
  createdAt: number; // Timestamp in milliseconds
}

/**
 * Service for managing creative templates.
 */
@Injectable({
  providedIn: 'root',
})
export class TemplatesService {
  private readonly httpClient = inject(HttpClient);

  templates = resource({
    loader: async () => {
      // Server orders by createdAt asc and injects ids.
      const response = await firstValueFrom(
        this.httpClient.get<{templates: Template[]}>('/api/templates'),
      );
      return response.templates;
    },
  });

  async createTemplate(templateData: Omit<Template, 'id'>) {
    await firstValueFrom(
      this.httpClient.post<{id: string}>('/api/templates', templateData),
    );
    this.templates.reload();
  }

  async updateTemplate(id: string, templateData: Partial<Template>) {
    await firstValueFrom(
      this.httpClient.patch(`/api/templates/${id}`, templateData),
    );
    this.templates.reload();
  }

  async deleteTemplate(id: string) {
    await firstValueFrom(this.httpClient.delete(`/api/templates/${id}`));
    this.templates.reload();
  }
}
