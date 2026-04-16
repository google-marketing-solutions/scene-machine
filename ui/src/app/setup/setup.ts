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

import {CommonModule} from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {MatButtonModule} from '@angular/material/button';
import {MatButtonToggleModule} from '@angular/material/button-toggle';
import {MatCardModule} from '@angular/material/card';
import {MatDialog, MatDialogModule} from '@angular/material/dialog';
import {MatDividerModule} from '@angular/material/divider';
import {MatExpansionModule} from '@angular/material/expansion';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatIconModule} from '@angular/material/icon';
import {MatInputModule} from '@angular/material/input';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {MatSelectModule} from '@angular/material/select';
import {MatSlideToggleModule} from '@angular/material/slide-toggle';
import {MatSliderModule} from '@angular/material/slider';
import {MatSnackBar, MatSnackBarModule} from '@angular/material/snack-bar';
import {MatTooltipModule} from '@angular/material/tooltip';
import {ActivatedRoute, Router} from '@angular/router';
import {
  ASPECT_RATIO_DEVIATION_THRESHOLD,
  AspectRatio,
  ConfigService,
  GcsFile,
  GeneratedScene,
  InputConfig,
  Product,
} from '../services/config/config';
import {RemixEngineService} from '../services/remix-engine/remix-engine';
import {Template, TemplatesService} from '../services/templates/templates';
import {ConfirmProjectDeleteDialog} from '../shared/confirm-project-delete-dialog';
import {TemplateCard} from '../templates/template-card/template-card';
import {GenerateStoryboardDialog} from './generate-storyboard-dialog/generate-storyboard-dialog';

/**
 * Component for the setup view.
 */
