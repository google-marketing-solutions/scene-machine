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

import {
  EnvironmentInjector,
  inject,
  Injectable,
  resource,
  runInInjectionContext,
} from '@angular/core';
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  Firestore,
  getDocs,
  orderBy,
  query,
  updateDoc,
} from '@angular/fire/firestore';

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
  private readonly firestore = inject(Firestore);
  private readonly injector = inject(EnvironmentInjector);

  templates = resource({
    loader: async () => {
      const querySnapshot = await runInInjectionContext(this.injector, () =>
        getDocs(
          query(
            collection(this.firestore, 'creativeTemplates'),
            orderBy('createdAt', 'asc'),
          ),
        ),
      );
      const templates: Template[] = [];
      querySnapshot.forEach(doc => {
        const data = doc.data() as Template;
        data.id = doc.id;
        templates.push(data);
      });
      return templates;
    },
  });

  async createTemplate(templateData: Omit<Template, 'id'>) {
    await runInInjectionContext(this.injector, () =>
      addDoc(collection(this.firestore, 'creativeTemplates'), templateData),
    );
    this.templates.reload();
  }

  async updateTemplate(id: string, templateData: Partial<Template>) {
    await runInInjectionContext(this.injector, () => {
      const docRef = doc(this.firestore, 'creativeTemplates', id);
      return updateDoc(docRef, templateData);
    });
    this.templates.reload();
  }

  async deleteTemplate(id: string) {
    await runInInjectionContext(this.injector, () => {
      const docRef = doc(this.firestore, 'creativeTemplates', id);
      return deleteDoc(docRef);
    });
    this.templates.reload();
  }
}