@Component({
  selector: 'app-setup',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatCardModule,
    MatDividerModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSnackBarModule,
    MatSliderModule,
    MatSlideToggleModule,
    MatProgressSpinnerModule,
    MatExpansionModule,
    MatTooltipModule,
    MatDialogModule,
    TemplateCard,
  ],
  templateUrl: './setup.html',
  styleUrl: './setup.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Setup {
  private readonly dialog = inject(MatDialog);
  private readonly remixEngineService = inject(RemixEngineService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly snackBar = inject(MatSnackBar);
  readonly config = inject(ConfigService);
  readonly templatesService = inject(TemplatesService);

  creationMode = signal<'ai' | 'manual'>('ai');

  readonly MAX_FILE_SIZE_MB = 30;
  readonly MAX_FILE_SIZE_BYTES = this.MAX_FILE_SIZE_MB * 1024 * 1024;

  readonly MAX_PRODUCT_DESCRIPTION_LENGTH = 500;

  hasCandidates = computed(() => {
    const scenes = this.config.projectConfig.value().storyboard;
    return scenes.some(
      s => 'candidates' in s && s.candidates && s.candidates.length > 0,
    );
  });

  hasImages = computed(() => {
    const products = this.config.projectConfig.value().inputConfig?.products;
    return (
      products?.some(product => product.images && product.images.length > 0) ??
      false
    );
  });

  readonly ASPECT_RATIO_DEVIATION_THRESHOLD = ASPECT_RATIO_DEVIATION_THRESHOLD;

  selectedTemplateId = computed(() => {
    return this.config.projectConfig.value().inputConfig.templateId ?? 'custom';
  });

  getCustomDescription(): string {
    return 'Detailed product description (materials, benefits, target audience, dimensions)...';
  }

  constructor() {
    effect(() => {
      // Backwards compatibility for projects created before inputConfig was introduced
      const inputConfig = this.config.projectConfig.value().inputConfig;
      if (!inputConfig) {
        this.config.updateProjectConfig({
          inputConfig: {
            products: [
              {
                id: 1,
                name: 'Product 1',
                images: [],
              },
            ],
            composition: '',
            style: '',
            audience: '',
          },
        });
      }
    });
  }

  aspectRatioUpdated(aspectRatio: AspectRatio) {
    this.config.updateProjectConfig({aspectRatio});
    let targetAspectRatio;
    if (aspectRatio === '16:9') {
      targetAspectRatio = 16 / 9;
    } else if (aspectRatio === '9:16') {
      targetAspectRatio = 9 / 16;
    } else {
      console.error('Invalid aspect ratio');
      return;
    }
    const products = [
      ...this.config.projectConfig.value().inputConfig.products,
    ];
    for (const product of products) {
      for (const image of product.images) {
        if (!image.widthPixels || !image.heightPixels) {
          continue;
        }
        const imageAspectRatio = image.widthPixels / image.heightPixels;
        const aspectRatioDeviation = Math.abs(
          imageAspectRatio / targetAspectRatio - 1,
        );
        image.aspectRatioDeviation = aspectRatioDeviation;
      }
    }
    this.config.updateProjectConfig({
      inputConfig: {
        ...this.config.projectConfig.value().inputConfig,
        products,
      },
    });
  }

  previewAspectRatio = computed(() => {
    const ratio = this.config.projectConfig.value().aspectRatio;
    return ratio ? ratio.replace(':', '/') : '16/9';
  });

  imageLoaded(event: Event, productId: number, imageIndex: number) {
    const img = event.target as HTMLImageElement;
    const width = img.naturalWidth;
    const height = img.naturalHeight;
    let targetAspectRatio;
    if (this.config.projectConfig.value().aspectRatio === '16:9') {
      targetAspectRatio = 16 / 9;
    } else if (this.config.projectConfig.value().aspectRatio === '9:16') {
      targetAspectRatio = 9 / 16;
    } else {
      console.error('Invalid aspect ratio');
      return;
    }
    const imageAspectRatio = width / height;
    const aspectRatioDeviation = Math.abs(
      imageAspectRatio / targetAspectRatio - 1,
    );

    const products = this.config.projectConfig
      .value()
      .inputConfig.products.map(p => {
        if (p.id === productId) {
          p.images[imageIndex].widthPixels = width;
          p.images[imageIndex].heightPixels = height;
          p.images[imageIndex].aspectRatioDeviation = aspectRatioDeviation;
          return p;
        }
        return p;
      });

    this.config.updateProjectConfig({
      inputConfig: {
        ...this.config.projectConfig.value().inputConfig,
        products,
      },
    });
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
    event.stopPropagation();
  }

  onDrop(event: DragEvent, productId: number) {
    event.preventDefault();
    event.stopPropagation();
    const files = event.dataTransfer?.files;
    if (files) {
      this.processFiles(productId, files);
    }
  }

  onFileSelected(event: Event, productId: number) {
    const input = event.target as HTMLInputElement;
    if (input.files) {
      this.processFiles(productId, input.files);
      input.value = ''; // Reset input to allow selecting the same file again
    }
  }

  processFiles(productId: number, files: FileList) {
    const fileArray = Array.from(files);
    const oversizedFile = fileArray.find(
      file => file.size > this.MAX_FILE_SIZE_BYTES,
    );

    if (oversizedFile) {
      this.snackBar.open(
        `File "${oversizedFile.name}" (${(oversizedFile.size / 1024 / 1024).toFixed(2)}MB) exceeds the ${this.MAX_FILE_SIZE_MB}MB limit.`,
        'Close',
        {
          duration: 10000,
        },
      );
      return;
    }

    void Promise.all(
      fileArray.map(async file => {
        if (file.type.startsWith('image/')) {
          const {path, url} = await this.remixEngineService.uploadMedia(file);
          return {
            path,
            url,
            name: file.name,
          };
        } else {
          console.error(`File ${file.name} is not an image`);
          return null;
        }
      }),
    ).then(results => {
      const uploadedImages: GcsFile[] = [];
      uploadedImages.push(...results.filter(file => file !== null));
      this.config.updateProjectConfig({
        inputConfig: {
          ...this.config.projectConfig.value().inputConfig,
          products: this.config.projectConfig
            .value()
            .inputConfig.products.map(p =>
              p.id === productId
                ? {...p, images: [...p.images, ...uploadedImages]}
                : p,
            ),
        },
      });
    });
  }

  removeImage(productId: number, imageIndex: number) {
    this.config.updateProjectConfig({
      inputConfig: {
        ...this.config.projectConfig.value().inputConfig,
        products: this.config.projectConfig
          .value()
          .inputConfig.products.map(p => {
            if (p.id === productId) {
              // TODO: Remove from GCS
              return {
                ...p,
                images: p.images.filter((_, i) => i !== imageIndex),
              };
            }
            return p;
          }),
      },
    });
  }

  currentOffset = signal(0);
  visibleTemplatesCount = 4;
  showGuidanceText = signal(false);

  ownTemplate: Template = {
    id: 'custom',
    name: 'Write your own',
    description: 'Write custom instructions from scratch',
    prompt: '',
    readOnly: true,
    tags: [],
    createdAt: 0,
  };

  allTemplates = computed(() => {
    const templates = this.templatesService.templates.value();
    if (!templates) return [this.ownTemplate];
    return [this.ownTemplate, ...templates];
  });

  visibleTemplates = computed(() => {
    const all = this.allTemplates();
    const offset = this.currentOffset();
    return all.slice(offset, offset + this.visibleTemplatesCount);
  });

  canMoveBack = computed(() => {
    return this.currentOffset() > 0;
  });

  canMoveForward = computed(() => {
    const all = this.allTemplates();
    return this.currentOffset() + this.visibleTemplatesCount < all.length;
  });

  moveBack() {
    if (this.canMoveBack()) {
      this.currentOffset.update(v => v - 1);
    }
  }

  moveForward() {
    if (this.canMoveForward()) {
      this.currentOffset.update(v => v + 1);
    }
  }

  selectTemplate(template: Template) {
    if (template.id === 'custom') {
      this.updateInputConfig({templateId: 'custom'});
    } else {
      this.updateInputConfig({
        templateId: template.id,
        composition: template.prompt,
      });
    }
    this.showGuidanceText.set(true);
  }

  toggleGuidanceText() {
    this.showGuidanceText.update(v => !v);
  }

  addProduct() {
    const inputConfig = this.config.projectConfig.value().inputConfig;
    this.config.updateProjectConfig({
      inputConfig: {
        ...inputConfig,
        products: [
          ...inputConfig.products,
          {
            id: Math.max(0, ...inputConfig.products.map(p => p.id)) + 1,
            name: `Product ${Math.max(0, ...inputConfig.products.map(p => p.id)) + 1}`,
            images: [],
          },
        ],
      },
    });
  }

  removeProduct(id: number) {
    const inputConfig = this.config.projectConfig.value().inputConfig;
    this.config.updateProjectConfig({
      inputConfig: {
        ...inputConfig,
        products: inputConfig.products.filter(p => p.id !== id),
      },
    });
  }

  updateProductDescriptionText(productId: number, description: string) {
    const inputConfig = this.config.projectConfig.value().inputConfig;
    this.config.updateProjectConfig({
      inputConfig: {
        ...inputConfig,
        products: inputConfig.products.map(p =>
          p.id === productId ? {...p, description} : p,
        ),
      },
    });
  }

  updateInputConfig(partial: Partial<InputConfig>) {
    this.config.updateProjectConfig({
      inputConfig: {
        ...this.config.projectConfig.value().inputConfig,
        ...partial,
      },
    });
  }

  getCombinedBriefing(): string {
    const inputConfig = this.config.projectConfig.value().inputConfig;
    const briefingEllements: string[] = [];
    if (inputConfig.composition) {
      briefingEllements.push(`#### Composition:\n${inputConfig.composition}`);
    }

    if (inputConfig.style) {
      briefingEllements.push(
        `#### Style and Brand Identity:\n${inputConfig.style}`,
      );
    }
    if (inputConfig.audience) {
      briefingEllements.push(
        `#### Audience and Market:\n${inputConfig.audience}`,
      );
    }
    return briefingEllements.join('\n\n');
  }

  adjustProductDescriptionLength(products: Product[]): Product[] {
    return products.map(product => ({
      ...product,
      description:
        product.description?.slice(0, this.MAX_PRODUCT_DESCRIPTION_LENGTH) ??
        '',
    }));
  }

  generateStoryboard() {
    const id = this.route.snapshot.paramMap.get('id');

    if (this.creationMode() === 'ai') {
      this.dialog
        .open(GenerateStoryboardDialog, {
          width: '1000px',
          maxWidth: '95vw',
          data: {
            aspectRatio: this.config.projectConfig.value().aspectRatio,
            products: this.adjustProductDescriptionLength(
              this.config.projectConfig.value().inputConfig.products,
            ),
            briefing: this.getCombinedBriefing(),
          },
        })
        .afterClosed()
        .subscribe((result: GeneratedScene[] | undefined) => {
          if (result) {
            this.config.updateProjectConfig({storyboard: [...result]});
            for (const scene of result) {
              void this.remixEngineService.generateCandidates(scene, {
                durationSeconds:
                  this.config.projectConfig.value().candidateDurationSeconds,
                generateAudio: this.config.projectConfig.value().generateAudio,
                model: this.config.projectConfig.value().model,
                resolution: this.config.projectConfig.value().resolution,
              });
            }
            void this.router.navigate([id, 'storyboard']);
          }
        });
    } else {
      void this.router.navigate([id, 'storyboard']);
    }
  }

  deleteProject() {
    const dialogRef = this.dialog.open(ConfirmProjectDeleteDialog);
    dialogRef.afterClosed().subscribe(result => {
      if (result) {
        void this.config.deleteProject(this.config.projectConfig.value().id);
        void this.router.navigate(['/']);
      }
    });
  }
}
